import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Stub the ONNX pipeline so the pack algorithms are tested deterministically and
// without downloading models or loading the optional native `sharp` dependency.
vi.mock('@xenova/transformers', () => {
  const DIM = 16;
  const extractor = async (text: string) => {
    const data = new Float32Array(DIM);
    for (let i = 0; i < text.length; i++) {
      data[text.charCodeAt(i) % DIM] += 1;
    }
    return { data };
  };
  return {
    env: { allowLocalModels: true, allowRemoteModels: false },
    pipeline: vi.fn(async () => extractor)
  };
});

import {
  LocalEmbeddingEngine,
  RelevanceRanker,
  KnapsackPacker,
  NextHopPredictor,
  OverridesManager,
  ExplainEngine
} from '../src';
import { NodeRecord, LinkRelation, PackRequest } from '@hivemind/types';

describe('@hivemind/pack - Architectural Test Suite (Anjali)', () => {
  let embeddingEngine: LocalEmbeddingEngine;
  let ranker: RelevanceRanker;
  let overrides: OverridesManager;
  let packer: KnapsackPacker;
  let nextHop: NextHopPredictor;
  let explain: ExplainEngine;

  beforeAll(async () => {
    embeddingEngine = new LocalEmbeddingEngine();
    ranker = new RelevanceRanker(embeddingEngine);
    // Isolate override persistence so test runs do not create files in the package.
    overrides = new OverridesManager(mkdtempSync(join(tmpdir(), 'hive-pack-test-')));
    packer = new KnapsackPacker(embeddingEngine, overrides, ranker);
    nextHop = new NextHopPredictor();
    explain = new ExplainEngine(overrides);
  }, 60000);

  describe('1. Query Intent Classification & Adaptive Weighting', () => {
    it('classifies code identifiers and filenames as lexical intent with w_bm25=0.65', () => {
      const result = ranker.classifyIntent('Fix verifyJwt() in auth.ts');
      expect(result.intent).toBe('lexical');
      expect(result.weights.bm25).toBe(0.65);
      expect(result.weights.vector).toBe(0.20);
      expect(result.detectedSymbols).toContain('verifyJwt()');
    });

    it('classifies blast radius, callers, and dependencies as relational intent with w_graph=0.50', () => {
      const result = ranker.classifyIntent('Trace all callers of handleRequest and assess blast radius');
      expect(result.intent).toBe('relational');
      expect(result.weights.graph).toBe(0.50);
      expect(result.weights.vector).toBe(0.30);
    });

    it('classifies architectural and conceptual questions as semantic intent with w_vec=0.65', () => {
      const result = ranker.classifyIntent('How does the authentication and session pipeline architecture work');
      expect(result.intent).toBe('semantic');
      expect(result.weights.vector).toBe(0.65);
      expect(result.weights.bm25).toBe(0.15);
    });
  });

  describe('2. Bi-Level Clustered Knapsack Pack Compiler', () => {
    const mockNodes: NodeRecord[] = [
      {
        id: 'c:auth_jwt',
        tree: 'code',
        parent: 'c:auth_file',
        kind: 'function',
        name: 'verifyJwt',
        subsystem: 'auth',
        filePath: 'packages/core/src/auth.ts',
        status: 'live',
        ver: 1,
        hash: 'hash1',
        l0: 'function verifyJwt(token: string): boolean',
        l1: 'Verifies JWT signature and claims against HMAC secret',
        l2: 'export function verifyJwt(token: string): boolean {\n  return jwt.verify(token, secret);\n}',
        tokL0: 10,
        tokL1: 30,
        tokL2: 120,
        stale: false,
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        id: 'c:auth_login',
        tree: 'code',
        parent: 'c:auth_file',
        kind: 'function',
        name: 'loginUser',
        subsystem: 'auth',
        filePath: 'packages/core/src/auth.ts',
        status: 'live',
        ver: 1,
        hash: 'hash2',
        l0: 'function loginUser(req: Request): Response',
        l1: 'Authenticates user credentials and signs session token',
        l2: 'export function loginUser(req: Request): Response {\n  const user = db.find(req.user);\n  return sign(user);\n}',
        tokL0: 12,
        tokL1: 35,
        tokL2: 140,
        stale: false,
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        id: 'c:db_schema',
        tree: 'code',
        parent: 'c:db_file',
        kind: 'class',
        name: 'DatabaseEngine',
        subsystem: 'storage',
        filePath: 'packages/core/src/db.ts',
        status: 'live',
        ver: 1,
        hash: 'hash3',
        l0: 'class DatabaseEngine',
        l1: 'SQLite WAL connection pool and schema manager',
        l2: 'export class DatabaseEngine {\n  constructor(private db: BetterSqlite3.Database) {}\n}',
        tokL0: 8,
        tokL1: 25,
        tokL2: 110,
        stale: false,
        createdAt: 1000,
        updatedAt: 1000
      }
    ];

    it('allocates budget across clusters and compiles within budget while reserving 10% slack', async () => {
      const bm25Map = new Map<string, number>([
        ['c:auth_jwt', 9.5],
        ['c:auth_login', 7.0],
        ['c:db_schema', 2.0]
      ]);

      const graphLinks = new Map<string, Array<{ dst: string; rel: LinkRelation }>>([
        ['c:auth_jwt', [{ dst: 'c:auth_login', rel: 'calls' }]]
      ]);

      const req: PackRequest = {
        task: 'Fix JWT signature verification in verifyJwt',
        budget: 500,
        slackPct: 0.10
      };

      const pack = await packer.compilePack(req, mockNodes, graphLinks, bm25Map);

      expect(pack.usedTokens).toBeLessThanOrEqual(450); // 500 - 10% slack = 450
      expect(pack.slackRemaining).toBeGreaterThanOrEqual(50);
      expect(pack.items.length).toBeGreaterThanOrEqual(1);

      // Verify auth cluster was included
      const authItem = pack.items.find(i => i.nodeId === 'c:auth_jwt');
      expect(authItem).toBeDefined();

      // Verify Proof Matrix & Cluster Allocations are emitted
      expect(pack.clusters).toBeDefined();
      expect(pack.proofMatrix).toBeDefined();
      expect(pack.proofMatrix?.clusterAllocations.length).toBeGreaterThan(0);
      expect(pack.proofMatrix?.proofEntries.length).toBeGreaterThanOrEqual(mockNodes.length);

      // Test Proof Matrix formatting
      const formatted = explain.formatProofMatrix(pack.proofMatrix!);
      expect(formatted).toContain('=== HIVE CONTEXT PACK PROOF MATRIX ===');
      expect(formatted).toContain('Cluster Allocations:');
    });
  });

  describe('3. Cognitive Multi-Hop Trail Guider', () => {
    const nodeA: NodeRecord = {
      id: 'd:spec_auth',
      tree: 'knowledge',
      parent: null,
      kind: 'document',
      name: 'AuthPRD.md',
      status: 'live',
      ver: 1,
      hash: 'hA',
      l0: 'PRD: Authentication specification',
      tokL0: 10,
      tokL1: 20,
      tokL2: 100,
      stale: false,
      createdAt: 100,
      updatedAt: 100
    };

    const nodeB: NodeRecord = {
      id: 'c:auth_fn',
      tree: 'code',
      parent: null,
      kind: 'function',
      name: 'authenticate()',
      status: 'live',
      ver: 1,
      hash: 'hB',
      l0: 'function authenticate()',
      tokL0: 8,
      tokL1: 20,
      tokL2: 100,
      stale: false,
      createdAt: 100,
      updatedAt: 100
    };

    const nodeC: NodeRecord = {
      id: 'c:auth_test',
      tree: 'code',
      parent: null,
      kind: 'function',
      name: 'test_auth()',
      status: 'live',
      ver: 1,
      hash: 'hC',
      l0: 'function test_auth()',
      tokL0: 8,
      tokL1: 20,
      tokL2: 100,
      stale: false,
      createdAt: 100,
      updatedAt: 100
    };

    it('predicts multi-hop cognitive reasoning paths (Spec -> Code -> Test)', () => {
      const adjacency = new Map<string, Array<{ dstNode: NodeRecord; rel: LinkRelation; w: number }>>([
        ['d:spec_auth', [{ dstNode: nodeB, rel: 'specifies', w: 1.0 }]],
        ['c:auth_fn', [{ dstNode: nodeC, rel: 'tests', w: 1.0 }]]
      ]);

      const trails = nextHop.predictMultiHopTrails(nodeA, adjacency, 3);
      expect(trails.length).toBeGreaterThan(0);
      expect(trails[0].hops.length).toBe(2);
      expect(trails[0].hops[0].nodeId).toBe('c:auth_fn');
      expect(trails[0].hops[1].nodeId).toBe('c:auth_test');
      expect(trails[0].rationale).toContain('Specification & Verification Trail');

      const footer = nextHop.formatFooter({
        currentNodeId: nodeA.id,
        currentName: nodeA.name,
        recommendedHops: [
          {
            nodeId: nodeB.id,
            name: nodeB.name,
            kind: nodeB.kind,
            relation: 'specifies',
            priorityScore: 0.95,
            tokensL0: 8,
            reason: 'Implements spec'
          }
        ],
        trails,
        trailDepth: 2
      });

      expect(footer).toContain('COGNITIVE_TRAIL');
    });
  });

  describe('4. Deterministic Overrides Manager', () => {
    const makeNode = (id: string, filePath: string): NodeRecord => ({
      id,
      tree: 'code',
      parent: null,
      kind: 'file',
      name: filePath.split('/').pop() ?? id,
      status: 'live',
      ver: 1,
      hash: `hash-${id}`,
      filePath,
      l0: id,
      tokL0: 5,
      tokL1: 20,
      tokL2: 80,
      stale: false,
      createdAt: 0,
      updatedAt: 0
    });

    it('honors force_include and force_exclude glob patterns', () => {
      overrides.saveConfig({
        force_include: ['**/auth.ts'],
        force_exclude: ['**/node_modules/**', '**/*.test.ts']
      });

      const nodes = [
        makeNode('c:auth', 'packages/core/src/auth.ts'),
        makeNode('c:auth_test', 'packages/core/src/auth.test.ts'),
        makeNode('c:dep', 'node_modules/lib/index.js'),
        makeNode('c:readme', 'docs/README.md')
      ];

      const { forcedIncludes, forcedExcludes } = overrides.filter(nodes);
      expect(forcedIncludes.map(n => n.id)).toEqual(['c:auth']);
      expect(forcedExcludes.map(n => n.id)).toEqual(['c:auth_test', 'c:dep']);
    });

    it('matches filename patterns at any depth without over-matching', () => {
      expect(overrides.matches('packages/core/src/deep/auth.ts', ['**/auth.ts'])).toBe(true);
      expect(overrides.matches('auth.ts', ['*.ts'])).toBe(true);
      expect(overrides.matches('docs/README.md', ['**/*.ts'])).toBe(false);
    });
  });
});
