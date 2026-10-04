import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';
import type { AliasEngine } from './crypto.js';
import type { ManifestStore } from './store.js';
import { validateRequest, canonicalContent } from './validation.js';
import { buildSharedManifest } from './mapping.js';
import { log } from './logger.js';
import type { SharedManifest, ValidationIssue } from './types.js';

/**
 * HTTP application. The only data path into the alias engine is a request
 * that has passed strict validation; the only data ever serialized back is a
 * SharedManifest, which by construction contains no raw identifiers.
 */
export interface AppDeps {
  store: ManifestStore;
  aliases: AliasEngine;
  maxBodyBytes: number;
}

export function createApp(deps: AppDeps): HttpServer {
  return createServer((req, res) => {
    void handle(req, res, deps);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? '';

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    const manifestMatch = /^\/api\/manifests\/([^/]+)$/.exec(path);

    if (method === 'POST' && path === '/api/manifests') {
      await createManifest(req, res, deps);
      return;
    }
    if (method === 'GET' && manifestMatch) {
      let batchId: string;
      try {
        batchId = decodeURIComponent(manifestMatch[1] ?? '');
      } catch {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      getManifest(res, deps, batchId);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    // Deliberately generic: never leak parser/runtime text that might quote
    // request content. Only structural error codes are logged.
    log.error('unhandled_error', { code: (err as NodeJS.ErrnoException)?.code ?? 'unknown' });
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
  }
}

async function createManifest(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const bodyResult = await readBody(req, deps.maxBodyBytes);
  if (bodyResult.status === 'too_large') {
    sendJson(res, 413, { error: 'payload_too_large', maxBodyBytes: deps.maxBodyBytes });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyResult.body);
  } catch {
    // The native parser error message can quote fragments of the body, which
    // may contain raw identifiers: it is deliberately discarded.
    const issues: ValidationIssue[] = [{ code: 'invalid_json', field: '$' }];
    sendJson(res, 422, { error: 'validation_failed', issues });
    return;
  }

  const result = validateRequest(parsed);
  if (!result.ok) {
    sendJson(res, 422, { error: 'validation_failed', issues: result.issues });
    return;
  }

  const contentHash = deps.aliases.contentDigest(canonicalContent(result.value.records));
  const manifest = buildSharedManifest(result.value, deps.aliases);
  const outcome = deps.store.create(result.value.batchId, contentHash, manifest);

  if (outcome.outcome === 'conflict') {
    log.warn('batch_conflict', { batchId: result.value.batchId });
    sendJson(res, 409, { error: 'batch_conflict', batchId: result.value.batchId });
    return;
  }

  // Both first acceptance and identical retry return the SAME status and the
  // SAME body (idempotent acceptance semantics).
  log.info('manifest_accepted', { batchId: outcome.manifest.batchId, records: outcome.manifest.records.length, replayed: outcome.outcome === 'replayed' });
  sendJson(res, 200, outcome.manifest);
}

function getManifest(res: ServerResponse, deps: AppDeps, batchId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(batchId)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const manifest: SharedManifest | undefined = deps.store.get(batchId);
  if (manifest === undefined) {
    sendJson(res, 404, { error: 'manifest_not_found', batchId });
    return;
  }
  sendJson(res, 200, manifest);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<{ status: 'ok'; body: string } | { status: 'too_large' }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return; // already over the limit: keep draining, retain nothing
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        // Drop everything retained so far (raw identifiers must not linger in
        // this request's buffers), then keep draining the socket so the
        // response we are about to send actually reaches the client. Destroying
        // the request here would tear down the TCP connection and swallow the
        // 413 response.
        chunks.length = 0;
        req.resume();
        resolve({ status: 'too_large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve({ status: 'ok', body: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}
