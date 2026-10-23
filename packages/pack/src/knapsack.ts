import crypto from 'crypto';
import {
  NodeRecord,
  PackRequest,
  PackResponse,
  PackSelection,
  DeferredSelection,
  TaskCandidate,
  LinkRelation,
  HIVE_CONSTANTS,
  ClusterBudgetAllocation,
  PackProofMatrix,
  NodeProofEntry,
  IntentAnalysis
} from '@hivemind/types';
import { LocalEmbeddingEngine } from './embeddings';
import { OverridesManager } from './overrides';
import { RelevanceRanker } from './ranker';

/**
 * Bi-Level Clustered Budget Knapsack Pack Compiler
 *
 * Architecture:
 * 1. Global Level: Partitions candidate chunks into architectural clusters (subsystems / modules).
 *    Allocates budget proportional to aggregate cluster relevance mass with anti-starvation bounds.
 * 2. Local Level: Solves greedy multiple-choice knapsack per cluster, applying MMR diversity
 *    and marginal coverage upgrade ratios (L0 -> L1 -> L2).
 * 3. Slack & Sweep: Rolls unused cluster quotas into a secondary sweep for top cross-module nodes.
 * 4. Audit & Verification: Emits full numerical proof matrix alongside clean 1-line reasons.
 */

const TOKENS_PER_LEVEL = [20, 150, 800]; // L0, L1, L2 max tokens
const MMR_LAMBDA = 0.70;

export class KnapsackPacker {
  constructor(
    private embeddings: LocalEmbeddingEngine,
    private overrides: OverridesManager,
    private ranker: RelevanceRanker
  ) {}

