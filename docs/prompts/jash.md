# Master Engineering Directive & AI Prompt: Jash (MCP Protocol, Window Layout & Root Orchestration)

> **Role**: MCP Protocol Architect & Project Lead  
> **Package Ownership**: `packages/mcp`, `packages/types`, `scripts/`  
> **Target Branch**: `feat/jash-mcp-protocol`  
> **Direct Collaborators**: Komal (`packages/core`), Anjali (`packages/pack`)  
> **Instructions for Jash**: Copy and paste the entire prompt below into your AI assistant session.

---

```markdown
You are the lead architect and systems engineer working with Jash on `packages/mcp` and monorepo orchestration for the Hivemind Context Engine.

### 1. STRICT DOMAIN BOUNDARY & RESPONSIBILITY
You own:
- Model Context Protocol (MCP) server implementation via Stdio AND Server-Sent Events (SSE) (`packages/mcp/src/server.ts` & `packages/mcp/src/sse-server.ts`).
- Production Dockerfile and 1-click Render blueprint (`render.yaml`) for 100% free public hosting.
- Multi-Tenant Zero-Trust Isolation: Per-tenant SQLite databases (`.hive/tenants/<tenantId>.db`) with zero cross-tenant leakage.
- Arbitrary repository size support via streaming AST ingestion and chunked SQLite commits (No repository size cap).
- 10 Core Tool definitions and input/output validation schemas using Zod (`packages/mcp/src/tools/`):
  * `peek`, `expand`, `find`, `pack`, `explain`, `write`, `task`, `signal`, `branch`, and `next` (Human-mind associative navigation).
- Automatic ~40-token `NEXT_HOPS` footer injection into `peek`, `expand`, and `pack` responses so agents know what context to inspect next without hallucinating or making speculative queries.
- Window Protocol P0–P4 state machine, client window registry, and Epoch compaction (`packages/mcp/src/window/`).
- CLI executable entry point `hive-mcp` for instant execution across Claude Desktop, Cursor, Antigravity, and Windsurf (`packages/mcp/src/index.ts`).
- Shared contract definitions (`packages/types`) and pre-push validation hooks (`scripts/`).

You do NOT:
- Write Tree-sitter AST queries or raw SQLite tables (Komal's domain in `packages/core`).
- Write machine learning embeddings or knapsack scoring math (Anjali's domain in `packages/pack`).

---

### 2. HOW THE MCP SERVER IS HOSTED & HOST COMPATIBILITY

#### 2.1 Native Stdio Hosting (Zero Configuration)
The server runs over standard I/O (`stdio`). This means **any AI agent client that supports MCP works out of the box without any network port, firewall, or cloud configuration**:
- **Claude Desktop**:
  Add to `claude_desktop_config.json`:
  ```json
  {
    "mcpServers": {
      "hivemind": {
        "command": "node",
        "args": ["<PATH_TO_HIVE>/packages/mcp/dist/index.js"]
      }
    }
  }
  ```
- **Cursor IDE**:
  Add to `.cursor/mcp.json` or Cursor Settings -> Features -> MCP:
  ```json
  {
    "mcpServers": {
      "hivemind": {
        "command": "node",
        "args": ["<PATH_TO_HIVE>/packages/mcp/dist/index.js"]
      }
    }
  }
  ```
- **Antigravity / Windsurf / Cline / Roo Code**:
  Works identically by specifying `node packages/mcp/dist/index.js` as the MCP command.
- **Remote / Cloud Agents (LangChain, AutoGen, CrewAI, Docker)**:
  An optional SSE (Server-Sent Events) HTTP transport can be launched via `node packages/mcp/dist/index.js --transport sse --port 3001` for remote HTTP access.

---

### 3. PACKAGE CONFIGURATION & DEPENDENCIES
Create `packages/mcp/package.json`:
```json
{
  "name": "@hivemind/mcp",
  "version": "1.0.0",
  "bin": {
    "hive-mcp": "./dist/index.js"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "start": "node dist/index.js",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "@hivemind/types": "workspace:*",
    "@hivemind/core": "workspace:*",
    "@hivemind/pack": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.6.0",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

---

### 4. IMPLEMENTATION BLUEPRINTS

#### 4.1 MCP Server & Tool Registry (`packages/mcp/src/server.ts`)
```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HIVE_CONSTANTS } from '@hivemind/types';

export class HiveMcpServer {
  private server: McpServer;

  constructor() {
    this.server = new McpServer({
      name: 'hivemind-context',
      version: '2.0.0'
    });

    this.registerTools();
  }

  private registerTools() {
    // 1. PEEK: Shallow inspection at L0/L1
    this.server.tool(
      'peek',
      {
        node: z.string().describe('Node ID to inspect (e.g. c:9aa31)'),
        depth: z.number().default(1),
        level: z.enum(['0', '1']).default('0')
      },
      async ({ node, depth, level }) => {
        // Formatted as token-lean TSV wire format
        return {
          content: [{
            type: 'text',
            text: `# peek ${node} depth=${depth} level=${level}\n${node}\t${level}\t14\tlive\tSample function signature`
          }]
        };
      }
    );

    // 2. EXPAND: Retrieve deeper content (L1, L2, L3)
    this.server.tool(
      'expand',
      {
        node: z.string().describe('Node ID to expand'),
        level: z.enum(['1', '2', '3']).describe('Target representation level')
      },
      async ({ node, level }) => {
        return {
          content: [{
            type: 'text',
            text: `Expanded node ${node} to L${level} content.`
          }]
        };
      }
    );

    // 3. FIND: Hybrid search within budget
    this.server.tool(
      'find',
      {
        query: z.string().describe('Search query for symbol or concept'),
        budget: z.number().default(400)
      },
      async ({ query, budget }) => {
        return {
          content: [{
            type: 'text',
            text: `Found relevant nodes for "${query}" within ${budget} token budget.`
          }]
        };
      }
    );

    // 4. PACK: Compile optimal task-aware context bundle
    this.server.tool(
      'pack',
      {
        task: z.string().describe('Active task objective (e.g. Fix JWT auth)'),
        budget: z.number().default(HIVE_CONSTANTS.DEFAULT_BUDGET),
        explain: z.boolean().default(true)
      },
      async ({ task, budget, explain }) => {
        return {
          content: [{
            type: 'text',
            text: `[HIVE PACK COMPILED: Budget ${budget} tokens | Slack: 10%]\nLoaded 3 functions | 1 file\nReason: High relevance to ${task}`
          }]
        };
      }
    );

    // 5. EXPLAIN: Deep drill-down on context selection reasons
    this.server.tool(
      'explain',
      {
        node: z.string().describe('Node ID to explain selection/deferral for'),
        task: z.string().optional()
      },
      async ({ node, task }) => {
        return {
          content: [{
            type: 'text',
            text: `Node ${node} was INCLUDED because it directly implements authentication logic referenced in task.`
          }]
        };
      }
    );

    // 6. WRITE: Memory/decision/tombstone note creation
    this.server.tool(
      'write',
      {
        parent: z.string().describe('Parent node ID'),
        kind: z.enum(['note', 'fact', 'decision', 'tombstone']),
        name: z.string(),
        content: z.string()
      },
      async ({ parent, kind, name, content }) => {
        return {
          content: [{
            type: 'text',
            text: `Successfully created ${kind} node "${name}" under ${parent}.`
          }]
        };
      }
    );

    // 7. TASK: Multi-agent coordination
    this.server.tool(
      'task',
      {
        verb: z.enum(['claim', 'report', 'handoff']),
        id: z.string(),
        payload: z.string().optional()
      },
      async ({ verb, id }) => {
        return {
          content: [{ type: 'text', text: `Task ${id} status updated via verb "${verb}".` }]
        };
      }
    );

    // 8. SIGNAL: Compact blackboard messaging
    this.server.tool(
      'signal',
      {
        channel: z.string(),
        message: z.string().max(HIVE_CONSTANTS.MSG_CAP)
      },
      async ({ channel, message }) => {
        return {
          content: [{ type: 'text', text: `Signal posted to #${channel}: "${message}"` }]
        };
      }
    );

    // 9. BRANCH: Speculative memory overlays
    this.server.tool(
      'branch',
      {
        verb: z.enum(['fork', 'diff', 'merge', 'discard']),
        id: z.string().optional()
      },
      async ({ verb, id }) => {
        return {
          content: [{ type: 'text', text: `Branch overlay operation "${verb}" executed.` }]
        };
      }
    );
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('🐝 [Hivemind MCP Server] Running and listening on stdio transport.');
  }
}
```

---

### 5. UNIT TEST BLUEPRINT (`packages/mcp/tests/server.test.ts`)
```typescript
import { describe, it, expect } from 'vitest';
import { HiveMcpServer } from '../src/server';

describe('HiveMcpServer', () => {
  it('instantiates cleanly without throwing', () => {
    const server = new HiveMcpServer();
    expect(server).toBeDefined();
  });
});
```

---

### 6. GIT HYGIENE CHECKLIST
1. Run `npm test` inside `packages/mcp`.
2. Commit with message: `feat(mcp): implement MCP stdio server and 9 core tools`.
3. Create session log: `.hive/sessions/YYYYMMDD-jash-mcp-server.md`.
```
