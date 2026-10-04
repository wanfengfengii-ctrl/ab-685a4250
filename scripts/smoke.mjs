#!/usr/bin/env node
/**
 * Submit/query smoke test run by the one-shot `verify` service after the API
 * has reported healthy. It exercises the externally visible contract:
 *
 *   1. valid manifests across two batches get closed, fully aliased copies;
 *   2. aliases for the same identifiers are consistent across batches;
 *   3. an identical retry (even with reordered records) returns the original;
 *   4. different content for the same batchId is blocked with 409;
 *   5. duplicate record ids / dangling refs / bad shapes are blocked with 422;
 *   6. GET returns exactly what POST accepted;
 *   7. NO raw identifier sentinel appears in ANY response.
 *
 * Exits non-zero (with a count of failures) if any check fails.
 */

const BASE_URL = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`;

// Sentinels: deliberately distinctive values that must never be echoed.
const RAW = {
  patient: 'RAW-PAT-SMOKE-700111',
  accession: 'RAW-ACC-SMOKE-700222',
  record: 'RAW-REC-SMOKE-700333',
  other: 'RAW-REC-SMOKE-700444',
};
const SENTINELS = Object.values(RAW);

let failures = 0;
const observedResponses = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function sweep(name, text) {
  for (const sentinel of SENTINELS) {
    if (text.includes(sentinel)) {
      check(`no raw leak in ${name}`, false, `found ${sentinel}`);
      return false;
    }
  }
  check(`no raw leak in ${name}`, true);
  return true;
}

async function req(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  observedResponses.push({ where: `${method} ${path}`, text });
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, text, json };
}

function manifest(batchId) {
  return {
    batchId,
    records: [
      {
        recordId: RAW.record,
        patientId: RAW.patient,
        accessionId: RAW.accession,
        relatedIds: [RAW.other],
        measurements: { organ: 'kidney', gleason: '3+4', weightMg: 118.4, tags: ['core-a', null] },
      },
      {
        recordId: RAW.other,
        patientId: RAW.patient,
        accessionId: 'RAW-ACC-SMOKE-SECOND',
        relatedIds: [RAW.record],
        measurements: { note: 'paired slide' },
      },
    ],
  };
}

async function waitForHealthy(deadlineMs) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.status === 200) return true;
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`service never became healthy at ${BASE_URL}: ${lastErr?.message ?? 'timeout'}`);
}

async function main() {
  console.log(`smoke against ${BASE_URL}`);
  await waitForHealthy(30_000);
  check('health endpoint ready', true);

  // ---- two clean batches sharing identifiers -----------------------------
  const r1 = await req('POST', '/api/manifests', manifest('smoke-batch-1'));
  check('batch-1 accepted with 200', r1.status === 200, `status=${r1.status} body=${r1.text.slice(0, 200)}`);
  sweep('batch-1 POST', r1.text);

  const m1 = manifest('smoke-batch-2');
  const r2 = await req('POST', '/api/manifests', m1);
  check('batch-2 accepted with 200', r2.status === 200, `status=${r2.status} body=${r2.text.slice(0, 200)}`);
  sweep('batch-2 POST', r2.text);

  if (r1.json && r2.json) {
    const a0 = r1.json.records?.[0];
    const b0 = r2.json.records?.[0];
    check('record alias consistent across batches', a0?.recordAlias === b0?.recordAlias);
    check('patient alias consistent across batches', a0?.patientAlias === b0?.patientAlias);
    check('accession alias consistent across batches', a0?.accessionAlias === b0?.accessionAlias);
    check('cross reference resolves to referenced record alias', a0?.relatedAliases?.[0] === r1.json.records?.[1]?.recordAlias);
    check('reverse cross reference closes too', r1.json.records?.[1]?.relatedAliases?.[0] === a0?.recordAlias);
    check('measurements preserved verbatim', JSON.stringify(a0?.measurements) === JSON.stringify(m1.records[0].measurements));
    check('aliases carry category prefixes', /^REC-/.test(a0?.recordAlias) && /^PAT-/.test(a0?.patientAlias) && /^ACC-/.test(a0?.accessionAlias));
    check('categories isolated', a0?.patientAlias !== a0?.recordAlias && a0?.accessionAlias !== a0?.recordAlias);
    const rawKeys = ['recordId', 'patientId', 'accessionId', 'relatedIds'];
    check('no raw identifier field names echoed', r1.json.records.every((rec) => rawKeys.every((k) => !(k in rec))));
  }

  // ---- idempotent retry, including reordered records ----------------------
  const retrySame = await req('POST', '/api/manifests', manifest('smoke-batch-1'));
  check('identical retry returns 200', retrySame.status === 200);
  check('identical retry returns original body', retrySame.text === r1.text);

  const reordered = manifest('smoke-batch-1');
  reordered.records = [reordered.records[1], reordered.records[0]];
  const retryReordered = await req('POST', '/api/manifests', reordered);
  check('reordered retry is still the same business result', retryReordered.text === r1.text);

  // ---- conflict -----------------------------------------------------------
  const conflict = manifest('smoke-batch-1');
  conflict.records[0].measurements = { gleason: '4+5' };
  const rc = await req('POST', '/api/manifests', conflict);
  check('different content for same batchId blocked with 409', rc.status === 409, `status=${rc.status}`);
  sweep('409 response', rc.text);

  // ---- whole-batch 422 rejections -----------------------------------------
  const dup = manifest('smoke-bad-dup');
  dup.records.push({ ...dup.records[0] });
  const rd = await req('POST', '/api/manifests', dup);
  check('duplicate recordId rejected with 422', rd.status === 422 && JSON.stringify(rd.json?.issues ?? []).includes('duplicate_record_id'));
  sweep('duplicate 422 response', rd.text);

  const dangling = manifest('smoke-bad-dangling');
  dangling.records[0].relatedIds = ['RAW-REC-SMOKE-NOT-PRESENT'];
  const rn = await req('POST', '/api/manifests', dangling);
  check('dangling reference rejected with 422', rn.status === 422 && JSON.stringify(rn.json?.issues ?? []).includes('dangling_reference'));
  sweep('dangling 422 response', rn.text);

  for (const [label, bad] of [
    ['not JSON', 'this-is-not-json'],
    ['missing records', { batchId: 'x' }],
    ['bad record shape', { batchId: 'y', records: [{}] }],
  ]) {
    const rb = await req('POST', '/api/manifests', bad);
    check(`illegal structure (${label}) rejected with 422`, rb.status === 422, `status=${rb.status}`);
    sweep(`${label} response`, rb.text);
  }

  // rejected batches must not be queryable
  for (const id of ['smoke-bad-dup', 'smoke-bad-dangling']) {
    const g = await req('GET', `/api/manifests/${id}`);
    check(`rejected batch ${id} is not stored (404)`, g.status === 404);
  }

  // ---- GET returns the accepted result ------------------------------------
  const g1 = await req('GET', '/api/manifests/smoke-batch-1');
  check('GET accepted batch returns 200', g1.status === 200);
  check('GET body equals POST body', g1.text === r1.text);
  sweep('GET response', g1.text);

  const gMissing = await req('GET', '/api/manifests/does-not-exist');
  check('GET unknown batch returns 404', gMissing.status === 404);

  // ---- final sweep: every single response captured this run ---------------
  let leaks = 0;
  for (const { where, text } of observedResponses) {
    for (const sentinel of SENTINELS) {
      if (text.includes(sentinel)) { leaks += 1; console.error(`  leak in ${where}: ${sentinel}`); }
    }
  }
  check('aggregate privacy sweep of all responses', leaks === 0, `${leaks} leak(s)`);

  if (failures > 0) {
    console.error(`SMOKE FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('SMOKE OK: all submit/query contract checks passed');
}

main().catch((err) => {
  console.error('smoke harness error:', err instanceof Error ? err.message : err);
  process.exit(2);
});
