import { NodeRecord, TaskCandidate, LinkRelation, IntentAnalysis, QueryIntent, NodeProofEntry } from '@hivemind/types';
import { LocalEmbeddingEngine } from './embeddings';

/**
 * Task-Aware Multi-Factor Relevance Ranker with Adaptive Intent Weighting
 *
 * S(n, Q) = w_bm25 * S_bm25(n, Q) + w_vec * S_vec(n, Q) + w_graph * S_graph(n, Q)
 *
 * Dynamic Intent Weighting:
 *   - lexical:    w_bm25=0.65, w_vec=0.20, w_graph=0.15 (exact symbol / filename matches)
 *   - semantic:   w_bm25=0.15, w_vec=0.65, w_graph=0.20 (conceptual & natural language queries)
 *   - relational: w_bm25=0.20, w_vec=0.30, w_graph=0.50 (callers, dependencies, impact analysis)
 *   - hybrid:     w_bm25=0.40, w_vec=0.40, w_graph=0.20 (balanced default)
 */

// Graph topology connectivity thresholds
const GRAPH_HOP1_THRESHOLD = 0.85;
const GRAPH_HOP1_BONUS = 1.0;
const GRAPH_HOP2_BONUS = 0.5;

// Active development boost (modified in git working tree)
const ACTIVE_DEVELOPMENT_BOOST = 1.50;

export class RelevanceRanker {
  constructor(private embeddings: LocalEmbeddingEngine) {}

  /**
   * Classify user task query intent and return optimal weight distribution.
   */
  classifyIntent(query: string): IntentAnalysis {
    const trimmed = query.trim();
    const words = trimmed.split(/\s+/);

    // Detect exact code symbol patterns (camelCase, PascalCase, snake_case, file extensions, function calls)
    // Call expressions are matched first so the parentheses are preserved (e.g. "verifyJwt()").
    const symbolRegex = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\)|\b[A-Za-z0-9_]+(?:\.[a-zA-Z0-9]+|_[a-zA-Z0-9]+|[a-z]+[A-Z][a-zA-Z0-9]*|[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*)\b/g;
    const detectedSymbols = Array.from(new Set(trimmed.match(symbolRegex) || []));

    // Relational / blast-radius keywords
    const relationalKeywords = ['call', 'caller', 'calls', 'called', 'depend', 'dependency', 'blast', 'radius', 'impact', 'reference', 'import', 'used by', 'trace'];
    const isRelational = relationalKeywords.some(k => query.toLowerCase().includes(k));

    // Conceptual / semantic keywords
    const semanticKeywords = ['how', 'why', 'architecture', 'overview', 'design', 'concept', 'explain', 'understand', 'workflow', 'pipeline'];
    const isSemantic = semanticKeywords.some(k => query.toLowerCase().includes(k));

    let intent: QueryIntent = 'hybrid';
    let weights = { bm25: 0.40, vector: 0.40, graph: 0.20 };
    let confidence = 0.70;

    if (isRelational) {
      intent = 'relational';
      weights = { bm25: 0.20, vector: 0.30, graph: 0.50 };
      confidence = 0.90;
    } else if (detectedSymbols.length >= 2 || (detectedSymbols.length === 1 && words.length <= 4)) {
      intent = 'lexical';
      weights = { bm25: 0.65, vector: 0.20, graph: 0.15 };
      confidence = 0.88;
    } else if (isSemantic && detectedSymbols.length === 0) {
      intent = 'semantic';
      weights = { bm25: 0.15, vector: 0.65, graph: 0.20 };
      confidence = 0.85;
    }

    return {
      intent,
      confidence,
      weights,
      detectedSymbols
    };
  }

