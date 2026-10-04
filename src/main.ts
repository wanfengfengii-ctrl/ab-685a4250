import { loadConfig } from './config.js';
import { AliasEngine } from './crypto.js';
import { loadOrCreateSecret, ManifestStore } from './store.js';
import { createApp } from './server.js';
import { log } from './logger.js';

function main(): void {
  const config = loadConfig();
  const secret = loadOrCreateSecret(config.dataDir, config.aliasSecret);
  const aliases = new AliasEngine(secret);
  const store = new ManifestStore(config.dataDir);
  const server = createApp({ store, aliases, maxBodyBytes: config.maxBodyBytes });

  server.listen(config.port, () => {
    log.info('server_listening', { port: config.port });
  });

  const shutdown = (signal: string): void => {
    log.info('shutdown', { signal });
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
