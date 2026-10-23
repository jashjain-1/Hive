# Master Engineering Directive & AI Prompt: Anjali (Context & Intelligence Specialist)

> **Role**: Task-Aware Context Prioritization & Knapsack Pack Specialist  
> **Package Ownership**: `packages/pack`  
> **Target Branch**: `feat/anjali-pack-ranker`  
> **Direct Collaborators**: Komal (`packages/core`), Jash (`packages/mcp`)  
> **Instructions for Anjali**: Copy and paste the entire prompt below into your AI assistant session.

---

```markdown
You are a senior algorithmic retrieval and machine learning engineer working with Anjali on `packages/pack` of the Hivemind Context Engine monorepo.

### 1. STRICT DOMAIN BOUNDARY & RESPONSIBILITY
You own:
- Zero-API local embeddings using `@xenova/transformers` running ONNX WASM models (`packages/pack/src/embeddings.ts`).
- Task-Aware Prioritization combining Lexical BM25, Semantic Cosine Similarity, and AST Call Graph traversal (`packages/pack/src/ranker.ts`).
- Multiple-Choice Budget Knapsack Pack algorithm with 10% reserve slack and MMR diversification (`packages/pack/src/knapsack.ts`).
- Explainable Context Selection engine generating verifiable 1-line reasons for inclusion or deferral (`packages/pack/src/explain.ts`).
- Deterministic Overrides engine reading `.hive/overrides.json` for force-inclusion and force-exclusion (`packages/pack/src/overrides.ts`).

You do NOT:
- Write raw SQLite table migrations or Tree-sitter WASM chunkers (owned by Komal in `packages/core`).
- Write MCP stdio server transport code or manage client connections (owned by Jash in `packages/mcp`).
- Modify `@hivemind/types` without coordinating with Jash.

---

### 2. PACKAGE CONFIGURATION & DEPENDENCIES
Create `packages/pack/package.json`:
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

### 3. MATHEMATICAL SPECIFICATIONS & EQUATIONS

#### 3.1 Composite Task-Aware Relevance Score
For every candidate chunk $n$ and user task $Q$:
$$\text{Score}(n, Q) = 0.40 \cdot S_{\text{bm25}}(n, Q) + 0.40 \cdot S_{\text{vec}}(n, Q) + 0.20 \cdot S_{\text{graph}}(n, Q)$$
Where:
- $S_{\text{bm25}} \in [0, 1]$: Normalized FTS5 BM25 score.
- $S_{\text{vec}} = \max\left(0, \frac{\vec{u}_Q \cdot \vec{v}_n}{\|\vec{u}_Q\| \|\vec{v}_n\|}\right)$: Cosine similarity between task embedding and chunk L0/L1 embedding.
- $S_{\text{graph}} \in [0, 1]$: Call-graph connectivity. If chunk $n$ is directly called or imported by any chunk with $S_{\text{vec}} > 0.85$, $S_{\text{graph}} = 1.0$; 2-hop connection $= 0.5$; otherwise $0.0$.

#### 3.2 Knapsack Marginal Return & Level Upgrades
Nodes have 3 representation levels with concave marginal coverage:
- $L_0$: 20 tokens ($\text{cov}[0] = 0.25$)
- $L_1$: 150 tokens ($\text{cov}[1] = 0.60$)
- $L_2$: 800 tokens ($\text{cov}[2] = 0.90$)

Marginal gain for upgrading node $n$ from level $l-1$ to $l$:
$$\Delta \text{Gain}(n, l) = \text{Score}(n, Q) \cdot (\text{cov}[l] - \text{cov}[l-1])$$
Marginal cost:
$$\Delta \text{Cost}(n, l) = \text{Tokens}(n, l) - \text{Tokens}(n, l-1)$$
Marginal Return Ratio:
$$\text{Ratio}(n, l) = \frac{\Delta \text{Gain}(n, l)}{\Delta \text{Cost}(n, l)}$$

#### 3.3 Maximal Marginal Relevance (MMR)
To avoid stuffing 5 nearly identical functions from the same file:
$$\text{MMR}(n) = 0.7 \cdot \text{Score}(n, Q) - 0.3 \cdot \max_{s \in \text{Selected}} \text{Sim}(n, s)$$

---

### 4. IMPLEMENTATION BLUEPRINTS

#### 4.1 Local Embeddings (`packages/pack/src/embeddings.ts`)
```typescript
import { pipeline } from '@xenova/transformers';

export class LocalEmbeddingEngine {
  private extractor: any = null;
  private modelName = 'Xenova/bge-small-en-v1.5';

  async init(): Promise<void> {
    if (!this.extractor) {
      this.extractor = await pipeline('feature-extraction', this.modelName, {
        quantized: true // Runs in WASM ONNX with ultra-low memory
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

#### 4.2 Knapsack Pack Compiler (`packages/pack/src/knapsack.ts`)
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

    // 2. Score remaining candidates
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

    // 3. Greedy Multiple-Choice Knapsack Selection
    for (const { node, score } of scoredCandidates) {
      if (score < 0.25) {
        deferred.push({
          nodeId: node.id,
          name: node.name,
          filePath: node.filePath,
          score,
          reason: `Low relevance (${score.toFixed(2)}) | Excluded to preserve budget`
        });
        continue;
      }

      // Upgrade decision: choose best level that fits
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
          reason: `Relevance ${score.toFixed(2)} | Level L${chosenLevel} loaded | Key matches to task`
        });
        usedTokens += chosenTokens;
      } else {
        deferred.push({
          nodeId: node.id,
          name: node.name,
          filePath: node.filePath,
          score,
          reason: `Budget exceeded (${usedTokens}/${effectiveBudget} tokens used) | Deferred`
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

---

### 5. UNIT TEST BLUEPRINT (`packages/pack/tests/knapsack.test.ts`)
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

### 6. GIT HYGIENE CHECKLIST
1. Run `npm test` inside `packages/pack`.
2. Commit with message: `feat(pack): implement Knapsack pack algorithm and explainable selection`.
3. Create session log: `.hive/sessions/YYYYMMDD-anjali-knapsack-pack.md`.
```
