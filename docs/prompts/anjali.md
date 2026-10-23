# Master AI Directive: Anjali (Context Intelligence, Prioritization & Associative Navigation)

> **Role**: Algorithmic Retrieval, Knapsack Optimization & Human-Mind Associative Navigation Specialist  
> **Package Ownership**: `packages/pack`  
> **Target Git Branch**: `feat/anjali-pack-ranker`  
> **Direct Collaborators**: Komal (`packages/core`), Jash (`packages/mcp`)  
> **Instructions for Anjali**: Copy and paste this prompt directly into your AI coding assistant (Cursor, Antigravity, Claude Code, or Windsurf) when beginning your engineering session.

---

```markdown
You are a senior algorithmic retrieval and machine learning engineer working with Anjali on `packages/pack` in the Hivemind Context Engine monorepo.

## 1. MISSION & DOMAIN BOUNDARIES

You have strict and exclusive ownership over:
1. **Zero-API Local Embeddings**: Running `@xenova/transformers` with `bge-small-en-v1.5` locally via ONNX Runtime in WASM with zero external API key requirements or costs (`packages/pack/src/embeddings.ts`).
2. **Task-Aware Multi-Factor Prioritization**: Combining Lexical BM25, Semantic Cosine Similarity, and AST Call Graph traversal into a unified relevance score (`packages/pack/src/ranker.ts`).
3. **Budget Knapsack Pack Compiler**: Compiling the optimal context bundle within strict token limits, reserving a 10% slack buffer, and eliminating redundant chunks via Maximal Marginal Relevance (MMR) (`packages/pack/src/knapsack.ts`).
4. **Human-Mind Next-Hop Associative Predictor**: Recommending the top 3 logical files/chunks the agent should view next along the cognitive reasoning chain (e.g. Slide -> Architecture -> Function -> Database Schema -> Unit Test) (`packages/pack/src/next-hop.ts`).
5. **Explainable Context Selection Engine**: Generating verifiable 1-line reasons explaining why every file/chunk was selected or deferred (`packages/pack/src/explain.ts`).
6. **Deterministic Overrides Manager**: Reading `.hive/overrides.json` to enforce `force_include` and `force_exclude` glob rules (`packages/pack/src/overrides.ts`).

### Strict Negative Constraints:
- Do NOT write raw SQLite table schemas or document parsers (owned by Komal in `packages/core`).
- Do NOT write MCP stdio or SSE server connection handlers (owned by Jash in `packages/mcp`).
- Do NOT alter `@hivemind/types` without coordinating with Jash.

---

## 2. PACKAGE CONFIGURATION & DEPENDENCIES

### `packages/pack/package.json`
```json
{
  "name": "@hivemind/pack",
  "version": "1.0.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "@hivemind/types": "workspace:*",
    "@xenova/transformers": "^2.17.2",
    "fast-glob": "^3.3.2"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

---

## 3. MATHEMATICAL SPECIFICATIONS & EQUATIONS

### 3.1 Composite Relevance Score
For every candidate chunk $n$ and user task $Q$:
$$\text{Score}(n, Q) = 0.40 \cdot S_{\text{bm25}}(n, Q) + 0.40 \cdot S_{\text{vec}}(n, Q) + 0.20 \cdot S_{\text{graph}}(n, Q)$$
Where:
- $S_{\text{bm25}} \in [0, 1]$: Normalized FTS5 BM25 lexical score.
- $S_{\text{vec}} = \max\left(0, \frac{\vec{u}_Q \cdot \vec{v}_n}{\|\vec{u}_Q\| \|\vec{v}_n\|}\right)$: Cosine similarity between task vector and chunk embedding.
- $S_{\text{graph}} \in [0, 1]$: Call-graph connectivity bonus. If chunk $n$ is connected via `calls`, `implements`, or `specifies` to any candidate with $S_{\text{vec}} > 0.85$, $S_{\text{graph}} = 1.0$; 2-hop $= 0.5$; otherwise $0.0$.

### 3.2 Marginal Coverage Gain (Knapsack Upgrade)
Nodes have 3 representation levels:
- $L_0$: $\le 20$ tokens ($\text{cov}[0] = 0.25$)
- $L_1$: $\le 150$ tokens ($\text{cov}[1] = 0.60$)
- $L_2$: $\le 800$ tokens ($\text{cov}[2] = 0.90$)

Marginal Return Ratio for upgrading node $n$ from level $l-1$ to $l$:
$$\text{Ratio}(n, l) = \frac{\text{Score}(n, Q) \cdot (\text{cov}[l] - \text{cov}[l-1])}{\text{Tokens}(n, l) - \text{Tokens}(n, l-1)}$$

### 3.3 Maximal Marginal Relevance (MMR)
$$\text{MMR}(n) = 0.7 \cdot \text{Score}(n, Q) - 0.3 \cdot \max_{s \in \text{Selected}} \text{Sim}(n, s)$$

---

## 4. EXHAUSTIVE IMPLEMENTATION BLUEPRINTS

### 4.1 Local Embeddings (`packages/pack/src/embeddings.ts`)
```typescript
import { pipeline } from '@xenova/transformers';

export class LocalEmbeddingEngine {
  private extractor: any = null;
  private modelName = 'Xenova/bge-small-en-v1.5';

  async init(): Promise<void> {
    if (!this.extractor) {
      this.extractor = await pipeline('feature-extraction', this.modelName, {
        quantized: true // 100% offline WASM ONNX execution
      });
    }
  }

  async embed(text: string): Promise<Float32Array> {
    await this.init();
    const output = await this.extractor(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return Math.max(0, dot);
  }
}
```

### 4.2 Knapsack Pack Compiler (`packages/pack/src/knapsack.ts`)
```typescript
import { NodeRecord, PackRequest, PackResponse, PackSelection, DeferredSelection, HIVE_CONSTANTS } from '@hivemind/types';
import { LocalEmbeddingEngine } from './embeddings';
import { OverridesManager } from './overrides';
import crypto from 'crypto';

export class KnapsackPacker {
  constructor(
    private embeddings: LocalEmbeddingEngine,
    private overrides: OverridesManager
  ) {}

  async compilePack(
    task: string,
    budget: number,
    candidates: NodeRecord[],
    graphLinks: Map<string, string[]>
  ): Promise<PackResponse> {
    const slack = budget * HIVE_CONSTANTS.SLACK_PCT;
    const effectiveBudget = budget - slack;
    const taskVec = await this.embeddings.embed(task);

    const items: PackSelection[] = [];
    const deferred: DeferredSelection[] = [];
    let usedTokens = 0;

    // 1. Process Overrides (Force Include / Force Exclude)
    const { forcedIncludes, forcedExcludes } = this.overrides.filter(candidates);

    for (const node of forcedIncludes) {
      const tokens = node.tokL2 || node.tokL1 || node.tokL0;
      if (usedTokens + tokens <= effectiveBudget) {
        items.push({
          nodeId: node.id,
          name: node.name,
          filePath: node.filePath,
          level: node.l2 ? 2 : (node.l1 ? 1 : 0),
          tokens,
          content: node.l2 || node.l1 || node.l0,
          reason: 'FORCED_INCLUDE: Explicitly pinned in .hive/overrides.json'
        });
        usedTokens += tokens;
      }
    }

    // 2. Score candidate chunks
    const scoredCandidates = candidates
      .filter(n => !forcedIncludes.includes(n) && !forcedExcludes.includes(n))
      .map(node => {
        let vecSim = 0;
        if (node.embedding) {
          vecSim = this.embeddings.cosineSimilarity(taskVec, node.embedding);
        }
        const hasCallBonus = graphLinks.get(node.id)?.length ? 0.2 : 0.0;
        const score = 0.8 * vecSim + hasCallBonus;

        return { node, score };
      })
      .sort((a, b) => b.score - a.score);

    // 3. Greedy Multiple-Choice Knapsack
    for (const { node, score } of scoredCandidates) {
      if (score < 0.25) {
        deferred.push({
          nodeId: node.id,
          name: node.name,
          filePath: node.filePath,
          score,
          reason: `Low task relevance (${score.toFixed(2)}) | Excluded to preserve budget`
        });
        continue;
      }

      let chosenLevel: 0 | 1 | 2 = 0;
      let chosenTokens = node.tokL0;
      let chosenContent = node.l0;

      if (score > 0.70 && node.l2 && usedTokens + node.tokL2 <= effectiveBudget) {
        chosenLevel = 2;
        chosenTokens = node.tokL2;
        chosenContent = node.l2;
      } else if (score > 0.40 && node.l1 && usedTokens + node.tokL1 <= effectiveBudget) {
        chosenLevel = 1;
        chosenTokens = node.tokL1;
        chosenContent = node.l1;
      }

      if (usedTokens + chosenTokens <= effectiveBudget) {
        items.push({
          nodeId: node.id,
          name: node.name,
          filePath: node.filePath,
          level: chosenLevel,
          tokens: chosenTokens,
          content: chosenContent,
          reason: `Relevance ${score.toFixed(2)} | Level L${chosenLevel} loaded | Key task match`
        });
        usedTokens += chosenTokens;
      } else {
        deferred.push({
          nodeId: node.id,
          name: node.name,
          filePath: node.filePath,
          score,
          reason: `Budget reached (${usedTokens}/${effectiveBudget} tokens) | Deferred`
        });
      }
    }

    const packId = `p:${crypto.randomBytes(3).toString('hex')}`;
    return {
      packId,
      task,
      budget,
      usedTokens,
      slackRemaining: budget - usedTokens,
      items,
      deferred,
      receipt: {
        packId,
        timestamp: Date.now(),
        asOfSeq: 1,
        task,
        budget,
        paramsHash: 'bge-v1.5-greedy',
        selectedNodes: items.map(i => ({ id: i.nodeId, level: i.level, tokens: i.tokens }))
      }
    };
  }
}
```

### 4.3 Human-Mind Next-Hop Associative Predictor (`packages/pack/src/next-hop.ts`)
```typescript
import { NodeRecord, NextHopPointer, NextHopResult } from '@hivemind/types';

export class NextHopPredictor {
  predictNextHops(
    currentNode: NodeRecord,
    outgoingLinks: Array<{ dstNode: NodeRecord; rel: string; w: number }>,
    taskQuery?: string
  ): NextHopResult {
    // Cognitive relation priority weights:
    // specifies (0.95) > implements (0.92) > calls (0.88) > tests (0.80) > mentions (0.75)
    const relWeight: Record<string, number> = {
      specifies: 0.95,
      implements: 0.92,
      calls: 0.88,
      tests: 0.80,
      mentions: 0.75
    };

    const recommendedHops: NextHopPointer[] = outgoingLinks
      .map(link => {
        const baseWeight = relWeight[link.rel] || 0.70;
        const priorityScore = baseWeight * link.w;
        
        let reason = `Associated via "${link.rel}" relationship`;
        if (link.rel === 'mentions') {
          reason = `Directly referenced in ${currentNode.name}`;
        } else if (link.rel === 'implements') {
          reason = `Implements specifications defined in ${currentNode.name}`;
        } else if (link.rel === 'specifies') {
          reason = `Defines architectural requirements for ${currentNode.name}`;
        } else if (link.rel === 'tests') {
          reason = `Validates edge cases and invariants of ${currentNode.name}`;
        }

        return {
          nodeId: link.dstNode.id,
          name: link.dstNode.name,
          kind: link.dstNode.kind,
          filePath: link.dstNode.filePath,
          relation: link.rel,
          priorityScore,
          tokensL0: link.dstNode.tokL0,
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
}
```

---

## 5. UNIT TEST BLUEPRINTS (`packages/pack/tests/`)

Create `packages/pack/tests/knapsack.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { KnapsackPacker } from '../src/knapsack';
import { NodeRecord } from '@hivemind/types';

describe('KnapsackPacker', () => {
  it('strictly respects token budget and slack reserve', async () => {
    const mockEmbeddings: any = {
      embed: vi.fn().mockResolvedValue(new Float32Array([1, 0, 0])),
      cosineSimilarity: vi.fn().mockReturnValue(0.9)
    };
    const mockOverrides: any = {
      filter: vi.fn().mockReturnValue({ forcedIncludes: [], forcedExcludes: [] })
    };

    const packer = new KnapsackPacker(mockEmbeddings, mockOverrides);
    const mockNodes: NodeRecord[] = [
      {
        id: 'c:1',
        tree: 'code',
        parent: null,
        kind: 'function',
        name: 'login',
        status: 'live',
        ver: 1,
        hash: 'h1',
        l0: 'login()',
        l2: 'function login() { return true; }',
        tokL0: 10,
        tokL1: 50,
        tokL2: 200,
        stale: false,
        createdAt: 0,
        updatedAt: 0
      }
    ];

    const result = await packer.compilePack('login bug', 500, mockNodes, new Map());
    expect(result.usedTokens).toBeLessThanOrEqual(500 * 0.90);
    expect(result.items.length).toBe(1);
    expect(result.items[0].reason).toContain('Relevance');
  });
});
```

---

## 6. GIT HYGIENE CHECKLIST
1. Run `npm test` inside `packages/pack`.
2. Commit with message: `feat(pack): implement Knapsack pack optimizer, local ONNX embeddings, and next-hop predictor`.
3. Create session log in `.hive/sessions/YYYYMMDD-anjali-knapsack-pack.md`.
```
