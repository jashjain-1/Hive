# START HERE: Hivemind Context MCP Backend

Welcome to the **Hivemind Context Engine** repository.

This project is a high-performance, token-efficient Model Context Protocol (MCP) server that provides AI coding agents with hierarchical context trees, fine-grained AST chunking, task-aware file/chunk prioritization, explainable context selection, and persistent graph caching.

---

## 1. Quick Project Summary

- **Primary Goal**: Maximize useful work per token; stop agents from wasting 80% of their context window on irrelevant files and whole-file dumping.
- **Engine Protocol**: Model Context Protocol (MCP) over `stdio` transport (native) or optional SSE/HTTP.
- **Runtime**: Node.js (v20+ LTS recommended) + TypeScript.
- **Storage**: SQLite in WAL mode (`better-sqlite3`) for sub-millisecond retrieval + `.hive/graph.json` human/agent-readable snapshot.
- **Intelligence**: WebAssembly Tree-sitter AST chunker (functions/classes) + Local ONNX vector embeddings (`@xenova/transformers`, zero API key required) + SQLite FTS5 BM25.
- **Priority**: **100% Backend Engine**. No frontend/UI focus.

---

## 2. How the MCP Server is Hosted & Host Compatibility

The server operates over **standard I/O (`stdio`)**. Any AI agent client supporting MCP connects out of the box with zero port or networking configuration:

| Host / AI Agent | Supported? | How It Connects |
|---|---|---|
| **Claude Desktop** | ✅ Yes | Add to `claude_desktop_config.json` under `mcpServers` pointing to `node packages/mcp/dist/index.js` |
| **Cursor IDE** | ✅ Yes | Add to `.cursor/mcp.json` or Cursor MCP settings pointing to `node packages/mcp/dist/index.js` |
| **Antigravity / Windsurf** | ✅ Yes | Direct MCP stdio command `node packages/mcp/dist/index.js` |
| **Cline / Roo Code** | ✅ Yes | Configured via extension settings under standard MCP stdio |
| **Remote Agents (LangChain, AutoGen, Docker)** | ✅ Yes | Start via `node packages/mcp/dist/index.js --transport sse --port 3001` |

---

## 3. Toolchain & Prerequisites

Make sure the following are installed on your machine:
- **Node.js**: `v20.x` or higher (`node -v`)
- **Package Manager**: `npm` (v10+) or `pnpm` (`npm -v` / `pnpm -v`)
- **Git**: Installed and configured (`git --version`)
- **OS**: Windows / Linux / macOS (all native extensions use prebuilt binaries or WASM to avoid C++ compiler requirements on Windows).

---

## 4. Monorepo Architecture & Team Ownership

The project is structured as an npm/pnpm workspace with 3 core packages:

```
Hive/
├── packages/
│   ├── types/          # SHARED: TypeScript interfaces, DTOs, and RPC schemas
│   ├── core/           # KOMAL: Storage (SQLite WAL), Tree-sitter AST chunker, Merkle engine
│   ├── pack/           # ANJALI: Task-Aware ranker, Knapsack compiler, Explainable selection
│   └── mcp/            # JASH: Protocol server, Stdio transport, 9 tools, Window P0-P4
├── .hive/
│   ├── graph.json      # Human/Agent-readable graph snapshot
│   ├── overrides.json  # Context pins (force_include / force_exclude)
│   └── sessions/       # Shared AI session logs (commit with every push)
└── scripts/
    ├── ai-session-logger.js    # Pre-push git verification hook
    └── test-e2e-simulation.ts  # End-to-end multi-agent test simulation
```

### Team Responsibilities & AI Directives:
1. **Jash (Project Lead / MCP Protocol)**:
   - Owns `packages/mcp`, `packages/types`, and `scripts/`.
   - MCP Server Stdio transport, 9 tools, Window protocol (P0–P4), Prompt caching, Epoch compaction.
   - Master AI prompt: [docs/prompts/jash.md](docs/prompts/jash.md)
2. **Anjali (Context & Intelligence Specialist)**:
   - Owns `packages/pack`.
   - Task-Aware File & Chunk Prioritization, Local Embeddings (`@xenova/transformers`), Knapsack Pack algorithm, Explainable Context Selection (1-line reasons), Overrides engine.
   - Master AI prompt: [docs/prompts/anjali.md](docs/prompts/anjali.md)
   - GitHub: [github.com/Anjali-Furia](https://github.com/Anjali-Furia)
3. **Komal (Data Engine & AST Specialist)**:
   - Owns `packages/core`.
   - SQLite WAL database (`better-sqlite3`), Tree-sitter WASM chunker (functions/classes for TS/JS/Python), Merkle hash tree, Change invalidation DAG, `.hive/graph.json` auto-sync.
   - Master AI prompt: [docs/prompts/komal.md](docs/prompts/komal.md)
   - GitHub: [github.com/KomalMangutkar](https://github.com/KomalMangutkar)
4. **Synthesis Integrator (Final Merge)**:
   - Automated 3-way branch convergence protocol: [docs/prompts/final-merge.md](docs/prompts/final-merge.md)

---

## 5. Safe Git Protocol (Zero Conflicts)

### 5.1 Branching Strategy
Never commit directly to `main`. Every team member works in their designated branch:
- Komal: `git checkout -b feat/komal-ingest-ast`
- Anjali: `git checkout -b feat/anjali-pack-ranker`
- Jash: `git checkout -b feat/jash-mcp-protocol`

### 5.2 Shared AI Session Log Protocol
Whenever you work with an AI assistant (Antigravity, Claude, Cursor, Windsurf), you MUST update or create an AI session log in `.hive/sessions/` before pushing:

**File format**: `.hive/sessions/YYYYMMDD-<author>-<session-name>.md`  
*(e.g., `.hive/sessions/20261023-komal-tree-sitter-chunker.md`)*

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
node --loader tsx scripts/test-e2e-simulation.ts

# 5. Launch MCP Inspector to test tools interactively
npm run inspector
```
