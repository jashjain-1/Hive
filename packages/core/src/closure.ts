import Database from 'better-sqlite3';
import { TreeType } from '@hivemind/types';

/**
 * Transitive Closure Table Maintenance
 *
 * Maintains ancestor/descendant relationships for instant subtree querying.
 * Supports depth-bounded traversal and fast "is descendant of" checks.
 */

export function rebuildClosure(db: Database.Database, tree: TreeType): void {
  // Clear existing closure entries for this tree
  db.prepare('DELETE FROM closure WHERE tree = ?').run(tree);

  const insertClosure = db.prepare(`
    INSERT OR IGNORE INTO closure (tree, anc, desc, depth) VALUES (?, ?, ?, ?)
  `);

  const allNodes = db.prepare('SELECT id, parent FROM nodes WHERE tree = ?').all(tree) as Array<{ id: string; parent: string | null }>;

  const tx = db.transaction(() => {
    for (const node of allNodes) {
      // Self-reference (depth 0)
      insertClosure.run(tree, node.id, node.id, 0);

      // Walk up to root collecting ancestors
      let current: string | null = node.parent;
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

/** Check if descNode is a descendant of ancNode in the given tree */
export function isDescendant(db: Database.Database, tree: TreeType, ancNode: string, descNode: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM closure WHERE tree = ? AND anc = ? AND desc = ? AND depth > 0
  `).get(tree, ancNode, descNode);
  return !!row;
}

/** Get all descendants of a node with depth info */
export function getDescendants(db: Database.Database, tree: TreeType, ancestorId: string, maxDepth?: number): Array<{ id: string; depth: number }> {
  if (maxDepth !== undefined) {
    return db.prepare(`
      SELECT desc as id, depth FROM closure
      WHERE tree = ? AND anc = ? AND depth > 0 AND depth <= ?
      ORDER BY depth
    `).all(tree, ancestorId, maxDepth) as Array<{ id: string; depth: number }>;
  }
  return db.prepare(`
    SELECT desc as id, depth FROM closure
    WHERE tree = ? AND anc = ? AND depth > 0
    ORDER BY depth
  `).all(tree, ancestorId) as Array<{ id: string; depth: number }>;
}

/** Get all ancestors of a node with depth info */
export function getAncestors(db: Database.Database, tree: TreeType, descendantId: string): Array<{ id: string; depth: number }> {
  return db.prepare(`
    SELECT anc as id, depth FROM closure
    WHERE tree = ? AND desc = ? AND depth > 0
    ORDER BY depth DESC
  `).all(tree, descendantId) as Array<{ id: string; depth: number }>;
}
