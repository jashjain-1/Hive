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

/** Insert a node with CAS version validation */
export function insertNode(
  db: Database.Database,
  node: Omit<NodeRecord, 'ver'> & { ver?: number }
): NodeRecord {
  const now = Date.now();
  const existing = db.prepare('SELECT ver FROM nodes WHERE id = ?').get(node.id) as { ver: number } | undefined;
  const expectedVer = existing ? existing.ver : 0;
  const newVer = (node.ver ?? expectedVer + 1);

  const stmt = db.prepare(`
    INSERT INTO nodes (id, tree, parent, kind, name, filePath, startLine, endLine, status, ver, hash, linkHash, l0, l1, l2, blobHash, tokL0, tokL1, tokL2, embedding, stale, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    node.id,
    node.tree,
    node.parent,
    node.kind,
    node.name,
    node.filePath ?? null,
    node.startLine ?? null,
    node.endLine ?? null,
    node.status,
    newVer,
    node.hash,
    node.linkHash ?? null,
    node.l0,
    node.l1 ?? null,
    node.l2 ?? null,
    node.blobHash ?? null,
    node.tokL0,
    node.tokL1 ?? 0,
    node.tokL2 ?? 0,
    node.embedding ? Buffer.from(node.embedding.buffer) : null,
    node.stale ? 1 : 0,
    node.createdAt ?? now,
    node.updatedAt ?? now
  );

  return { ...node, ver: newVer, updatedAt: now };
}

/** CAS update: only succeeds if version matches */
export function casUpdateNode(
  db: Database.Database,
  id: string,
  expectedVer: number,
  updates: Partial<Pick<NodeRecord, 'l1' | 'l2' | 'status' | 'stale' | 'hash' | 'linkHash' | 'embedding'>>
): boolean {
  const result = db.prepare(`
    UPDATE nodes SET
      l1 = COALESCE(?, l1),
      l2 = COALESCE(?, l2),
      status = COALESCE(?, status),
      stale = COALESCE(?, stale),
      hash = COALESCE(?, hash),
      linkHash = COALESCE(?, linkHash),
      embedding = COALESCE(?, embedding),
      ver = ver + 1,
      updatedAt = ?
    WHERE id = ? AND ver = ?
  `).run(
    updates.l1 ?? null,
    updates.l2 ?? null,
    updates.status ?? null,
    updates.stale !== undefined ? (updates.stale ? 1 : 0) : null,
    updates.hash ?? null,
    updates.linkHash ?? null,
    updates.embedding ? Buffer.from(updates.embedding.buffer) : null,
    Date.now(),
    id,
    expectedVer
  );

  return result.changes > 0;
}

/** Insert a cross-link */
export function insertLink(db: Database.Database, link: CrossLink): void {
  db.prepare(`
    INSERT OR IGNORE INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)
  `).run(link.src, link.dst, link.rel, link.w);
}

/** Query nodes by subtree using closure table */
export function querySubtree(db: Database.Database, tree: TreeType, ancestorId: string): NodeRecord[] {
  return db.prepare(`
    SELECT n.* FROM nodes n
    JOIN closure c ON c.desc = n.id
    WHERE c.tree = ? AND c.anc = ?
    ORDER BY c.depth
  `).all(tree, ancestorId) as NodeRecord[];
}

/** Full-text search over nodes */
export function ftsSearch(db: Database.Database, query: string, limit = 50): Array<{ id: string; name: string; l0: string; bm25: number }> {
  return db.prepare(`
    SELECT id, name, l0, bm25(nodes_fts) as bm25
    FROM nodes_fts
    WHERE nodes_fts MATCH ?
    ORDER BY bm25 DESC
    LIMIT ?
  `).all(query, limit) as Array<{ id: string; name: string; l0: string; bm25: number }>;
}

/** Update transitive closure table for a tree */
export function rebuildClosure(db: Database.Database, tree: TreeType): void {
  db.exec(`DELETE FROM closure WHERE tree = '${tree}'`);

  const insertClosure = db.prepare(`
    INSERT OR IGNORE INTO closure (tree, anc, desc, depth) VALUES (?, ?, ?, ?)
  `);

  const allNodes = db.prepare(`SELECT id, parent FROM nodes WHERE tree = ?`).all(tree) as Array<{ id: string; parent: string | null }>;

  const tx = db.transaction(() => {
    for (const node of allNodes) {
      // Self-reference
      insertClosure.run(tree, node.id, node.id, 0);

      // Ancestors
      let current = node.parent;
      let depth = 1;
      while (current) {
        insertClosure.run(tree, current, node.id, depth);
        const parentRow = db.prepare('SELECT parent FROM nodes WHERE id = ?').get(current) as { parent: string | null } | undefined;
        current = parentRow?.parent ?? null;
        depth++;
      }
    }
  });

  tx();
}
