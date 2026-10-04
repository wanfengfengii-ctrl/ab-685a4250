# Vendored build toolchain

This directory contains the **only** development dependencies, committed to
the repository so that:

- the Docker image builds with **no npm registry access** (`npm install` is
  never invoked inside the image);
- local development works without installing anything.

The application runtime itself has **zero** npm dependencies (Node 22
built-ins only).

Contents:

- `node_modules/typescript` — classic pure-JavaScript compiler (`tsc`)
- `node_modules/@types/node` — Node type definitions
- `node_modules/undici-types` — dependency of `@types/node`

## Regenerate (requires registry access)

```sh
npm_config_cache=/tmp/npmcache npm install --no-audit --no-fund
```

After installing, language-server-only artifacts (`typescript.js`,
`_tsserver.js`) may be removed to keep the tree small; the build only uses
`bin/tsc` -> `lib/_tsc.js`.
