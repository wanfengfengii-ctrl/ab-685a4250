/**
 * Deployment configuration, sourced exclusively from environment variables.
 * Nothing identifier-derived is ever read from or written to configuration.
 */
export interface Config {
  /** TCP port the HTTP server listens on inside the container. */
  port: number;
  /** Directory for alias secret + accepted manifests (raw IDs never stored). */
  dataDir: string;
  /**
   * Master secret for alias HMAC. When unset, a random secret is generated on
   * first boot and persisted under dataDir, so aliases stay stable across
   * restarts of the same deployment.
   */
  aliasSecret: string | undefined;
  /** Maximum accepted request body size, in bytes. */
  maxBodyBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env.PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const maxBodyBytes = Number.parseInt(env.MAX_BODY_BYTES ?? `${5 * 1024 * 1024}`, 10);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) {
    throw new Error('MAX_BODY_BYTES must be an integer >= 1024');
  }
  const secret = env.MANIFEST_ALIAS_SECRET;
  return {
    port,
    dataDir: env.MANIFEST_DATA_DIR ?? '/data',
    aliasSecret: secret && secret.length > 0 ? secret : undefined,
    maxBodyBytes,
  };
}
