# Master Engineering Directive & AI Prompt: Komal (Data Engine & AST Indexer)

> **Role**: Core Database & AST Indexing Specialist  
> **Package Ownership**: `packages/core`  
> **Target Branch**: `feat/komal-ingest-ast`  
> **Direct Collaborators**: Anjali (`packages/pack`), Jash (`packages/mcp`)  
> **Instructions for Komal**: Copy and paste the entire prompt below into your AI assistant session.

---

```markdown
You are a senior database and compilers engineer working with Komal on `packages/core` of the Hivemind Context Engine monorepo.

### 1. STRICT DOMAIN BOUNDARY & RESPONSIBILITY
You own:
- SQLite WAL database schema, migrations, prepared statements, and CAS writes (`packages/core/src/db.ts`).
- Tree-sitter WASM AST parser & chunk-level indexer for TypeScript/JavaScript & Python (`packages/core/src/ast/`).
- Merkle content hashing, dirty-bit tracking, and cascade invalidation (`packages/core/src/merkle.ts`).
- Transitive closure table maintenance for sub-tree queries (`packages/core/src/closure.ts`).
- Human/Agent-readable graph export and cold-boot import for `.hive/graph.json` (`packages/core/src/graph-exporter.ts`).

You do NOT:
- Implement MCP server stdio transports or tool routers (owned by Jash in `packages/mcp`).
- Implement vector embeddings, knapsack pack ranking, or BM25 search algorithms (owned by Anjali in `packages/pack`).
- Modify `@hivemind/types` without coordinating with Jash.

---

### 2. PACKAGE CONFIGURATION & DEPENDENCIES
Create `packages/core/package.json`:
```json
{
  "name": "@hivemind/core",
  "version": "1.0.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "@hivemind/types": "workspace:*",
    "better-sqlite3": "^11.8.1",
    "web-tree-sitter": "^0.22.6"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

Precompiled WASM grammars must be stored in `packages/core/vendor/wasm/`:
- `tree-sitter.wasm` (WebTreeSitter core)
- `tree-sitter-typescript.wasm`
- `tree-sitter-python.wasm`

---

### 3. IMPLEMENTATION BLUEPRINTS

#### 3.1 Database Initialization & Schema (`packages/core/src/db.ts`)
```typescript
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { NodeRecord, CrossLink, TreeType } from '@hivemind/types';

export function initializeDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  
  // High-performance WAL configuration
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');

  // Schema creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      tree TEXT NOT NULL CHECK (tree IN ('task','memory','code','knowledge','decision','tool')),
      parent TEXT REFERENCES nodes(id),
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      filePath TEXT,
      startLine INT,
      endLine INT,
      status TEXT NOT NULL DEFAULT 'live',
      ver INTEGER NOT NULL DEFAULT 1,
      hash TEXT NOT NULL,
      linkHash TEXT,
      l0 TEXT NOT NULL,
      l1 TEXT,
      l2 TEXT,
      blobHash TEXT,
      tokL0 INT NOT NULL,
      tokL1 INT DEFAULT 0,
      tokL2 INT DEFAULT 0,
      embedding BLOB,
      stale INT DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS closure (
      tree TEXT NOT NULL,
      anc TEXT NOT NULL REFERENCES nodes(id),
      desc TEXT NOT NULL REFERENCES nodes(id),
      depth INT NOT NULL,
      PRIMARY KEY (tree, anc, desc)
    );

    CREATE TABLE IF NOT EXISTS links (
      src TEXT NOT NULL REFERENCES nodes(id),
      dst TEXT NOT NULL REFERENCES nodes(id),
      rel TEXT NOT NULL,
      w REAL DEFAULT 1.0,
      PRIMARY KEY (src, dst, rel)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id UNINDEXED,
      name,
      l0,
      l1,
      content=nodes,
      content_rowid=rowid
    );

    -- Triggers for FTS5 synchronization
    CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, name, l0, l1) VALUES (new.rowid, new.id, new.name, new.l0, new.l1);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, name, l0, l1) VALUES ('delete', old.rowid, old.id, old.name, old.l0, old.l1);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, name, l0, l1) VALUES ('delete', old.rowid, old.id, old.name, old.l0, old.l1);
      INSERT INTO nodes_fts(rowid, id, name, l0, l1) VALUES (new.rowid, new.id, new.name, new.l0, new.l1);
    END;
  `);

  return db;
}
```

#### 3.2 Tree-sitter WASM Chunk Indexer (`packages/core/src/ast/chunker.ts`)
```typescript
import Parser from 'web-tree-sitter';
import path from 'path';
import crypto from 'crypto';
import { NodeRecord, NodeKind } from '@hivemind/types';

export class AstChunker {
  private parser!: Parser;
  private tsLang!: Parser.Language;
  private pyLang!: Parser.Language;
  private initialized = false;

  async init(wasmDir: string) {
    if (this.initialized) return;
    await Parser.init({
      locateFile: (file: string) => path.join(wasmDir, file)
    });
    this.parser = new Parser();
    this.tsLang = await Parser.Language.load(path.join(wasmDir, 'tree-sitter-typescript.wasm'));
    this.pyLang = await Parser.Language.load(path.join(wasmDir, 'tree-sitter-python.wasm'));
    this.initialized = true;
  }

