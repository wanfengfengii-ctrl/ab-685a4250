/**
 * Domain types for the cross-institution pathology manifest sharing service.
 *
 * A manifest record carries three categories of institution-scoped identifier:
 *   - patientId   -> local patient number
 *   - accessionId -> local accession (specimen) number
 *   - recordId    -> local in-hospital record number
 * plus relatedIds, which are cross references to other local record numbers.
 *
 * None of the raw values above may ever leave the process untransformed:
 * they are not stored in clear text, not logged, and not echoed in responses.
 * Only stable, category-isolated pseudonymous aliases are exposed.
 */

/** Identifier categories; aliases are never reused across categories. */
export type IdCategory = 'patient' | 'accession' | 'record';

export const ID_CATEGORIES: readonly IdCategory[] = ['patient', 'accession', 'record'];

/** Free-form measurement payload attached to a record; preserved verbatim. */
export type Measurements = Record<string, unknown>;

/** A single manifest record as supplied by an institution (raw identifiers). */
export interface ManifestRecordInput {
  recordId: string;
  patientId: string;
  accessionId: string;
  relatedIds: string[];
  measurements: Measurements;
}

/** Request body for POST /api/manifests. */
export interface CreateManifestRequest {
  batchId: string;
  records: ManifestRecordInput[];
}

/** A record in the shareable copy: every identifier replaced by an alias. */
export interface SharedRecord {
  recordAlias: string;
  patientAlias: string;
  accessionAlias: string;
  relatedAliases: string[];
  measurements: Measurements;
}

/** Stored / returned result for an accepted batch. */
export interface SharedManifest {
  batchId: string;
  records: SharedRecord[];
}

/** Error detail for a 422 structural rejection (codes only, no raw values). */
export interface ValidationIssue {
  code: string;
  field?: string;
  index?: number;
}

/** Canonical serialization of the business content of a request (see store). */
export type ContentHash = string;
