import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, canonicalContent } from '../src/validation.js';
import type { ManifestRecordInput } from '../src/types.js';

function record(overrides: Partial<ManifestRecordInput> = {}): ManifestRecordInput {
  return {
    recordId: 'R-1',
    patientId: 'P-1',
    accessionId: 'A-1',
    relatedIds: [],
    measurements: { weightMg: 12.5 },
    ...overrides,
  };
}

function body(records: ManifestRecordInput[], batchId = 'B-1') {
  return { batchId, records };
}

test('a well-formed request validates', () => {
  const result = validateRequest(body([record()]));
  assert.equal(result.ok, true);
});

test('non-object body is rejected wholesale', () => {
  for (const bad of [null, [], 'x', 42, true]) {
    const result = validateRequest(bad);
    assert.equal(result.ok, false);
  }
});

test('invalid batchId is rejected', () => {
  const result = validateRequest(body([record()], ''));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((i) => i.code === 'invalid_batch_id'));
});

test('unknown fields are rejected', () => {
  const raw = body([record()]);
  (raw as Record<string, unknown>).extra = 1;
  const result = validateRequest(raw);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((i) => i.code === 'unknown_field'));
});

test('duplicate recordId within a batch is rejected with 422-class issue', () => {
  const result = validateRequest(body([record(), record({ patientId: 'P-2' })]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((i) => i.code === 'duplicate_record_id'));
});

test('dangling cross reference is rejected', () => {
  const result = validateRequest(body([record({ relatedIds: ['R-MISSING'] })]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((i) => i.code === 'dangling_reference'));
});

test('a reference to an existing record id closes', () => {
  const result = validateRequest(body([
    record({ recordId: 'R-1', relatedIds: ['R-2'] }),
    record({ recordId: 'R-2' }),
  ]));
  assert.equal(result.ok, true);
});

test('self reference is a valid closed reference', () => {
  const result = validateRequest(body([record({ relatedIds: ['R-1'] })]));
  assert.equal(result.ok, true);
});

test('empty, non-string and non-array identifiers are rejected', () => {
  const cases = [
    record({ recordId: '' }),
    record({ recordId: '   ' }),
    record({ patientId: 7 as unknown as string }),
    record({ accessionId: null as unknown as string }),
    record({ relatedIds: 'nope' as unknown as string[] }),
    record({ relatedIds: [''] }),
  ];
  for (const c of cases) {
    const result = validateRequest(body([c]));
    assert.equal(result.ok, false);
  }
});

test('duplicate related ids inside one record are rejected', () => {
  const result = validateRequest(body([
    record({ recordId: 'R-1', relatedIds: ['R-2', 'R-2'] }),
    record({ recordId: 'R-2' }),
  ]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((i) => i.code === 'duplicate_related_id'));
});

test('non-JSON-safe measurements are rejected', () => {
  const result = validateRequest(body([record({ measurements: { weird: 1n } as unknown as Record<string, unknown> })]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((i) => i.code === 'invalid_measurements'));
});

test('empty records array is rejected', () => {
  const result = validateRequest(body([]));
  assert.equal(result.ok, false);
});

test('validation issues never embed identifier values', () => {
  const secretValue = 'PATIENT-SECRET-VALUE-XYZ';
  const result = validateRequest(body([record({ patientId: secretValue, relatedIds: ['GONE-' + secretValue] })]));
  assert.equal(result.ok, false);
  if (!result.ok) {
    const rendered = JSON.stringify(result.issues);
    assert.ok(!rendered.includes(secretValue));
  }
});

test('canonical content ignores record order but not business values', () => {
  const r1 = record({ recordId: 'R-1' });
  const r2 = record({ recordId: 'R-2' });
  assert.equal(canonicalContent([r1, r2]), canonicalContent([r2, r1]));

  const changed = record({ recordId: 'R-1', measurements: { weightMg: 99 } });
  assert.notEqual(canonicalContent([r1]), canonicalContent([changed]));
});
