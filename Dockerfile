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

# Create isolated directory for tenant databases
RUN mkdir -p /app/.hive/tenants

EXPOSE 3000

# Start Hosted MCP SSE Server
CMD ["node", "packages/mcp/dist/sse-server.js"]
