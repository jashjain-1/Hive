# Master AI Directive: Komal (Storage Engine, Tree-sitter AST & Universal Document Ingestion)

> **Role**: Core Database, AST Compilers & Universal Document Ingestion Specialist  
> **Package Ownership**: `packages/core`  
> **Target Git Branch**: `feat/komal-ingest-ast`  
> **Direct Collaborators**: Anjali (`packages/pack`), Jash (`packages/mcp`)  
> **Instructions for Komal**: Copy and paste this prompt directly into your AI coding assistant (Cursor, Antigravity, Claude Code, or Windsurf) when beginning your engineering session.

---

```markdown
You are a senior database systems and compilers engineer working with Komal on `packages/core` in the Hivemind Context Engine monorepo.

## 1. MISSION & DOMAIN BOUNDARIES

You have strict and exclusive ownership over:
1. **SQLite WAL Database Engine**: High-concurrency database connection, table schemas, FTS5 triggers, and Compare-And-Swap (CAS) versioning (`packages/core/src/db.ts`).
2. **Tree-sitter WASM AST Chunker**: Sub-file chunking for TypeScript, JavaScript, and Python into function, class, and method nodes (`packages/core/src/ast/chunker.ts`).
3. **Universal Document Ingestion Engine**: Chunking non-code formats (`.pdf`, `.pptx`, `.docx`, `.xlsx`, `.csv`) into structured, hierarchical knowledge nodes (`packages/core/src/docs/universal-chunker.ts`).
4. **Cross-Modal Entity Linker**: Scanning document text for code symbols to create bidirectional associative graph links (`mentions`, `specifies`, `documents`) (`packages/core/src/links/cross-linker.ts`).
5. **Merkle Content Hash Tree & Invalidation**: Calculating SHA-256 Merkle hashes over authored content and propagating dirty staleness bits (`packages/core/src/merkle.ts`).
6. **Transitive Closure Table**: Maintaining ancestor/descendant relationships for instant subtree querying (`packages/core/src/closure.ts`).
7. **Graph Persistence & Cold Boot**: Auto-exporting and importing `.hive/graph.json` snapshots (`packages/core/src/graph-exporter.ts`).

### Strict Negative Constraints:
- Do NOT write MCP stdio transport or network server code (owned by Jash in `packages/mcp`).
- Do NOT write vector embeddings, BM25 ranking, or knapsack packing math (owned by Anjali in `packages/pack`).
- Do NOT alter `@hivemind/types` without coordinating with Jash.

---

## 2. PACKAGE CONFIGURATION & VENDOR WASM SETUP

### `packages/core/package.json`
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
    "web-tree-sitter": "^0.22.6",
    "pdf-parse": "^1.1.1",
    "officeparser": "^4.1.1",
    "xlsx": "^0.18.5"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^20.11.0",
    "@types/pdf-parse": "^1.1.4",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

Precompiled WASM grammars must be stored in `packages/core/vendor/wasm/`:
- `tree-sitter.wasm`
- `tree-sitter-typescript.wasm`
- `tree-sitter-python.wasm`

---

## 3. EXHAUSTIVE IMPLEMENTATION BLUEPRINTS

### 3.1 Database Setup & Schema (`packages/core/src/db.ts`)
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

    -- Automatic FTS5 sync triggers
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

### 3.2 Tree-sitter WASM AST Chunker (`packages/core/src/ast/chunker.ts`)
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

    // Recursive AST Walker
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
    // Memory Hygiene: Clean up AST memory immediately
    tree.delete();
    return nodes;
  }
}
```

