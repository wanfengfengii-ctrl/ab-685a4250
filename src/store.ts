import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { SharedManifest } from './types.js';
import { log } from './logger.js';

/**
 * Persistent storage for accepted manifests.
 *
 * Privacy contract: this module only ever writes SHAREABLE manifests
 * (aliases + original measurement values) plus an HMAC digest of the
 * canonical business content for idempotency/conflict detection. Raw
 * patient/accession/record identifiers are never written to disk. All file
 * operations are synchronous, which both removes create/create race windows
 * in this single-process service and keeps the implementation dependency
 * free; writes are atomic via temp-file + rename.
 */

interface StoredEntry {
  batchId: string;
  contentHash: string;
  manifest: SharedManifest;
}

export type CreateOutcome =
  | { outcome: 'created'; manifest: SharedManifest }
  | { outcome: 'replayed'; manifest: SharedManifest }
  | { outcome: 'conflict' };

export class ManifestStore {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(private readonly dataDir: string) {
    mkdirSync(join(dataDir, 'manifests'), { recursive: true, mode: 0o700 });
    for (const file of readdirSync(join(dataDir, 'manifests'))) {
      if (!file.endsWith('.json')) continue;
      const entry = JSON.parse(readFileSync(join(dataDir, 'manifests', file), 'utf8')) as StoredEntry;
      this.entries.set(entry.batchId, entry);
    }
  }

  get(batchId: string): SharedManifest | undefined {
    return this.entries.get(batchId)?.manifest;
  }

  create(batchId: string, contentHash: string, manifest: SharedManifest): CreateOutcome {
    const existing = this.entries.get(batchId);
    if (existing !== undefined) {
      if (existing.contentHash === contentHash) {
        return { outcome: 'replayed', manifest: existing.manifest };
      }
      return { outcome: 'conflict' };
    }

    const entry: StoredEntry = { batchId, contentHash, manifest };
    // batchId charset is enforced by validation ([A-Za-z0-9._-]{1,128}),
    // so it is safe to use as a file name.
    const finalPath = join(this.dataDir, 'manifests', `${batchId}.json`);
    const tmpPath = join(this.dataDir, 'manifests', `.${batchId}.${process.pid}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(entry), { mode: 0o600 });
    renameSync(tmpPath, finalPath);
    this.entries.set(batchId, entry);
    return { outcome: 'created', manifest };
  }
}

/**
 * Resolve the alias master secret: explicit environment value wins; otherwise
 * load a persistent random secret from dataDir (created 0600 on first boot)
 * so aliases remain stable across restarts of a deployment without anyone
 * having to provision one. The secret path/value is never logged.
 */
export function loadOrCreateSecret(dataDir: string, provided: string | undefined): string {
  if (provided !== undefined) return provided;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secretPath = join(dataDir, 'alias-secret.key');
  if (existsSync(secretPath)) {
    return readFileSync(secretPath, 'utf8');
  }
  const generated = randomBytes(32).toString('base64');
  writeFileSync(secretPath, generated, { mode: 0o600 });
  try {
    chmodSync(secretPath, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes; the create mode above
    // already requests 0600.
  }
  log.info('alias_secret_generated', { note: 'persistent random secret created on first boot' });
  return generated;
}

/** Unseeded SHA-256 helper used only for non-sensitive internal digests. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