  parseSource(filePath: string, sourceCode: string): NodeRecord[] {
    const ext = path.extname(filePath);
    const isPython = ext === '.py';
    this.parser.setLanguage(isPython ? this.pyLang : this.tsLang);

    const tree = this.parser.parse(sourceCode);
    const lines = sourceCode.split('\n');
    const nodes: NodeRecord[] = [];

    // Root File Node
    const fileHash = crypto.createHash('sha256').update(sourceCode).digest('hex');
    const fileId = `c:${crypto.randomBytes(3).toString('hex')}`;
    const fileNode: NodeRecord = {
      id: fileId,
      tree: 'code',
      parent: null,
      kind: 'file',
      name: path.basename(filePath),
      filePath,
      startLine: 1,
      endLine: lines.length,
      status: 'live',
      ver: 1,
      hash: fileHash,
      l0: `${path.basename(filePath)} (${lines.length} lines)`,
      l2: sourceCode.length < 3000 ? sourceCode : undefined,
      tokL0: Math.ceil(path.basename(filePath).length / 3),
      tokL1: 0,
      tokL2: Math.ceil(sourceCode.length / 4),
      stale: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    nodes.push(fileNode);

    // Recursive Walker to extract function & class chunks
    const cursor = tree.walk();
    const extractChunks = () => {
      const type = cursor.nodeType;
      let kind: NodeKind | null = null;
      let name = 'anonymous';

      if (['function_declaration', 'method_definition', 'arrow_function', 'function_definition'].includes(type)) {
        kind = type === 'method_definition' ? 'method' : 'function';
        const nameNode = cursor.currentNode.childForFieldName('name');
        if (nameNode) name = nameNode.text;
      } else if (['class_declaration', 'class_definition'].includes(type)) {
        kind = 'class';
        const nameNode = cursor.currentNode.childForFieldName('name');
        if (nameNode) name = nameNode.text;
      } else if (type === 'interface_declaration') {
        kind = 'interface';
        const nameNode = cursor.currentNode.childForFieldName('name');
        if (nameNode) name = nameNode.text;
      }

      if (kind) {
        const startLine = cursor.currentNode.startPosition.row + 1;
        const endLine = cursor.currentNode.endPosition.row + 1;
        const chunkText = lines.slice(startLine - 1, endLine).join('\n');
        const chunkHash = crypto.createHash('sha256').update(`${kind}\n${chunkText}`).digest('hex');

        nodes.push({
          id: `c:${crypto.randomBytes(3).toString('hex')}`,
          tree: 'code',
          parent: fileId,
          kind,
          name,
          filePath,
          startLine,
          endLine,
          status: 'live',
          ver: 1,
          hash: chunkHash,
          l0: `${kind} ${name}() [lines ${startLine}-${endLine}]`,
          l2: chunkText,
          tokL0: Math.ceil((name.length + 15) / 3),
          tokL1: 0,
          tokL2: Math.ceil(chunkText.length / 4),
          stale: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }

      if (cursor.gotoFirstChild()) {
        do {
          extractChunks();
        } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };

    extractChunks();
    return nodes;
  }
}
```

#### 3.3 Merkle Invalidation & Graph Sync (`packages/core/src/graph-exporter.ts`)
```typescript
import Database from 'better-sqlite3';
import fs from 'fs';
import { GraphJsonExport } from '@hivemind/types';

export function exportGraphToJson(db: Database.Database, outputPath: string): void {
  const nodes = db.prepare(`
    SELECT id, tree, parent, kind, name, filePath, startLine, endLine, hash, l0, l1, tokL0, tokL1 
    FROM nodes WHERE status != 'superseded'
  `).all() as any[];

  const links = db.prepare(`SELECT src, dst, rel, w FROM links`).all() as any[];

  const exportData: GraphJsonExport = {
    version: '2.0',
    exportedAt: Date.now(),
    stats: {
      totalNodes: nodes.length,
      totalFiles: nodes.filter(n => n.kind === 'file').length,
      totalChunks: nodes.filter(n => n.kind !== 'file').length,
      totalLinks: links.length
    },
    nodes,
    links
  };

  fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2), 'utf8');
}
```

---

### 4. UNIT TEST BLUEPRINT (`packages/core/tests/chunker.test.ts`)
Write unit tests using Vitest:
```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { AstChunker } from '../src/ast/chunker';

describe('AstChunker', () => {
  let chunker: AstChunker;

  beforeAll(async () => {
    chunker = new AstChunker();
    await chunker.init(path.join(__dirname, '../vendor/wasm'));
  });

  it('correctly chunks functions and classes in TypeScript', () => {
    const code = `
      export class AuthService {
        public login(username: string): boolean {
          return true;
        }
      }
      export function verifyToken(token: string) {
        return !!token;
      }
    `;
    const chunks = chunker.parseSource('src/auth.ts', code);
    expect(chunks.length).toBe(4); // 1 file + 1 class + 1 method + 1 function
    expect(chunks.some(c => c.name === 'AuthService' && c.kind === 'class')).toBe(true);
    expect(chunks.some(c => c.name === 'login' && c.kind === 'method')).toBe(true);
    expect(chunks.some(c => c.name === 'verifyToken' && c.kind === 'function')).toBe(true);
  });
});
```

---

### 5. GIT HYGIENE CHECKLIST
1. Run `npm test` inside `packages/core`.
2. Commit with message: `feat(core): implement Tree-sitter AST chunker and SQLite WAL engine`.
3. Create session log: `.hive/sessions/YYYYMMDD-komal-ast-chunker.md`.
```
