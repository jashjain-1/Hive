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
      const includePattern = this.overrides.matchingPattern(targetStr, config.force_include);
      const excludePattern = this.overrides.matchingPattern(targetStr, config.force_exclude);
      if (includePattern) {
        status = 'FORCED_INCLUDED';
        justification = `Forced include via .hive/overrides.json: ${includePattern}`;
      } else if (excludePattern) {
        status = 'FORCED_EXCLUDED';
        justification = `Forced exclude via .hive/overrides.json: ${excludePattern}`;
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

  /** Format complete proof matrix as an auditable verification table */
  formatProofMatrix(matrix: {
    intentAnalysis: { intent: string; confidence: number; weights: { bm25: number; vector: number; graph: number } };
    clusterAllocations: Array<{ clusterKey: string; allocatedTokens: number; usedTokens: number; candidateCount: number; selectedCount: number }>;
    proofEntries: Array<{ nodeId: string; name: string; clusterKey: string; compositeScore: number; chosenLevel: number; status: string; decisionFactor: string }>;
  }): string {
    const { intentAnalysis, clusterAllocations, proofEntries } = matrix;
    const header = `=== HIVE CONTEXT PACK PROOF MATRIX ===\nIntent: ${intentAnalysis.intent.toUpperCase()} (Confidence: ${(intentAnalysis.confidence * 100).toFixed(0)}%) | Weights: [BM25: ${intentAnalysis.weights.bm25.toFixed(2)}, Vec: ${intentAnalysis.weights.vector.toFixed(2)}, Graph: ${intentAnalysis.weights.graph.toFixed(2)}]`;

    const clusterLines = clusterAllocations.map(c =>
      `  [Cluster: ${c.clusterKey}] Budget: ${c.allocatedTokens} tok | Used: ${c.usedTokens} tok | Chunks: ${c.selectedCount}/${c.candidateCount}`
    ).join('\n');

    const entryLines = proofEntries.map(e =>
      `  - ${e.nodeId.padEnd(12)} ${e.status.padEnd(15)} L${e.chosenLevel === -1 ? 'X' : e.chosenLevel} Score: ${e.compositeScore.toFixed(3)} | ${e.decisionFactor}`
    ).join('\n');

    return `${header}\n\nCluster Allocations:\n${clusterLines}\n\nCandidate Proof Ledger:\n${entryLines}`;
  }
}
