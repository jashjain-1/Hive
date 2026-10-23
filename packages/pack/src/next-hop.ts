import { NodeRecord, NextHopPointer, NextHopResult, LinkRelation, CognitiveTrail } from '@hivemind/types';

/**
 * Human-Mind Associative Next-Hop Navigation & Cognitive Trail Guider
 *
 * 1. 1-Hop Next-Hop Predictor: Recommends the top 3 logical immediate nodes to view next (~45 tok footer).
 * 2. Multi-Hop Cognitive Trail Guider: Discovers multi-step reasoning paths
 *    (e.g., Spec -> Implementation -> Test, or Route -> Service -> Database Table).
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

  /**
   * Discovers multi-step cognitive reasoning trails through the knowledge graph.
   * Explores depth up to maxDepth (default 3 hops) along canonical reasoning archetypes:
   *   - Specification -> Implementation -> Verification (Spec -> Code -> Test)
   *   - Ingestion / API Route -> Core Engine -> Database Storage
   */
  predictMultiHopTrails(
    currentNode: NodeRecord,
    adjacencyMap: Map<string, Array<{ dstNode: NodeRecord; rel: LinkRelation; w: number }>>,
    maxDepth = 3,
    taskQuery?: string
  ): CognitiveTrail[] {
    const trails: CognitiveTrail[] = [];
    const visited = new Set<string>([currentNode.id]);

    const dfs = (
      curr: NodeRecord,
      currentPath: NextHopPointer[],
      cumulativeScore: number,
      depth: number
    ) => {
      if (depth >= maxDepth) return;

      const outgoing = adjacencyMap.get(curr.id) ?? [];
      for (const edge of outgoing) {
        if (visited.has(edge.dstNode.id)) continue;
        if (edge.dstNode.status === 'superseded' || edge.dstNode.status === 'quarantined') continue;

        const baseWeight = REL_WEIGHTS[edge.rel] ?? 0.70;
        const hopScore = Math.min(1.0, baseWeight * edge.w);
        const nextCumulative = cumulativeScore * hopScore;

        const hopPointer: NextHopPointer = {
          nodeId: edge.dstNode.id,
          name: edge.dstNode.name,
          kind: edge.dstNode.kind,
          filePath: edge.dstNode.filePath,
          relation: edge.rel,
          priorityScore: hopScore,
          tokensL0: edge.dstNode.tokL0 ?? 15,
          reason: this.buildReason(edge.rel, curr, edge.dstNode, taskQuery)
        };

        const newPath = [...currentPath, hopPointer];
        visited.add(edge.dstNode.id);

        if (newPath.length >= 2) {
          const trailArchetype = this.classifyTrailArchetype(newPath);
          trails.push({
            trailId: `trail:${newPath.map(h => h.nodeId).join('->')}`,
            hops: newPath,
            totalScore: nextCumulative,
            rationale: `${trailArchetype}: ${currentNode.name} -> ${newPath.map(h => `${h.relation} ${h.name}`).join(' -> ')}`
          });
        }

        dfs(edge.dstNode, newPath, nextCumulative, depth + 1);
        visited.delete(edge.dstNode.id);
      }
    };

    dfs(currentNode, [], 1.0, 0);

    return trails
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, 3);
  }

  private classifyTrailArchetype(hops: NextHopPointer[]): string {
    const rels = hops.map(h => h.relation);
    if (rels.includes('tests')) return 'Specification & Verification Trail';
    if (rels.includes('implements') || rels.includes('specifies')) return 'Requirement Realization Trail';
    if (rels.includes('calls') || rels.includes('depends_on')) return 'Execution Call Chain';
    return 'Associative Discovery Trail';
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
      return '---\nNEXT_HOPS: None available.';
    }

    const lines = result.recommendedHops.map((hop, idx) => {
      return `${idx + 1}. [${hop.nodeId}] (${hop.relation}) -> Priority: ${hop.priorityScore.toFixed(2)} [${hop.tokensL0} tok L0]`;
    });

    const recommended = result.recommendedHops[0];
    const action = recommended
      ? `Recommended Action: expand ${recommended.nodeId} level=1`
      : 'Recommended Action: search for related symbols';

    let footer = `---\nNEXT_HOPS:\n${lines.join('\n')}\n${action}`;

    if (result.trails && result.trails.length > 0) {
      const topTrail = result.trails[0];
      footer += `\nCOGNITIVE_TRAIL: ${topTrail.rationale} (score: ${topTrail.totalScore.toFixed(2)})`;
    }

    return footer;
  }
}