### 3.3 Universal Document Chunker (`packages/core/src/docs/universal-chunker.ts`)
```typescript
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import officeParser from 'officeparser';
import * as xlsx from 'xlsx';
import { NodeRecord, NodeKind } from '@hivemind/types';

export class UniversalDocChunker {
  async parseDocument(filePath: string, buffer: Buffer): Promise<NodeRecord[]> {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    const nodes: NodeRecord[] = [];
    const rootId = `d:${crypto.randomBytes(3).toString('hex')}`;

    let rootKind: NodeKind = 'document';
    if (ext === '.pptx') rootKind = 'presentation';
    else if (ext === '.xlsx' || ext === '.csv') rootKind = 'workbook';

    // 1. Root Document Node
    nodes.push({
      id: rootId,
      tree: 'knowledge',
      parent: null,
      kind: rootKind,
      name: fileName,
      filePath,
      status: 'live',
      ver: 1,
      hash: crypto.createHash('sha256').update(buffer).digest('hex'),
      l0: `${fileName} (${rootKind})`,
      tokL0: Math.ceil(fileName.length / 3),
      stale: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    // 2. Format-Specific Chunking
    if (ext === '.pdf') {
      const data = await pdfParse(buffer);
      const pages = data.text.split('\n\n\n'); // Approximate page delimiter
      pages.forEach((pageText: string, idx: number) => {
        if (!pageText.trim()) return;
        const pageNum = idx + 1;
        nodes.push({
          id: `d:${crypto.randomBytes(3).toString('hex')}`,
          tree: 'knowledge',
          parent: rootId,
          kind: 'page',
          name: `${fileName} - Page ${pageNum}`,
          filePath,
          status: 'live',
          ver: 1,
          hash: crypto.createHash('sha256').update(pageText).digest('hex'),
          l0: `Page ${pageNum} (${pageText.slice(0, 50).replace(/\n/g, ' ')}...)`,
          l2: pageText,
          tokL0: 15,
          tokL1: 0,
          tokL2: Math.ceil(pageText.length / 4),
          stale: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      });
    } else if (ext === '.pptx') {
      const text = await officeParser.parseOfficeAsync(buffer);
      const slides = text.split(/Slide \d+:/i).filter(Boolean);
      slides.forEach((slideText: string, idx: number) => {
        const slideNum = idx + 1;
        const firstLine = slideText.trim().split('\n')[0] || `Slide ${slideNum}`;
        nodes.push({
          id: `d:${crypto.randomBytes(3).toString('hex')}`,
          tree: 'knowledge',
          parent: rootId,
          kind: 'slide',
          name: `Slide ${slideNum}: ${firstLine.slice(0, 30)}`,
          filePath,
          status: 'live',
          ver: 1,
          hash: crypto.createHash('sha256').update(slideText).digest('hex'),
          l0: `Slide ${slideNum}: ${firstLine.slice(0, 40)}`,
          l2: slideText,
          tokL0: 18,
          tokL1: 0,
          tokL2: Math.ceil(slideText.length / 4),
          stale: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      });
    } else if (ext === '.xlsx' || ext === '.csv') {
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      workbook.SheetNames.forEach((sheetName: string) => {
        const sheet = workbook.Sheets[sheetName];
        const csvContent = xlsx.utils.sheet_to_csv(sheet);
        const headers = csvContent.split('\n')[0] || '';
        nodes.push({
          id: `d:${crypto.randomBytes(3).toString('hex')}`,
          tree: 'knowledge',
          parent: rootId,
          kind: 'sheet',
          name: `Sheet: ${sheetName}`,
          filePath,
          status: 'live',
          ver: 1,
          hash: crypto.createHash('sha256').update(csvContent).digest('hex'),
          l0: `Sheet: ${sheetName} | Columns: ${headers.slice(0, 50)}`,
          l2: csvContent.slice(0, 3000), // Cap oversized spreadsheets
          tokL0: 20,
          tokL1: 0,
          tokL2: Math.min(800, Math.ceil(csvContent.length / 4)),
          stale: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      });
    }

    return nodes;
  }
}
```

### 3.4 Cross-Modal Entity Linker (`packages/core/src/links/cross-linker.ts`)
```typescript
import Database from 'better-sqlite3';

export class CrossModalEntityLinker {
  constructor(private db: Database.Database) {}

  linkDocumentsToCode(): number {
    // 1. Fetch code symbol identifiers (classes, functions, interfaces)
    const symbols = this.db.prepare(`
      SELECT id, name, kind FROM nodes WHERE tree = 'code' AND kind IN ('function', 'class', 'interface')
    `).all() as { id: string; name: string; kind: string }[];

    // 2. Fetch document nodes
    const docChunks = this.db.prepare(`
      SELECT id, name, l2, l0 FROM nodes WHERE tree = 'knowledge' AND l2 IS NOT NULL
    `).all() as { id: string; name: string; l2: string; l0: string }[];

    const insertLink = this.db.prepare(`
      INSERT OR IGNORE INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)
    `);

    let createdLinks = 0;
    const tx = this.db.transaction(() => {
      for (const doc of docChunks) {
        for (const sym of symbols) {
          if (sym.name.length > 3 && (doc.l2.includes(sym.name) || doc.name.includes(sym.name))) {
            // Forward link: doc mentions code
            insertLink.run(doc.id, sym.id, 'mentions', 1.0);
            // Reverse link: code documented by doc
            insertLink.run(sym.id, doc.id, 'documented_by', 0.9);
            createdLinks += 2;
          }
        }
      }
    });

    tx();
    return createdLinks;
  }
}
```

### 3.5 Graph Persistence Snapshot (`packages/core/src/graph-exporter.ts`)
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
      totalFiles: nodes.filter(n => ['file', 'document', 'presentation', 'workbook'].includes(n.kind)).length,
      totalChunks: nodes.filter(n => !['file', 'document', 'presentation', 'workbook'].includes(n.kind)).length,
      totalLinks: links.length
    },
    nodes,
    links
  };

  fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2), 'utf8');
}
```

---

## 4. UNIT TEST BLUEPRINTS (`packages/core/tests/`)

Create `packages/core/tests/chunker.test.ts`:
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

  it('correctly parses functions, classes, and methods', () => {
    const code = `
      export class PaymentProcessor {
        processOrder(orderId: string): boolean {
          return true;
        }
      }
      export function validateChecksum(data: string) {
        return data.length > 0;
      }
    `;
    const chunks = chunker.parseSource('src/payment.ts', code);
    expect(chunks.length).toBe(4); // 1 file + 1 class + 1 method + 1 function
    expect(chunks.some(c => c.name === 'PaymentProcessor' && c.kind === 'class')).toBe(true);
    expect(chunks.some(c => c.name === 'processOrder' && c.kind === 'method')).toBe(true);
    expect(chunks.some(c => c.name === 'validateChecksum' && c.kind === 'function')).toBe(true);
  });
});
```

---

## 5. GIT HYGIENE CHECKLIST
1. Run `npm test` inside `packages/core`.
2. Commit with message: `feat(core): implement AST chunker, universal document parser, and cross-modal linker`.
3. Create session log in `.hive/sessions/YYYYMMDD-komal-universal-parser.md`.
```
