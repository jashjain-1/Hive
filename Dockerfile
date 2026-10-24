# ==============================================================================
# Hivemind Context Engine — Hardened Multi-Stage Dockerfile for Render Free Tier
# ==============================================================================

# --- Stage 1: Build stage ---
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native bindings
RUN apk add --no-cache python3 make g++ git

# Copy root workspace configs
COPY package.json tsconfig.base.json ./
COPY packages/types/package.json packages/types/
COPY packages/core/package.json packages/core/
COPY packages/pack/package.json packages/pack/
COPY packages/mcp/package.json packages/mcp/

# Install dependencies across all workspaces
RUN npm install

# Copy source trees
COPY packages/ packages/

# Build all TypeScript packages
RUN npm run build --workspaces --if-present

# --- Stage 2: Production runtime image ---
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Security: Run as non-root user
USER node

# Copy built artifacts and runtime packages
COPY --chown=node:node --from=builder /app/package.json /app/package.json
COPY --chown=node:node --from=builder /app/packages/ /app/packages/
COPY --chown=node:node --from=builder /app/node_modules/ /app/node_modules/
COPY --chown=node:node --from=builder /app/tsconfig.base.json /app/tsconfig.base.json

# Pre-download the ONNX embedding model (bge-small-en-v1.5 quantized) during build
# so the cold-start on Render free tier does not pay the download on every wake.
# Model is ~23 MB quantized; cached under the node user's huggingface cache dir.
# NOTE: sharp (transitive of express-rate-limit or helmet in some trees) is a no-op in
# this image — the server does not use image processing. If the builder stage installed it
# for native bindings, the runner only needs the JS layer. We intentionally do NOT re-run
# npm install here; we reuse builder's node_modules verbatim.
RUN mkdir -p /home/node/.cache/huggingface/hub && \
    chown -R node:node /home/node/.cache && \
    su -s /bin/sh node -c "cd /app && node -e \"const { pipeline } = require('@xenova/transformers'); pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { quantized: true }).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); })\"" || echo 'WARNING: model pre-download failed -- server will download on first request'

# Create isolated directory for tenant databases
RUN mkdir -p /app/.hive/tenants

# NOTE ON FREE TIER PERSISTENCE (see README for full discussion):
# Render free tier containers are ephemeral — /app/.hive/tenants and the model cache
# survive only within one container lifecycle. On sleep/wake or restart, tenant DBs are lost
# and the model cache is lost, reverting to a first-request download.
# For durable multi-session hosting, attach a Render Disk (paid) or switch the storage
# layer to an external PostgreSQL. For demo/alpha use, re-indexing on cold start is acceptable.
LABEL description="Hivemind Context Engine — ephemeral-per-lifecycle on Render free tier"

EXPOSE 3000

# Start Hosted MCP SSE Server
CMD ["node", "packages/mcp/dist/sse-server.js"]
