import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AliasEngine } from '../src/crypto.js';

const SECRET = 'test-deployment-secret';

test('same identifier in same category maps to a stable alias across engines', () => {
  const a = new AliasEngine(SECRET);
  const b = new AliasEngine(SECRET);
  assert.equal(a.alias('patient', 'P-0001'), b.alias('patient', 'P-0001'));
  assert.equal(a.alias('record', 'MR-77'), a.alias('record', 'MR-77'));
});

test('different identifiers map to different aliases', () => {
  const a = new AliasEngine(SECRET);
  assert.notEqual(a.alias('patient', 'P-0001'), a.alias('patient', 'P-0002'));
  assert.notEqual(a.alias('accession', 'A-1'), a.alias('accession', 'A-2'));
});

test('identifier categories are isolated even for identical raw values', () => {
  const a = new AliasEngine(SECRET);
  const raw = 'SAME-VALUE-42';
  const patient = a.alias('patient', raw);
  const accession = a.alias('accession', raw);
  const record = a.alias('record', raw);
  assert.notEqual(patient, accession);
  assert.notEqual(patient, record);
  assert.notEqual(accession, record);
  assert.match(patient, /^PAT-/);
  assert.match(accession, /^ACC-/);
  assert.match(record, /^REC-/);
});

test('aliases do not reveal the raw identifier', () => {
  const a = new AliasEngine(SECRET);
  const raw = 'SECRETPATIENT90210';
  const alias = a.alias('patient', raw);
  assert.ok(!alias.includes(raw));
  assert.ok(!alias.toLowerCase().includes(raw.toLowerCase()));
});

test('engines with different secrets produce different aliases', () => {
  const a = new AliasEngine('secret-one');
  const b = new AliasEngine('secret-two');
  assert.notEqual(a.alias('patient', 'P-1'), b.alias('patient', 'P-1'));
});

test('content digest is keyed and stable for equal content', () => {
  const a = new AliasEngine(SECRET);
  const b = new AliasEngine(SECRET);
  assert.equal(a.contentDigest('canonical-1'), b.contentDigest('canonical-1'));
  assert.notEqual(a.contentDigest('canonical-1'), a.contentDigest('canonical-2'));
  assert.notEqual(a.contentDigest('canonical-1'), new AliasEngine('other').contentDigest('canonical-1'));
});