  /**
   * Score all candidates against a task query with adaptive intent weights.
   * Reuses pre-computed vectors and offloaded vector index results.
   */
  async scoreCandidates(
    candidates: NodeRecord[],
    taskQuery: string,
    bm25Results: Map<string, number>,
    graphLinks: Map<string, Array<{ dst: string; rel: LinkRelation }>>,
    modifiedIds: Set<string> = new Set(),
    externalVecScores?: Map<string, number>
  ): Promise<TaskCandidate[]> {
    const intentAnalysis = this.classifyIntent(taskQuery);
    const { bm25: wBm25, vector: wVec, graph: wGraph } = intentAnalysis.weights;

    const taskVec = await this.embeddings.embed(taskQuery);
    const scored: TaskCandidate[] = [];

    // 1. Resolve vector scores: use external offloaded scores if available,
    // otherwise use pre-stored node.embedding, falling back to batch embedding for missing nodes
    const vecScores = new Map<string, number>();

    const missingEmbeddingNodes: NodeRecord[] = [];
    for (const node of candidates) {
      if (externalVecScores && externalVecScores.has(node.id)) {
        vecScores.set(node.id, externalVecScores.get(node.id)!);
      } else if (node.embedding) {
        vecScores.set(node.id, this.embeddings.cosineSimilarity(taskVec, node.embedding));
      } else {
        missingEmbeddingNodes.push(node);
      }
    }

    if (missingEmbeddingNodes.length > 0) {
      const texts = missingEmbeddingNodes.map(n => n.l0 + ' ' + (n.l1 ?? '') + ' ' + (n.l2 ?? ''));
      const generatedEmbeddings = await this.embeddings.embedBatch(texts);
      for (let i = 0; i < missingEmbeddingNodes.length; i++) {
        const sim = this.embeddings.cosineSimilarity(taskVec, generatedEmbeddings[i]);
        vecScores.set(missingEmbeddingNodes[i].id, sim);
      }
    }

    // Compute max vec score among all candidates (for graph hop detection)
    let maxVecScore = 0;
    for (const score of vecScores.values()) {
      if (score > maxVecScore) maxVecScore = score;
    }

    // Normalize BM25 relative to the strongest result for this query. FTS5
    // returns negative values where more negative is better, so callers pass
    // magnitudes; taking raw/10 flattened every real score into near-zero.
    let maxBm25 = 0;
    for (const score of bm25Results.values()) {
      maxBm25 = Math.max(maxBm25, Math.abs(score));
    }

    for (const node of candidates) {
      // 1. BM25 lexical score (normalized to [0, 1])
      const bm25Raw = bm25Results.get(node.id) ?? 0;
      const bm25Normalized = this.normalizeBm25(bm25Raw, maxBm25);

      // 2. Vector semantic similarity
      const vecScore = vecScores.get(node.id) ?? 0;

      // 3. Graph topology connectivity
      const graphScore = this.computeGraphScore(node.id, graphLinks, vecScores, maxVecScore);

      // Composite score via dynamic intent weights
      let composite = wBm25 * bm25Normalized + wVec * vecScore + wGraph * graphScore;

      // Active development boost
      if (modifiedIds.has(node.id) || (node.filePath && modifiedIds.has(node.filePath))) {
        composite = Math.min(1.0, ACTIVE_DEVELOPMENT_BOOST * composite);
      }

      // Cluster key resolution for Bi-Level clustering
      const clusterKey = this.resolveClusterKey(node);

      const marginalGain = (composite * 0.25) / Math.max(1, node.tokL0);

      const proofEntry: NodeProofEntry = {
        nodeId: node.id,
        name: node.name,
        clusterKey,
        bm25Raw,
        bm25Norm: bm25Normalized,
        vecScore,
        graphScore,
        compositeScore: composite,
        intentWeights: intentAnalysis.weights,
        marginalGain,
        chosenLevel: 0,
        status: 'INCLUDED',
        decisionFactor: `Intent=${intentAnalysis.intent} (bm25:${wBm25.toFixed(2)}, vec:${wVec.toFixed(2)}, graph:${wGraph.toFixed(2)})`
      };

      scored.push({
        node,
        level: 0 as const,
        score: composite,
        bm25Score: bm25Normalized,
        vecScore,
        graphScore,
        costTokens: node.tokL0,
        marginalGain,
        reason: this.buildReason(node, composite, bm25Normalized, vecScore, graphScore, intentAnalysis.intent),
        clusterKey,
        proofEntry
      });
    }

    return scored.sort((a, b) => b.score - a.score);
  }

  private resolveClusterKey(node: NodeRecord): string {
    if (node.subsystem && node.subsystem.trim().length > 0) {
      return `subsystem:${node.subsystem}`;
    }
    if (node.filePath) {
      const parts = node.filePath.replace(/\\/g, '/').split('/');
      if (parts.length > 1) {
        return `module:${parts[0] === '.' ? parts[1] : parts[0]}`;
      }
      return `file:${node.filePath}`;
    }
    return `tree:${node.tree}`;
  }

  private normalizeBm25(rawScore: number, maxScore: number): number {
    if (maxScore <= 0) return 0;
    return Math.min(1.0, Math.abs(rawScore) / maxScore);
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
    graph: number,
    intent: QueryIntent
  ): string {
    const parts: string[] = [];
    if (bm25 > 0.25) parts.push(`bm25=${bm25.toFixed(2)}`);
    if (vec > 0.25) parts.push(`vec=${vec.toFixed(2)}`);
    if (graph > 0) parts.push(`graph=${graph.toFixed(1)}`);
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `Relevance ${composite.toFixed(2)} [${intent}]${detail} | ${node.kind} ${node.name}`;
  }
}