  async compilePack(
    request: PackRequest,
    candidates: NodeRecord[],
    graphLinks: Map<string, Array<{ dst: string; rel: LinkRelation }>>,
    bm25Results: Map<string, number>,
    modifiedIds: Set<string> = new Set(),
    externalVecScores?: Map<string, number>
  ): Promise<PackResponse> {
    const slack = request.budget * (request.slackPct ?? HIVE_CONSTANTS.SLACK_PCT);
    const effectiveBudget = request.budget - slack;
    const taskQuery = request.task;

    const items: PackSelection[] = [];
    const deferred: DeferredSelection[] = [];
    const proofEntries: NodeProofEntry[] = [];
    let usedTokens = 0;
    const selectedNodeIds = new Set<string>();

    const candidateMap = new Map(candidates.map(n => [n.id, n]));

    // 1. Process Overrides (Force Include / Force Exclude)
    const { forcedIncludes, forcedExcludes } = this.overrides.filter(candidates);

    for (const node of forcedIncludes) {
      if (usedTokens >= effectiveBudget) break;
      const bestLevel = this.selectBestLevel(node, effectiveBudget - usedTokens, 1.0);
      if (bestLevel.level === -1) {
        const reason = `FORCED_INCLUDE but budget too tight (${usedTokens}/${effectiveBudget})`;
        deferred.push({
          nodeId: node.id,
          name: node.name,
          filePath: node.filePath,
          score: 1.0,
          reason,
          clusterKey: 'override:forced_include'
        });
        proofEntries.push({
          nodeId: node.id,
          name: node.name,
          clusterKey: 'override:forced_include',
          bm25Raw: 0,
          bm25Norm: 0,
          vecScore: 0,
          graphScore: 0,
          compositeScore: 1.0,
          intentWeights: { bm25: 0, vector: 0, graph: 0 },
          marginalGain: 0,
          chosenLevel: -1,
          status: 'DEFERRED',
          decisionFactor: reason
        });
        continue;
      }

      items.push({
        nodeId: node.id,
        name: node.name,
        subsystem: node.subsystem,
        filePath: node.filePath,
        level: bestLevel.level,
        tokens: bestLevel.tokens,
        content: bestLevel.content,
        reason: 'FORCED_INCLUDE: Explicitly pinned in .hive/overrides.json',
        clusterKey: 'override:forced_include'
      });
      usedTokens += bestLevel.tokens;
      selectedNodeIds.add(node.id);

      proofEntries.push({
        nodeId: node.id,
        name: node.name,
        clusterKey: 'override:forced_include',
        bm25Raw: 0,
        bm25Norm: 0,
        vecScore: 0,
        graphScore: 0,
        compositeScore: 1.0,
        intentWeights: { bm25: 0, vector: 0, graph: 0 },
        marginalGain: 1.0,
        chosenLevel: bestLevel.level,
        status: 'FORCED_INCLUDED',
        decisionFactor: 'FORCED_INCLUDE via overrides.json'
      });
    }

    // Record forced excludes in proof log
    for (const node of forcedExcludes) {
      deferred.push({
        nodeId: node.id,
        name: node.name,
        filePath: node.filePath,
        score: 0.0,
        reason: 'FORCED_EXCLUDE: Explicitly excluded in .hive/overrides.json',
        clusterKey: 'override:forced_exclude'
      });
      proofEntries.push({
        nodeId: node.id,
        name: node.name,
        clusterKey: 'override:forced_exclude',
        bm25Raw: 0,
        bm25Norm: 0,
        vecScore: 0,
        graphScore: 0,
        compositeScore: 0,
        intentWeights: { bm25: 0, vector: 0, graph: 0 },
        marginalGain: 0,
        chosenLevel: -1,
        status: 'FORCED_EXCLUDED',
        decisionFactor: 'FORCED_EXCLUDE via overrides.json'
      });
    }

    // 2. Score Normal Candidates via Adaptive Intent Ranker
    const normalCandidates = candidates.filter(
      n => !forcedIncludes.some(fi => fi.id === n.id) && !forcedExcludes.some(fe => fe.id === n.id)
    );

    const intentAnalysis: IntentAnalysis = this.ranker.classifyIntent(taskQuery);
    const scoredCandidates = await this.ranker.scoreCandidates(
      normalCandidates,
      taskQuery,
      bm25Results,
      graphLinks,
      modifiedIds,
      externalVecScores
    );

    // 3. Bi-Level Step 1: Cluster Candidate Chunks
    const clusterMap = new Map<string, TaskCandidate[]>();
    for (const cand of scoredCandidates) {
      const cKey = cand.clusterKey ?? 'module:general';
      if (!clusterMap.has(cKey)) {
        clusterMap.set(cKey, []);
      }
      clusterMap.get(cKey)!.push(cand);
    }

    // Compute cluster relevance mass
    const clusterAllocations: ClusterBudgetAllocation[] = [];
    const availableBudgetForClusters = Math.max(0, effectiveBudget - usedTokens);

    let totalClusterScoreMass = 0;
    const clusterScores = new Map<string, number>();
    for (const [key, cands] of clusterMap.entries()) {
      const mass = cands.reduce((sum, c) => sum + Math.max(0.05, c.score), 0);
      clusterScores.set(key, mass);
      totalClusterScoreMass += mass;
    }

    // Allocate token budgets per cluster with upper cap (75%) to prevent starvation
    const clusterBudgets = new Map<string, number>();
    for (const [key, cands] of clusterMap.entries()) {
      const mass = clusterScores.get(key) ?? 1;
      const proportion = totalClusterScoreMass > 0 ? mass / totalClusterScoreMass : 1 / clusterMap.size;
      const cappedProportion = Math.min(0.75, proportion);
      const allocatedTokens = Math.floor(availableBudgetForClusters * cappedProportion);
      clusterBudgets.set(key, allocatedTokens);

      clusterAllocations.push({
        clusterKey: key,
        allocatedTokens,
        usedTokens: 0,
        candidateCount: cands.length,
        selectedCount: 0
      });
    }

    // 4. Bi-Level Step 2: Local Knapsack Optimization within each cluster
    const clusterAllocMap = new Map(clusterAllocations.map(a => [a.clusterKey, a]));
    const deferredInClusters: TaskCandidate[] = [];

    for (const [key, cands] of clusterMap.entries()) {
      const clusterBudget = clusterBudgets.get(key) ?? 0;
      const allocRecord = clusterAllocMap.get(key)!;
      let clusterUsedTokens = 0;

      // Apply MMR diversity inside cluster
      const scoredWithMmr = cands.map(candidate => {
        let maxSim = 0;
        for (const selectedId of selectedNodeIds) {
          const selectedNode = candidateMap.get(selectedId);
          if (selectedNode) {
            const sim = this.computeSimilarity(candidate.node, selectedNode);
            if (sim > maxSim) maxSim = sim;
          }
        }
        const mmrScore = MMR_LAMBDA * candidate.score - (1 - MMR_LAMBDA) * maxSim;
        return { ...candidate, score: mmrScore };
      });

      scoredWithMmr.sort((a, b) => b.score - a.score);

      for (const candidate of scoredWithMmr) {
        if (candidate.score < 0.20) {
          const reason = `Low task relevance (${candidate.score.toFixed(2)}) | Excluded to preserve budget`;
          deferred.push({
            nodeId: candidate.node.id,
            name: candidate.node.name,
            filePath: candidate.node.filePath,
            score: candidate.score,
            reason,
            clusterKey: key
          });
          if (candidate.proofEntry) {
            candidate.proofEntry.status = 'DEFERRED';
            candidate.proofEntry.chosenLevel = -1;
            candidate.proofEntry.decisionFactor = reason;
            proofEntries.push(candidate.proofEntry);
          }
          continue;
        }

        const remainingClusterBudget = clusterBudget - clusterUsedTokens;
        const remainingGlobalBudget = effectiveBudget - usedTokens;
        const localBudgetLimit = Math.min(remainingClusterBudget, remainingGlobalBudget);

        const bestLevel = this.selectBestLevel(candidate.node, localBudgetLimit, candidate.score);

        if (bestLevel.level === -1) {
          // Defer for now, but save for secondary global sweep if remainingGlobalBudget allows
          deferredInClusters.push(candidate);
          continue;
        }

        items.push({
          nodeId: candidate.node.id,
          name: candidate.node.name,
          subsystem: candidate.node.subsystem,
          filePath: candidate.node.filePath,
          level: bestLevel.level,
          tokens: bestLevel.tokens,
          content: bestLevel.content,
          reason: `${candidate.reason} | L${bestLevel.level} [Cluster: ${key}]`,
          clusterKey: key
        });

        usedTokens += bestLevel.tokens;
        clusterUsedTokens += bestLevel.tokens;
        allocRecord.usedTokens += bestLevel.tokens;
        allocRecord.selectedCount++;
        selectedNodeIds.add(candidate.node.id);

        if (candidate.proofEntry) {
          candidate.proofEntry.status = 'INCLUDED';
          candidate.proofEntry.chosenLevel = bestLevel.level;
          candidate.proofEntry.decisionFactor = `Selected in ${key} at L${bestLevel.level} (${bestLevel.tokens} tok)`;
          proofEntries.push(candidate.proofEntry);
        }
      }
    }

    // 5. Global Sweep: Use any unconsumed cluster budget for top deferred candidates
    deferredInClusters.sort((a, b) => b.score - a.score);
    for (const candidate of deferredInClusters) {
      if (selectedNodeIds.has(candidate.node.id)) continue;

      const remainingGlobalBudget = effectiveBudget - usedTokens;
      const bestLevel = this.selectBestLevel(candidate.node, remainingGlobalBudget, candidate.score);

      if (bestLevel.level === -1) {
        const reason = `Cluster budget exhausted & global budget reached (${usedTokens}/${effectiveBudget} tokens)`;
        deferred.push({
          nodeId: candidate.node.id,
          name: candidate.node.name,
          filePath: candidate.node.filePath,
          score: candidate.score,
          reason,
          clusterKey: candidate.clusterKey
        });
        if (candidate.proofEntry) {
          candidate.proofEntry.status = 'DEFERRED';
          candidate.proofEntry.chosenLevel = -1;
          candidate.proofEntry.decisionFactor = reason;
          proofEntries.push(candidate.proofEntry);
        }
      } else {
        items.push({
          nodeId: candidate.node.id,
          name: candidate.node.name,
          subsystem: candidate.node.subsystem,
          filePath: candidate.node.filePath,
          level: bestLevel.level,
          tokens: bestLevel.tokens,
          content: bestLevel.content,
          reason: `${candidate.reason} | L${bestLevel.level} [Global Sweep]`,
          clusterKey: candidate.clusterKey
        });

        usedTokens += bestLevel.tokens;
        selectedNodeIds.add(candidate.node.id);

        const alloc = clusterAllocMap.get(candidate.clusterKey ?? '');
        if (alloc) {
          alloc.usedTokens += bestLevel.tokens;
          alloc.selectedCount++;
        }

        if (candidate.proofEntry) {
          candidate.proofEntry.status = 'INCLUDED';
          candidate.proofEntry.chosenLevel = bestLevel.level;
          candidate.proofEntry.decisionFactor = `Selected in Global Sweep at L${bestLevel.level} (${bestLevel.tokens} tok)`;
          proofEntries.push(candidate.proofEntry);
        }
      }
    }

    const packId = `p:${crypto.randomBytes(3).toString('hex')}`;
    const proofMatrix: PackProofMatrix = {
      intentAnalysis,
      clusterAllocations,
      proofEntries
    };

    return {
      packId,
      task: taskQuery,
      budget: request.budget,
      usedTokens,
      slackRemaining: request.budget - usedTokens,
      items,
      deferred,
      intent: intentAnalysis,
      clusters: clusterAllocations,
      proofMatrix,
      receipt: {
        packId,
        timestamp: Date.now(),
        asOfSeq: 1,
        task: taskQuery,
        budget: request.budget,
        paramsHash: 'bge-v1.5-bilevel-cluster-mmr',
        selectedNodes: items.map(i => ({ id: i.nodeId, level: i.level, tokens: i.tokens }))
      }
    };
  }

