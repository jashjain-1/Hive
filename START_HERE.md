# START HERE: Hivemind Context MCP Backend

Welcome to the **Hivemind Context Engine** repository.

This project is a high-performance, token-efficient Model Context Protocol (MCP) server that provides AI coding agents with hierarchical context trees, fine-grained AST chunking, task-aware file/chunk prioritization, explainable context selection, and persistent graph caching.

---

## 1. Quick Project Summary

- **Primary Goal**: Maximize useful work per token; stop agents from wasting 80% of their context window on irrelevant files and whole-file dumping.
- **Hosted Public Product**: **100% Free Cloud Deployment** on Render Free Tier via Docker (`render.yaml`).
- **Engine Protocol**: Model Context Protocol (MCP) over **Server-Sent Events (SSE)** (for public cloud hosting) and **Stdio** (for local CLI).
- **Scale**: **No Repository Size Cap** — streams files sequentially with batch SQLite commits, effortlessly indexing giant monorepos and multi-gigabyte codebases.
- **Storage**: Isolated SQLite WAL database per tenant (`.hive/tenants/<tenantId>.db`) for zero cross-tenant leakage.
- **Intelligence**: WebAssembly Tree-sitter AST chunker (functions/classes) + Local ONNX vector embeddings (`@xenova/transformers`, zero API key required) + SQLite FTS5 BM25.
- **Security**: Ephemeral GitHub tokens held strictly in-memory during indexing, rate-limiting, and Helmet security headers.

---

## 2. One-Click Free Cloud Deployment (Render)

Deploy your own live, public Hivemind MCP server for **$0.00/month** (no credit card required):

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jashjain-1/Hive)

1. Click the button above (or create a Web Service in [render.com](https://render.com) pointing to `https://github.com/jashjain-1/Hive`).
2. Select the **Free Instance Type**.
3. Render will build the Docker container and give you a live HTTPS URL:
   `https://hivemind-mcp.onrender.com`

---

## 3. How Anyone Can Connect Their AI Agent (Zero Installation)

Once deployed, **anyone in the world** can plug Hivemind into their AI agent with zero local Node.js installation:

| AI Agent | How to Connect |
|---|---|
| **Claude Desktop** | Add to `claude_desktop_config.json`: <br>```json<br>{"mcpServers": {"hivemind": {"url": "https://hivemind-mcp.onrender.com/sse?tenantId=my-project"}}}<br>``` |
| **Cursor IDE** | Add to `.cursor/mcp.json` or Settings -> MCP: <br>Type: `SSE`, URL: `https://hivemind-mcp.onrender.com/sse?tenantId=my-project` |
| **Antigravity / Windsurf** | Add as a remote MCP SSE server using `https://hivemind-mcp.onrender.com/sse?tenantId=my-project` |
| **Cline / Roo Code** | Select "Add New MCP Server" -> SSE Transport -> Enter your live Render URL |
| **Local Stdio (Offline)** | Run `node packages/mcp/dist/index.js` over standard stdio |

---

## 4. Hardened Multi-Tenant Security & No Size Cap

1. **Per-Tenant SQLite Isolation**: Every project/tenant gets an isolated database in `.hive/tenants/<tenantId>.db`. Cross-tenant data leaks are physically impossible.
2. **Ephemeral GitHub Tokens**: When indexing private repositories, tokens passed via `X-GitHub-Token` are held strictly in volatile RAM and immediately wiped.
3. **No Repository Size Cap**: The streaming AST engine processes files sequentially in batches of 500 chunks, purging AST tree memory immediately to prevent out-of-memory crashes on giant codebases.
4. **DDoS & Rate Limiting**: Built-in 60 req/min rate limiter and Helmet security headers.

---

## 5. Monorepo Architecture & Team Ownership

The project is structured as an npm/pnpm workspace with 3 core packages:

```
Hive/
├── packages/
│   ├── types/          # SHARED: TypeScript interfaces, DTOs, and RPC schemas
│   ├── core/           # KOMAL: Storage (SQLite WAL), Tree-sitter AST chunker, Merkle engine
│   ├── pack/           # ANJALI: Task-Aware ranker, Knapsack compiler, Explainable selection
│   └── mcp/            # JASH: Protocol server, Stdio & SSE transport, 9 tools, Window P0-P4
├── .hive/
│   ├── overrides.json  # Context pins (force_include / force_exclude)
│   ├── tenants/        # Multi-tenant isolated SQLite WAL databases (git-ignored)
│   └── sessions/       # Shared AI session logs (commit with every push)
├── Dockerfile          # Production hardened container for Render
├── render.yaml         # 1-Click Render blueprint
└── scripts/
    ├── ai-session-logger.js    # Pre-push git verification hook
    └── test-e2e-simulation.ts  # End-to-end multi-agent test simulation
```

### Team Responsibilities & AI Directives:
1. **Jash (Project Lead / MCP Protocol & Cloud)**:
   - Owns `packages/mcp`, `packages/types`, Docker, Render deployment, and `scripts/`.
   - Master AI prompt: [docs/prompts/jash.md](docs/prompts/jash.md)
2. **Anjali (Context & Intelligence Specialist)**:
   - Owns `packages/pack`.
   - Task-Aware Prioritization, Local Embeddings (`@xenova/transformers`), Knapsack Pack algorithm, Explainable Context Selection.
   - Master AI prompt: [docs/prompts/anjali.md](docs/prompts/anjali.md)
   - GitHub: [github.com/Anjali-Furia](https://github.com/Anjali-Furia)
3. **Komal (Data Engine & AST Specialist)**:
   - Owns `packages/core`.
   - SQLite WAL database, Tree-sitter WASM chunker (TS/JS/Python), Merkle hash tree, Change invalidation DAG, `.hive/graph.json` auto-sync.
   - Master AI prompt: [docs/prompts/komal.md](docs/prompts/komal.md)
   - GitHub: [github.com/KomalMangutkar](https://github.com/KomalMangutkar)
4. **Synthesis Integrator (Final Merge)**:
   - Automated 3-way branch convergence protocol: [docs/prompts/final-merge.md](docs/prompts/final-merge.md)

---

## 6. Development & Testing Commands

```bash
# 1. Install all dependencies across the monorepo
npm install

# 2. Build all packages
npm run build

# 3. Run individual package test suites (for independent AI testing)
npm test -w @hivemind/core    # Tested by Komal
npm test -w @hivemind/pack    # Tested by Anjali
npm test -w @hivemind/mcp     # Tested by Jash

# 4. Run End-to-End Multi-Agent Simulation
node scripts/test-e2e-simulation.ts

# 5. Start Hosted MCP SSE Server Locally
npm run start:sse -w @hivemind/mcp
```
