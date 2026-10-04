import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IdCategory } from './types.js';

/**
 * Pseudonymous alias generator.
 *
 * Properties:
 *  - Deterministic: the same raw identifier within the same category always
 *    maps to the same alias, across every batch and every process restart
 *    (given the same master secret), so institutions can correlate records
 *    they are allowed to correlate.
 *  - Category isolated: the alias namespace is keyed by category, so the same
 *    raw value used as e.g. a patient number and a record number yields two
 *    different aliases, and aliases can never be cross-wired between kinds.
 *  - One-way: aliases are keyed HMAC digests of the raw identifier; the raw
 *    value cannot be recovered, and unrelated values produce unrelated
 *    unguessable aliases.
 *
 * The master secret is generated per deployment when MANIFEST_ALIAS_SECRET is
 * unset (so a fresh deployment cannot be joined with guessed identifiers), or
 * provided through the environment for stable multi-instance deployments.
 * The secret itself is only ever used as an HMAC key: it is never logged.
 */

const CATEGORY_PREFIX: Record<IdCategory, string> = {
  patient: 'PAT',
  accession: 'ACC',
  record: 'REC',
};

/** Base32hex alphabet, upper-cased; chosen for log-safe, copy/paste-safe IDs. */
const DIGEST_BYTES = 16; // 128-bit aliases

export class AliasEngine {
  private readonly secret: Buffer;
  private readonly cache = new Map<IdCategory, Map<string, string>>();

  constructor(secret?: string) {
    if (secret !== undefined && secret.length > 0) {
      this.secret = Buffer.from(secret, 'utf8');
    } else {
      this.secret = randomBytes(32);
    }
  }

  /** Map a raw identifier to its stable alias within the given category. */
  alias(category: IdCategory, rawId: string): string {
    let perCategory = this.cache.get(category);
    if (perCategory === undefined) {
      perCategory = new Map();
      this.cache.set(category, perCategory);
    }
    const hit = perCategory.get(rawId);
    if (hit !== undefined) return hit;

    // Namespace the HMAC key by category so categories can never collide and
    // can never be correlated even if raw values happen to be identical.
    const hmac = createHmac('sha256', this.secret)
      .update(`manifest-alias|${category}|`)
      .update(rawId);
    const digest = hmac.digest().subarray(0, DIGEST_BYTES);
    const alias = `${CATEGORY_PREFIX[category]}-${base32Upper(digest)}`;
    perCategory.set(rawId, alias);
    return alias;
  }

  /** Constant-time comparison used by tests / integrity checks. */
  static sameOutput(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }

  /**
   * Keyed digest of the canonical business content of a request. Used for
   * idempotency / 409-conflict detection. It is an HMAC (not a plain hash)
   * because the content contains low-entropy hospital identifiers: a plain
   * digest would let anyone with the file brute-force patient/record numbers
   * offline. Only the digest is persisted; raw content never reaches disk.
   */
  contentDigest(canonical: string): string {
    return createHmac('sha256', this.secret)
      .update('manifest-content|')
      .update(canonical)
      .digest('hex');
  }
}

function base32Upper(buf: Buffer): string {
  // RFC 4648 base32hex alphabet: 0-9 then A-V. Node's Buffer does not expose
  // this encoding, so encode by packing bits 5 at a time (no padding).
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUV';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}
