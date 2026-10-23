import Database from 'better-sqlite3';
import { TreeType } from '@hivemind/types';

/**
 * Transitive Closure Table Maintenance.
 *
 * Maintains ancestor/descendant relationships for subtree queries.
 */

export function rebuildClosure(db: Database.Database, tree: TreeType): void {
  const tx = db.transaction(() => {
    // Clear and rebuild atomically.
    db.prepare('DELETE FROM closure WHERE tree = ?').run(tree);

    const insertClosure = db.prepare(`
      INSERT INTO closure (tree, anc, desc, depth)
      VALUES (?, ?, ?, ?)
    `);

    const allNodes = db.prepare(`
      SELECT id, parent
      FROM nodes
      WHERE tree = ?
    `).all(tree) as Array<{
      id: string;
      parent: string | null;
    }>;

    const parentLookup = new Map<string, string | null>();

    for (const node of allNodes) {
      parentLookup.set(node.id, node.parent);
    }

    for (const node of allNodes) {
      // Every node is its own ancestor at depth zero.
      insertClosure.run(tree, node.id, node.id, 0);

      let current = node.parent;
      let depth = 1;
      const visited = new Set<string>([node.id]);

      while (current) {
        if (visited.has(current)) {
          throw new Error(
            `Parent cycle detected while rebuilding closure for node "${node.id}".`
          );
        }

        const parentTree = db.prepare(`
          SELECT tree FROM nodes WHERE id = ?
        `).get(current) as { tree: string } | undefined;

        if (!parentTree) {
          throw new Error(
            `Parent "${current}" does not exist for node "${node.id}".`
          );
        }

        if (parentTree.tree !== tree) {
          throw new Error(
            `Parent "${current}" belongs to a different tree.`
          );
        }

        visited.add(current);
        insertClosure.run(tree, current, node.id, depth);

        current = parentLookup.has(current)
          ? parentLookup.get(current) ?? null
          : null;

        depth++;
      }
    }
  });

  tx();
}

/** Check if descNode is a descendant of ancNode. */
export function isDescendant(
  db: Database.Database,
  tree: TreeType,
  ancNode: string,
  descNode: string
): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM closure
    WHERE tree = ?
      AND anc = ?
      AND desc = ?
      AND depth > 0
  `).get(tree, ancNode, descNode);

  return !!row;
}

/** Get descendants, optionally limited by depth. */
export function getDescendants(
  db: Database.Database,
  tree: TreeType,
  ancestorId: string,
  maxDepth?: number
): Array<{ id: string; depth: number }> {
  if (maxDepth !== undefined) {
    if (!Number.isInteger(maxDepth) || maxDepth < 0) {
      throw new Error('maxDepth must be a non-negative integer.');
    }

    return db.prepare(`
      SELECT desc AS id, depth
      FROM closure
      WHERE tree = ?
        AND anc = ?
        AND depth > 0
        AND depth <= ?
      ORDER BY depth
    `).all(tree, ancestorId, maxDepth) as Array<{
      id: string;
      depth: number;
    }>;
  }

  return db.prepare(`
    SELECT desc AS id, depth
    FROM closure
    WHERE tree = ?
      AND anc = ?
      AND depth > 0
    ORDER BY depth
  `).all(tree, ancestorId) as Array<{
    id: string;
    depth: number;
  }>;
}

/** Get ancestors of a node, ordered from farthest to nearest. */
export function getAncestors(
  db: Database.Database,
  tree: TreeType,
  descendantId: string
): Array<{ id: string; depth: number }> {
  return db.prepare(`
    SELECT anc AS id, depth
    FROM closure
    WHERE tree = ?
      AND desc = ?
      AND depth > 0
    ORDER BY depth DESC
  `).all(tree, descendantId) as Array<{
    id: string;
    depth: number;
  }>;
}