  private selectBestLevel(
    node: NodeRecord,
    remainingBudget: number,
    score: number
  ): { level: 0 | 1 | 2; tokens: number; content: string } | { level: -1 } {
    if (score > 0.70 && node.l2) {
      const l2Tokens = Math.min(TOKENS_PER_LEVEL[2], node.tokL2 || 800);
      if (l2Tokens <= remainingBudget) {
        return { level: 2 as const, tokens: l2Tokens, content: node.l2 };
      }
    }

    if (score > 0.35 && node.l1) {
      const l1Tokens = Math.min(TOKENS_PER_LEVEL[1], node.tokL1 || 150);
      if (l1Tokens <= remainingBudget) {
        return { level: 1 as const, tokens: l1Tokens, content: node.l1 };
      }
    }

    if (node.l0) {
      const l0Tokens = Math.min(TOKENS_PER_LEVEL[0], node.tokL0 || 20);
      if (l0Tokens <= remainingBudget) {
        return { level: 0 as const, tokens: l0Tokens, content: node.l0 };
      }
    }

    return { level: -1 as const };
  }

  private computeSimilarity(a: NodeRecord, b: NodeRecord): number {
    const aText = `${a.name} ${a.l0} ${a.l1 ?? ''} ${a.l2 ?? ''}`.toLowerCase();
    const bText = `${b.name} ${b.l0} ${b.l1 ?? ''} ${b.l2 ?? ''}`.toLowerCase();

    const aWords = new Set(aText.split(/\s+/).filter(w => w.length > 3));
    const bWords = new Set(bText.split(/\s+/).filter(w => w.length > 3));

    let intersection = 0;
    for (const word of aWords) {
      if (bWords.has(word)) intersection++;
    }

    const union = new Set([...aWords, ...bWords]);
    if (union.size === 0) return 0;
    return intersection / union.size;
  }
}
