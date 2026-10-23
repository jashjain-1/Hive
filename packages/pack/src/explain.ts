import { NodeRecord, ExplainNodeResult, PackSelection, DeferredSelection, LinkRelation } from '@hivemind/types';
import { OverridesManager } from './overrides';

/**
 * Explainable Context Selection Engine
 *
 * Generates verifiable 1-line reasons explaining why every node was
 * selected or deferred, with factor breakdown.
 */

export class ExplainEngine {
  constructor(private overrides: OverridesManager) {}

  explainNode(
    node: NodeRecord,
    candidate: { score: number; bm25Score: number; vecScore: number; graphScore: number; reason: string },
    packItems: PackSelection[],
    deferredItems: DeferredSelection[],
    taskQuery: string,
    graphNeighbors: Array<{ dst: string; rel: LinkRelation }> = []
  ): ExplainNodeResult {
    const packItem = packItems.find(i => i.nodeId === node.id);
    const deferredItem = deferredItems.find(d => d.nodeId === node.id);

    let status: ExplainNodeResult['status'];
    let justification: string;

    if (packItem) {
      status = 'INCLUDED';
      justification = packItem.reason;
    } else if (deferredItem) {
      status = 'DEFERRED';
      justification = deferredItem.reason;
    } else {
      // Check overrides
      const config = this.overrides.loadConfig();
      const targetStr = node.filePath ?? node.name;
      if (config.force_include.some(p => targetStr.includes(p))) {
        status = 'FORCED_INCLUDED';
        justification = `Forced include via .hive/overrides.json: ${config.force_include.find(p => targetStr.includes(p))}`;
      } else if (config.force_exclude.some(p => targetStr.includes(p))) {
        status = 'FORCED_EXCLUDED';
        justification = `Forced exclude via .hive/overrides.json: ${config.force_exclude.find(p => targetStr.includes(p))}`;
      } else {
        status = 'DEFERRED';
        justification = `Below relevance threshold (score=${candidate.score.toFixed(2)}) | Not selected for task "${taskQuery.slice(0, 50)}"`;
      }
    }

    // Connected symbols via graph
    const connectedSymbols = graphNeighbors
      .filter(l => l.rel === 'calls' || l.rel === 'implements' || l.rel === 'tests')
      .map(l => l.dst)
      .slice(0, 5);

    return {
      nodeId: node.id,
      name: node.name,
      status,
      compositeScore: candidate.score,
      factors: {
        bm25: candidate.bm25Score,
        semanticVector: candidate.vecScore,
        callGraph: candidate.graphScore
      },
      overrideApplied: status.startsWith('FORCED_') ? (status === 'FORCED_INCLUDED' ? 'force_include' : 'force_exclude') : undefined,
      justification,
      connectedSymbols
    };
  }

  /** Format explain result as a concise text block */
  formatExplain(result: ExplainNodeResult): string {
    const statusSymbols: Record<ExplainNodeResult['status'], string> = {
      INCLUDED: 'INCLUDED',
      DEFERRED: 'DEFERRED',
      FORCED_INCLUDED: 'FORCED_INCLUDE',
      FORCED_EXCLUDED: 'FORCED_EXCLUDE'
    };

    const factorLines = [
      `  BM25:           ${result.factors.bm25.toFixed(3)}`,
      `  Semantic Vec:   ${result.factors.semanticVector.toFixed(3)}`,
      `  Call Graph:     ${result.factors.callGraph.toFixed(3)}`
    ].join('\n');

    const overrideLine = result.overrideApplied
      ? `\n  Override:       ${result.overrideApplied}`
      : '';

    const connectedLine = result.connectedSymbols.length > 0
      ? `\n  Connected:      ${result.connectedSymbols.join(', ')}`
      : '';

    return `${result.nodeId} (${result.name})
  Status:        ${statusSymbols[result.status]}
  Score:         ${result.compositeScore.toFixed(3)}
Factor Breakdown:
${factorLines}${overrideLine}${connectedLine}
  Reason:        ${result.justification}`;
  }
}
