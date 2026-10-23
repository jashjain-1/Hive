import { NodeRecord, NextHopPointer, NextHopResult, LinkRelation } from '@hivemind/types';

/**
 * Human-Mind Associative Next-Hop Navigation
 *
 * Recommends the top 3 logical nodes to view next based on cognitive
 * relation weights, simulating how a human developer navigates a codebase.
 *
 * Relation weights:
 *   specifies  = 0.95  (PRD/Spec defines requirements)
 *   implements = 0.92  (Code implements a spec)
 *   calls      = 0.88  (Function calls another)
 *   tests      = 0.80  (Test validates behavior)
 *   mentions   = 0.75  (Doc mentions a symbol)
 */

const REL_WEIGHTS: Record<LinkRelation, number> = {
  specifies: 0.95,
  implements: 0.92,
  calls: 0.88,
  tests: 0.80,
  mentions: 0.75,
  imports: 0.85,
  depends_on: 0.78,
  documents: 0.82,
  supersedes: 0.65,
  contradicts: 0.60,
  blocks: 0.70,
  next_step: 0.90
};

export class NextHopPredictor {
  predictNextHops(
    currentNode: NodeRecord,
    outgoingLinks: Array<{ dstNode: NodeRecord; rel: LinkRelation; w: number }>,
    taskQuery?: string
  ): NextHopResult {
    const recommendedHops: NextHopPointer[] = outgoingLinks
      .filter(link => link.dstNode.status !== 'superseded' && link.dstNode.status !== 'quarantined')
      .map(link => {
        const baseWeight = REL_WEIGHTS[link.rel] ?? 0.70;
        const priorityScore = Math.min(1.0, baseWeight * link.w);

        const reason = this.buildReason(link.rel, currentNode, link.dstNode, taskQuery);

        return {
          nodeId: link.dstNode.id,
          name: link.dstNode.name,
          kind: link.dstNode.kind,
          filePath: link.dstNode.filePath,
          relation: link.rel,
          priorityScore,
          tokensL0: link.dstNode.tokL0 ?? 15,
          reason
        };
      })
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .slice(0, 3); // Return top 3 hops (~45 tokens footer)

    return {
      currentNodeId: currentNode.id,
      currentName: currentNode.name,
      task: taskQuery,
      recommendedHops,
      trailDepth: 1
    };
  }

  /** Build a human-readable 1-line reason for why this next hop matters */
  private buildReason(
    rel: LinkRelation,
    current: NodeRecord,
    target: NodeRecord,
    taskQuery?: string
  ): string {
    const relLabels: Record<LinkRelation, string> = {
      specifies: 'Defines requirements for',
      implements: 'Implements specification in',
      calls: 'Calls function in',
      tests: 'Validates edge cases of',
      mentions: 'Referenced in',
      imports: 'Imports module from',
      depends_on: 'Depends on',
      documents: 'Documents',
      supersedes: 'Supersedes',
      contradicts: 'Contradicts',
      blocks: 'Blocks',
      next_step: 'Next logical step from'
    };

    const label = relLabels[rel] ?? `Associated via ${rel}`;
    const taskContext = taskQuery ? ` (for: ${taskQuery.slice(0, 40)})` : '';
    return `${label} ${current.name}${taskContext}`;
  }

  /**
   * Format next-hop results as a compact ~40-token footer string.
   */
  formatFooter(result: NextHopResult): string {
    if (result.recommendedHops.length === 0) {
      return '---\\nNEXT_HOPS: None available.';
    }

    const lines = result.recommendedHops.map((hop, idx) => {
      const kindLabel = hop.kind.startsWith('c:') ? 'c' : 'd';
      return `${idx + 1}. [${hop.nodeId}] (${hop.relation}) -> Priority: ${hop.priorityScore.toFixed(2)} [${hop.tokensL0} tok L0]`;
    });

    const recommended = result.recommendedHops[0];
    const action = recommended
      ? `Recommended Action: expand ${recommended.nodeId} level=1`
      : 'Recommended Action: search for related symbols';

    return `---\\nNEXT_HOPS:\\n${lines.join('\\n')}\\n${action}`;
  }
}
