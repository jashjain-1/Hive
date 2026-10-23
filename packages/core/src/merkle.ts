import crypto from 'crypto';
import { NodeRecord } from '@hivemind/types';

/**
 * Merkle Content Hash Tree
 *
 * Invariant I5: Merkle hash covers authored content and child hashes only.
 * Derived data (summaries, embeddings, pheromones) does not affect hashes.
 *
 * H(n) = SHA256(kind(n) || authored(n) || sort({ H(c) : c in children(n) }))
 */

const CHILD_HASH_PLACEHOLDER = '___CHILD_HASHES___';

export class MerkleTree {
  /**
   * Compute a node's Merkle hash from its authored content and sorted child hashes.
   */
  static computeHash(node: NodeRecord, childHashes: string[]): string {
    const sortedChildHashes = [...childHashes].sort();
    const childSection = sortedChildHashes.length > 0
      ? sortedChildHashes.join('||')
      : '';

    const authoredContent = [
      node.kind,
      node.l0,
      node.l1 ?? '',
      node.l2 ?? '',
      node.name,
      node.filePath ?? '',
      node.startLine ?? 0,
      node.endLine ?? 0
    ].join('\n');

    const payload = [
      node.kind,
      authoredContent,
      childSection
    ].join('|||');

    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Compute hashes for a flat list of nodes assuming children are listed after parents.
   * Returns nodes with updated hash fields.
   */
  static computeAllHashes(nodes: NodeRecord[]): NodeRecord[] {
    const hashCache = new Map<string, string>();
    const childrenMap = new Map<string, string[]>();

    // Build parent -> children mapping
    for (const node of nodes) {
      if (node.parent) {
        const existing = childrenMap.get(node.parent) ?? [];
        existing.push(node.id);
        childrenMap.set(node.parent, existing);
      }
    }

    // Process in topological order: roots first, then children
    const roots = nodes.filter(n => !n.parent);
    const result: NodeRecord[] = [...nodes];

    const computeNodeHash = (nodeId: string): string => {
      if (hashCache.has(nodeId)) return hashCache.get(nodeId)!;

      const node = result.find(n => n.id === nodeId);
      if (!node) return '';

      const childIds = childrenMap.get(nodeId) ?? [];
      const childHashes = childIds.map(computeNodeHash).filter(Boolean);

      const hash = this.computeHash(node, childHashes);
      hashCache.set(nodeId, hash);
      return hash;
    };

    // Compute for all nodes
    for (const node of result) {
      computeNodeHash(node.id);
    }

    // Apply hashes back
    for (const node of result) {
      node.hash = hashCache.get(node.id) ?? node.hash;
    }

    return result;
  }

  /**
   * Verify a node's hash hasn't been tampered with.
   */
  static verifyHash(node: NodeRecord, childHashes: string[]): boolean {
    const expected = this.computeHash(node, childHashes);
    return expected === node.hash;
  }
}
