import type Database from 'better-sqlite3';
import { NodeRecord } from '@hivemind/types';

/**
 * SQLite FTS5 treats `verifyJwt` as one token, which makes natural-language
 * queries such as "jwt verification" miss the symbol entirely. This auxiliary
 * index stores an identifier-normalized search document (`verify Jwt`) and is
 * used for lexical retrieval alongside the original nodes_fts table.
 */
export function ensureSearchIndex(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS hive_fts USING fts5(
      id UNINDEXED,
      text
    );
  `);

  const indexed = db.prepare('SELECT COUNT(*) as count FROM hive_fts').get() as { count: number };
  const nodes = db.prepare('SELECT COUNT(*) as count FROM nodes').get() as { count: number };
  if (indexed.count === 0 && nodes.count > 0) {
    const rows = db.prepare('SELECT * FROM nodes WHERE status != \'superseded\'').all() as NodeRecord[];
    const tx = db.transaction(() => {
      for (const node of rows) writeSearchDocument(db, node);
    });
    tx();
  }
}

export function buildSearchDocument(node: NodeRecord): string {
  const raw = [
    node.name,
    node.filePath ?? '',
    node.subsystem ?? '',
    node.l0,
    node.l1 ?? '',
    node.l2 ?? ''
  ].join(' ').slice(0, 8000);

  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./\\:@]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function writeSearchDocument(db: Database.Database, node: NodeRecord): void {
  db.prepare('DELETE FROM hive_fts WHERE id = ?').run(node.id);
  db.prepare('INSERT INTO hive_fts (id, text) VALUES (?, ?)').run(node.id, buildSearchDocument(node));
}

export function removeSearchDocuments(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM hive_fts WHERE id IN (${placeholders})`).run(...ids);
}
