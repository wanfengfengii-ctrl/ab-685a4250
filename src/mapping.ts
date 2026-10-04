import type { AliasEngine } from './crypto.js';
import type { CreateManifestRequest, SharedManifest } from './types.js';

/**
 * Transform a validated request into its shareable pseudonymous copy.
 *
 *  - every recordId becomes a stable REC- alias,
 *  - every patientId becomes a stable PAT- alias,
 *  - every accessionId becomes a stable ACC- alias,
 *  - every relatedId is resolved through the SAME record category, so cross
 *    references always point at the corresponding record alias (closure is
 *    guaranteed by validation),
 *  - measurements are carried through untouched.
 */
export function buildSharedManifest(request: CreateManifestRequest, aliases: AliasEngine): SharedManifest {
  return {
    batchId: request.batchId,
    records: request.records.map((record) => ({
      recordAlias: aliases.alias('record', record.recordId),
      patientAlias: aliases.alias('patient', record.patientId),
      accessionAlias: aliases.alias('accession', record.accessionId),
      relatedAliases: record.relatedIds.map((relatedId) => aliases.alias('record', relatedId)),
      measurements: record.measurements,
    })),
  };
}
