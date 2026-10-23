import { NodeRecord, TaskCandidate, LinkRelation } from '@hivemind/types';
import { LocalEmbeddingEngine } from './embeddings';

/**
 * Task-Aware Multi-Factor Relevance Ranker
 *
 * S(n, Q) = 0.40 * S_bm25(n, Q) + 0.40 * S_vec(n, Q) + 0.20 * S_graph(n, Q)
 *
 * Weights:
 *   w_bm25  = 0.40  Lexical retrieval score
 *   w_vec   = 0.40  Dense semantic similarity
 *   w_graph = 0.20  Call graph topology connectivity
 */

const W_BM25 = 0.40;
const W_VEC = 0.40;
const W_GRAPH = 0.20;

// Graph topology connectivity thresholds
const GRAPH_HOP1_THRESHOLD = 0.85;
const GRAPH_HOP1_BONUS = 1.0;
const GRAPH_HOP2_BONUS = 0.5;

// Active development boost (modified in git working tree)
const ACTIVE_DEVELOPMENT_BOOST = 1.50;

export class RelevanceRanker {
  constructor(private embeddings: LocalEmbeddingEngine) {}

  /**
   * Score all candidates against a task query.
   * @param candidates  List of nodes to score
   * @param taskQuery   The user's task description
   * @param bm25Results Pre-computed BM25 results from FTS5 (id -> score)
   * @param graphLinks  Adjacency map: nodeId -> [{ dst, rel }]
   * @param modifiedIds Set of node IDs modified in active git working tree
   */
  async scoreCandidates(
    candidates: NodeRecord[],
    taskQuery: string,
    bm25Results: Map<string, number>,
    graphLinks: Map<string, Array<{ dst: string; rel: LinkRelation }>>,
    modifiedIds: Set<string> = new Set()
  ): Promise<TaskCandidate[]> {
    const taskVec = await this.embeddings.embed(taskQuery);

    const scored: TaskCandidate[] = [];

    // Pre-compute vector similarity for all candidates with embeddings
    const vecScores = new Map<string, number>();
    const candidatesWithEmbeddings = candidates.filter(n => n.embedding);
    if (candidatesWithEmbeddings.length > 0) {
      const texts = candidatesWithEmbeddings.map(n => n.l0 + ' ' + (n.l1 ?? '') + ' ' + (n.l2 ?? ''));
      const embeddings = await this.embeddings.embedBatch(texts);
      for (let i = 0; i < candidatesWithEmbeddings.length; i++) {
        vecScores.set(candidatesWithEmbeddings[i].id, this.embeddings.cosineSimilarity(taskVec, embeddings[i]));
      }
    }

    // Compute max vec score among all candidates (for graph hop detection)
    let maxVecScore = 0;
    for (const score of vecScores.values()) {
      if (score > maxVecScore) maxVecScore = score;
    }

    for (const node of candidates) {
      // 1. BM25 lexical score (normalized to [0, 1])
      const bm25Raw = bm25Results.get(node.id) ?? 0;
      const bm25Normalized = this.normalizeBm25(bm25Raw, candidates);

      // 2. Vector semantic similarity
      const vecScore = vecScores.get(node.id) ?? 0;

      // 3. Graph topology connectivity
      const graphScore = this.computeGraphScore(node.id, graphLinks, vecScores, maxVecScore);

      // Composite score
      let composite = W_BM25 * bm25Normalized + W_VEC * vecScore + W_GRAPH * graphScore;

      // Active development boost
      if (modifiedIds.has(node.id) || modifiedIds.has(node.filePath ?? '')) {
        composite = Math.min(1.0, ACTIVE_DEVELOPMENT_BOOST * composite);
      }

      // Subsystem domain boost (2.0x for matching subsystem)
      // (Applied later in knapsack; here we just note it)

      // MMR diversity penalty will be applied in knapsack

      scored.push({
        node,
        level: 0 as const,
        score: composite,
        bm25Score: bm25Normalized,
        vecScore,
        graphScore,
        costTokens: node.tokL0,
        marginalGain: composite * 0.25 / node.tokL0, // cov[0] = 0.25
        reason: this.buildReason(node, composite, bm25Normalized, vecScore, graphScore)
      });
    }

    return scored.sort((a, b) => b.score - a.score);
  }

  private normalizeBm25(rawScore: number, candidates: NodeRecord[]): number {
    if (candidates.length === 0) return 0;
    // BM25 scores from FTS5 are relative; normalize against the max observed
    // In practice, we'd track the global max, but here we use a soft clamp
    return Math.min(1.0, rawScore / 10.0);
  }

  private computeGraphScore(
    nodeId: string,
    graphLinks: Map<string, Array<{ dst: string; rel: LinkRelation }>>,
    vecScores: Map<string, number>,
    maxVecScore: number
  ): number {
    const neighbors = graphLinks.get(nodeId);
    if (!neighbors || neighbors.length === 0) return 0;

    // 1-hop: any neighbor with vecScore >= 0.85
    for (const neighbor of neighbors) {
      const neighborVec = vecScores.get(neighbor.dst) ?? 0;
      if (neighborVec >= GRAPH_HOP1_THRESHOLD) {
        return GRAPH_HOP1_BONUS;
      }
    }

    // 2-hop: any 2nd-degree neighbor with high vec score
    for (const neighbor of neighbors) {
      const secondHop = graphLinks.get(neighbor.dst);
      if (secondHop) {
        for (const hop2 of secondHop) {
          const hop2Vec = vecScores.get(hop2.dst) ?? 0;
          if (hop2Vec >= GRAPH_HOP1_THRESHOLD) {
            return GRAPH_HOP2_BONUS;
          }
        }
      }
    }

    return 0;
  }

  private buildReason(
    node: NodeRecord,
    composite: number,
    bm25: number,
    vec: number,
    graph: number
  ): string {
    const parts: string[] = [];
    if (bm25 > 0.3) parts.push(`BM25=${bm25.toFixed(2)}`);
    if (vec > 0.3) parts.push(`vecSim=${vec.toFixed(2)}`);
    if (graph > 0) parts.push(`graph=${graph.toFixed(1)}`);
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `Relevance ${composite.toFixed(2)}${detail} | ${node.kind} ${node.name}`;
  }
}
