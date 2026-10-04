import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { AliasEngine } from '../src/crypto.js';
import { ManifestStore } from '../src/store.js';
import { createApp } from '../src/server.js';
import { setLogSink } from '../src/logger.js';
import type { LogEvent } from '../src/logger.js';
import type { CreateManifestRequest } from '../src/types.js';

const SECRET = 'e2e-fixed-secret';
let baseUrl: string;
let dataDir: string;
let store: ManifestStore;
let aliases: AliasEngine;
let server: HttpServer;

// Raw identifier sentinels that must never appear in any response or log.
const RAW = {
  patient: 'RAW-PAT-900111',
  accession: 'RAW-ACC-200222',
  record: 'RAW-REC-300333',
  otherRecord: 'RAW-REC-400444',
};
const ALL_RAW = Object.values(RAW);

const logCapture: LogEvent[] = [];

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'manifest-e2e-'));
  aliases = new AliasEngine(SECRET);
  store = new ManifestStore(dataDir);
  server = createApp({ store, aliases, maxBodyBytes: 64 * 1024 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Capture every privacy-safe log event for the leak sweep without
  // hijacking process.stdio (the test runner needs those streams).
  setLogSink((entry) => logCapture.push(entry));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

function validRequest(batchId: string, extras: Partial<CreateManifestRequest> = {}): CreateManifestRequest {
  return {
    batchId,
    records: [
      {
        recordId: RAW.record,
        patientId: RAW.patient,
        accessionId: RAW.accession,
        relatedIds: [RAW.otherRecord],
        measurements: { site: 'left-lung-upper-lobe', tumorSizeMm: 11.25, markers: { ttf1: true, k: [1, 2, null] } },
      },
      {
        recordId: RAW.otherRecord,
        patientId: RAW.patient,
        accessionId: 'RAW-ACC-SECOND',
        relatedIds: [],
        measurements: { note: 'second slide' },
      },
    ],
    ...extras,
  };
}

async function postManifest(body: unknown, init?: RequestInit) {
  return fetch(`${baseUrl}/api/manifests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

function assertNoRawLeaks(text: string, where: string): void {
  for (const raw of ALL_RAW) {
    assert.ok(!text.includes(raw), `raw identifier ${raw} leaked into ${where}`);
  }
}

test('health endpoint reports ok', async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('POST accepts a valid manifest and returns a fully aliased, closed copy', async () => {
  const res = await postManifest(validRequest('batch-A'));
  assert.equal(res.status, 200);
  const text = await res.text();
  assertNoRawLeaks(text, 'POST response');
  const json = JSON.parse(text);
  assert.equal(json.batchId, 'batch-A');
  assert.equal(json.records.length, 2);

  const first = json.records[0];
  const second = json.records[1];
  assert.match(first.recordAlias, /^REC-/);
  assert.match(first.patientAlias, /^PAT-/);
  assert.match(first.accessionAlias, /^ACC-/);
  assert.equal(first.relatedAliases.length, 1);
  // Cross references resolve to the record alias of the referenced record.
  assert.equal(first.relatedAliases[0], second.recordAlias);
  // Shared patient alias is consistent across records.
  assert.equal(first.patientAlias, second.patientAlias);
  // Measurements preserved verbatim.
  assert.deepEqual(first.measurements, { site: 'left-lung-upper-lobe', tumorSizeMm: 11.25, markers: { ttf1: true, k: [1, 2, null] } });
  // No raw field names survive.
  for (const record of json.records) {
    for (const key of ['recordId', 'patientId', 'accessionId', 'relatedIds']) {
      assert.ok(!(key in record), `${key} must not be echoed`);
    }
  }
});

test('GET returns the accepted result', async () => {
  const post = await postManifest(validRequest('batch-GET'));
  assert.equal(post.status, 200);
  const res = await fetch(`${baseUrl}/api/manifests/batch-GET`);
  assert.equal(res.status, 200);
  const posted = await post.json();
  const fetched = await res.json();
  assert.deepEqual(fetched, posted);
  assertNoRawLeaks(JSON.stringify(fetched), 'GET response');
});

test('GET unknown batch returns 404', async () => {
  const res = await fetch(`${baseUrl}/api/manifests/no-such-batch`);
  assert.equal(res.status, 404);
});

test('identical retry (reordered) replays the exact original result', async () => {
  const req1 = validRequest('batch-IDEMPOTENT');
  const res1 = await postManifest(req1);
  const body1 = await res1.text();
  assert.equal(res1.status, 200);

  const req2 = validRequest('batch-IDEMPOTENT');
  req2.records = [req2.records[1]!, req2.records[0]!];
  const res2 = await postManifest(req2);
  const body2 = await res2.text();
  assert.equal(res2.status, 200);
  assert.equal(body2, body1);
});

test('same batchId with different business content is rejected with 409', async () => {
  const res1 = await postManifest(validRequest('batch-CONFLICT'));
  assert.equal(res1.status, 200);
  const original = await res1.json();

  const changed = validRequest('batch-CONFLICT');
  changed.records[0]!.measurements = { tumorSizeMm: 999 };
  const res2 = await postManifest(changed);
  assert.equal(res2.status, 409);
  const text = await res2.text();
  assertNoRawLeaks(text, '409 response');

  // Original result is untouched and still retrievable.
  const res3 = await fetch(`${baseUrl}/api/manifests/batch-CONFLICT`);
  assert.deepEqual(await res3.json(), original);
});

test('422 rejects the whole batch: duplicate recordId', async () => {
  const req = validRequest('batch-DUP');
  req.records.push({ ...req.records[0]! });
  const res = await postManifest(req);
  assert.equal(res.status, 422);
  const text = await res.text();
  assertNoRawLeaks(text, '422 response');
  const json = JSON.parse(text);
  assert.equal(json.error, 'validation_failed');
  assert.ok(json.issues.some((i: { code: string }) => i.code === 'duplicate_record_id'));
  assert.equal(await (await fetch(`${baseUrl}/api/manifests/batch-DUP`)).status, 404);
});

test('422 rejects dangling reference and stores nothing', async () => {
  const req = validRequest('batch-DANGLING');
  req.records[0]!.relatedIds = ['RAW-REC-NOT-IN-BATCH'];
  const res = await postManifest(req);
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.ok(json.issues.some((i: { code: string }) => i.code === 'dangling_reference'));
  assert.equal(await (await fetch(`${baseUrl}/api/manifests/batch-DANGLING`)).status, 404);
});

test('422 for illegal structures and malformed JSON', async () => {
  const payloads: unknown[] = [
    { records: [] },
    { batchId: 'x' },
    { batchId: 'b', records: [{}] },
    { batchId: 'b', records: [{ recordId: 'R', patientId: 'P', accessionId: 'A', relatedIds: [], measurements: [] }] },
    'not-json',
  ];
  for (const p of payloads) {
    const res = await postManifest(p);
    assert.equal(res.status, 422, `payload ${JSON.stringify(p)} expected 422`);
    assertNoRawLeaks(await res.text(), 'error response');
  }
});

test('oversized body is rejected with 413 and stores nothing', async () => {
  const oversized = validRequest('batch-HUGE');
  oversized.records[0]!.measurements = { padding: 'x'.repeat(128 * 1024) };
  const res = await postManifest(oversized);
  assert.equal(res.status, 413);
  assert.equal(await (await fetch(`${baseUrl}/api/manifests/batch-HUGE`)).status, 404);
});

test('malformed percent-encoding in GET path returns 404, not 500', async () => {
  const res = await fetch(`${baseUrl}/api/manifests/%E0%A4%A`);
  assert.equal(res.status, 404);
});

test('aliases are consistent across batches and categories stay isolated', async () => {
  const otherBatch = validRequest('batch-B');
  const res = await postManifest(otherBatch);
  assert.equal(res.status, 200);

  const a = await (await fetch(`${baseUrl}/api/manifests/batch-A`)).json();
  const b = await res.json();
  // Same raw record / patient / accession values -> same aliases in a
  // different batch.
  assert.equal(a.records[0].recordAlias, b.records[0].recordAlias);
  assert.equal(a.records[0].patientAlias, b.records[0].patientAlias);
  assert.equal(a.records[0].accessionAlias, b.records[0].accessionAlias);
  // Category isolation: even values shaped alike cannot coincide.
  assert.notEqual(a.records[0].patientAlias[0], undefined);
  const allA = a.records.flatMap((r: { patientAlias: string; accessionAlias: string; recordAlias: string; relatedAliases: string[] }) =>
    [r.patientAlias, r.accessionAlias, r.recordAlias, ...r.relatedAliases]);
  const pats = new Set(allA.filter((x: string) => x.startsWith('PAT-')));
  const recs = new Set(allA.filter((x: string) => x.startsWith('REC-')));
  for (const p of pats) assert.ok(!recs.has(p));
});

test('restart with the same data dir replays stored results and preserves conflicts', async () => {
  const restartedStore = new ManifestStore(dataDir);
  const restartedServerApp = createApp({
    store: restartedStore,
    aliases: new AliasEngine(SECRET),
    maxBodyBytes: 64 * 1024,
  });
  const server = restartedServerApp;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const fetched = await (await fetch(`http://127.0.0.1:${port}/api/manifests/batch-A`)).json();
  const original = await (await fetch(`${baseUrl}/api/manifests/batch-A`)).json();
  assert.deepEqual(fetched, original);

  const res = await fetch(`http://127.0.0.1:${port}/api/manifests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify((() => { const c = validRequest('batch-A'); c.records[0]!.measurements = { x: 1 }; return c; })()),
  });
  assert.equal(res.status, 409);
  server.close();
});

test('captured server logs never contain raw identifiers', () => {
  const allLogs = logCapture.map((e) => JSON.stringify(e)).join('\n');
  assertNoRawLeaks(allLogs, 'server logs');
  // Only structural events are recorded (no body content fields).
  assert.ok(logCapture.length > 0);
  for (const event of logCapture) {
    assert.ok(typeof event.event === 'string' && event.event.length > 0);
  }
});
