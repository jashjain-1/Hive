# ==============================================================================
# Hivemind Context Engine — Hardened Multi-Stage Dockerfile for Render Free Tier
# ==============================================================================

# --- Stage 1: Build stage ---
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native bindings
RUN apk add --no-cache python3 make g++ git

# Copy root workspace configs and the lockfile for a reproducible install
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/types/package.json packages/types/
COPY packages/core/package.json packages/core/
COPY packages/pack/package.json packages/pack/
COPY packages/mcp/package.json packages/mcp/

# Install dependencies across all workspaces
RUN npm ci

# Copy source trees
COPY packages/ packages/

# Build all TypeScript packages in dependency order
RUN npm run build

# --- Stage 2: Production runtime image ---
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV MODEL_CACHE_DIR=/home/node/.cache/huggingface/hub

# git is required at runtime for the index tool and POST /index-repo (the
# runner stage starts from a clean base image, so builder packages do not carry
# over).
RUN apk add --no-cache git

# Copy built artifacts and runtime packages
COPY --chown=node:node --from=builder /app/package.json /app/package.json
COPY --chown=node:node --from=builder /app/packages/ /app/packages/
COPY --chown=node:node --from=builder /app/node_modules/ /app/node_modules/
COPY --chown=node:node --from=builder /app/tsconfig.base.json /app/tsconfig.base.json

# Data and model-cache directories must be writable by the non-root runtime
# user. Create them as root, chown, then drop privileges.
RUN mkdir -p /app/.hive/tenants /home/node/.cache/huggingface/hub \
    && chown -R node:node /app/.hive /home/node/.cache

# Pre-download the ONNX embedding model (bge-small-en-v1.5 quantized) during
# the build so a Render cold start does not pay the download on every wake.
# The model is ~23 MB; a failed download is non-fatal because ranking falls
# back to lexical scoring without the ONNX runtime.
RUN su -s /bin/sh node -c "cd /app && node -e \"const { pipeline, env } = require('@xenova/transformers'); if (process.env.MODEL_CACHE_DIR) env.cacheDir = process.env.MODEL_CACHE_DIR; pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { quantized: true }).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); })\"" \
    || echo 'WARNING: model pre-download failed -- the server will use lexical ranking or download on first request'

USER node

# NOTE ON FREE TIER PERSISTENCE (see README for full discussion):
# Render free tier containers are ephemeral — /app/.hive/tenants and the model
# cache survive only within one container lifecycle. On sleep/wake or restart,
# tenant DBs and clones are lost. For durable hosting, attach a Render Disk and
# set HIVE_DATA_ROOT to the mounted volume path.
LABEL description="Hivemind Context Engine — ephemeral-per-lifecycle on Render free tier"

EXPOSE 3000

# Start Hosted MCP gateway (Streamable HTTP + legacy SSE + graph UI)
CMD ["node", "packages/mcp/dist/sse-server.js"]
