import type {
  CreateManifestRequest,
  ManifestRecordInput,
  Measurements,
  ValidationIssue,
} from './types.js';

/**
 * Strict structural validation for a create-manifest request.
 *
 * Every rejection is reported as a machine-readable issue containing only a
 * code, a field path and (for record fields) an index. Raw identifier VALUES
 * are never placed into issues, errors or logs.
 */
export function validateRequest(body: unknown): { ok: true; value: CreateManifestRequest } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    issues.push({ code: 'invalid_structure', field: '$' });
    return { ok: false, issues };
  }
  const root = body as Record<string, unknown>;
  const allowedRoot = new Set(['batchId', 'records']);
  for (const key of Object.keys(root)) {
    if (!allowedRoot.has(key)) issues.push({ code: 'unknown_field', field: key });
  }

  const batchId = root['batchId'];
  if (typeof batchId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(batchId)) {
    issues.push({ code: 'invalid_batch_id', field: 'batchId' });
  }

  if (!Array.isArray(root['records'])) {
    issues.push({ code: 'invalid_records', field: 'records' });
    return { ok: false, issues };
  }
  if (root['records'].length === 0) {
    issues.push({ code: 'empty_records', field: 'records' });
  }

  const records = root['records'];
  const seenRecordIds = new Set<string>();
  // Collect raw record ids / related id pairs for the closure check without
  // copying values into error messages.
  const relatedRefs: Array<{ recordIndex: number; refIndex: number; target: string }> = [];

  records.forEach((rawRecord, i) => {
    const field = `records[${i}]`;
    if (typeof rawRecord !== 'object' || rawRecord === null || Array.isArray(rawRecord)) {
      issues.push({ code: 'invalid_record', field });
      return;
    }
    const record = rawRecord as Record<string, unknown>;
    const allowedRecord = new Set(['recordId', 'patientId', 'accessionId', 'relatedIds', 'measurements']);
    for (const key of Object.keys(record)) {
      if (!allowedRecord.has(key)) issues.push({ code: 'unknown_field', field: `${field}.${key}`, index: i });
    }

    const recordId = checkId(record['recordId'], `${field}.recordId`, i, issues);
    const patientId = checkId(record['patientId'], `${field}.patientId`, i, issues);
    const accessionId = checkId(record['accessionId'], `${field}.accessionId`, i, issues);

    if (recordId !== undefined) {
      if (seenRecordIds.has(recordId)) {
        issues.push({ code: 'duplicate_record_id', field: `${field}.recordId`, index: i });
      } else {
        seenRecordIds.add(recordId);
      }
    }

    const relatedIds = record['relatedIds'];
    if (!Array.isArray(relatedIds)) {
      issues.push({ code: 'invalid_related_ids', field: `${field}.relatedIds`, index: i });
    } else {
      const seenRefs = new Set<string>();
      relatedIds.forEach((ref, j) => {
        const refField = `${field}.relatedIds[${j}]`;
        const refId = checkId(ref, refField, i, issues);
        if (refId !== undefined) {
          if (seenRefs.has(refId)) {
            issues.push({ code: 'duplicate_related_id', field: refField, index: i });
          } else {
            seenRefs.add(refId);
            relatedRefs.push({ recordIndex: i, refIndex: j, target: refId });
          }
        }
      });
    }

    if (!isPlainMeasurements(record['measurements'])) {
      issues.push({ code: 'invalid_measurements', field: `${field}.measurements`, index: i });
    }

    // Touch the checked values so TypeScript keeps the intent explicit; they
    // are never rendered anywhere.
    void patientId;
    void accessionId;
  });

  // Closure: every cross reference must target a record present in the batch.
  for (const ref of relatedRefs) {
    if (!seenRecordIds.has(ref.target)) {
      issues.push({
        code: 'dangling_reference',
        field: `records[${ref.recordIndex}].relatedIds[${ref.refIndex}]`,
        index: ref.recordIndex,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  // All checks passed; the object now satisfies the request shape.
  const value: CreateManifestRequest = {
    batchId: batchId as string,
    records: records as ManifestRecordInput[],
  };
  return { ok: true, value };
}

function checkId(value: unknown, field: string, index: number, issues: ValidationIssue[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push({ code: 'invalid_identifier', field, index });
    return undefined;
  }
  return value;
}

function isPlainMeasurements(value: unknown): value is Measurements {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return isJsonValue(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  // JSON.parse can never produce NaN/Infinity, but reject non-finite numbers
  // explicitly so any future non-HTTP caller can never poison persisted JSON.
  if (t === 'number') return Number.isFinite(value);
  if (t !== 'object') return false;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

/**
 * Deterministic serialization of the *business content* of a validated
 * request (batchId excluded: it is the routing key, not the content).
 * Records are treated as a set keyed by recordId, so record ordering does not
 * affect idempotency; measurements object keys are sorted; the order of a
 * record's relatedIds list is preserved as meaningful content.
 */
export function canonicalContent(records: ManifestRecordInput[]): string {
  const sorted = [...records].sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
  return stableStringify(sorted.map((r) => ({
    recordId: r.recordId,
    patientId: r.patientId,
    accessionId: r.accessionId,
    relatedIds: r.relatedIds,
    measurements: r.measurements,
  })));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
