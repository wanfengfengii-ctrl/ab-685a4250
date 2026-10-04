# syntax=docker/dockerfile:1
#
# Pathology cross-institution manifest sharing service.
#
# The image builds fully offline: the only build toolchain (TypeScript +
# @types/node) is vendored under tools/node_modules, and the runtime has zero
# npm dependencies (Node.js built-ins only).

FROM node:22-bookworm-slim

WORKDIR /app

# Vendored build toolchain first: it changes rarely and fattens the layer, so
# copying it early improves caching for source-only changes.
COPY tools/package.json ./tools/package.json
COPY tools/node_modules ./tools/node_modules

# Application sources, tests and scripts.
COPY package.json tsconfig.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts

# Strict type-check + emit. The build fails the image build on any type error.
RUN node tools/node_modules/typescript/bin/tsc -p tsconfig.json

# Persistent data directory (alias secret + accepted shared manifests).
# Owned by the unprivileged "node" user shipped with the base image.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production \
    PORT=3000 \
    MANIFEST_DATA_DIR=/data \
    MAX_BODY_BYTES=5242880

EXPOSE 3000
VOLUME ["/data"]

# Container-level health check: exercises the same HTTP endpoint used by the
# one-shot "verify" service gate.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main.js"]
