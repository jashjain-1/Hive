import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import {
  assembleContextPack,
  buildGraphPayload,
  buildNodeDetail,
  deriveSubsystem,
} from '../src/ui/graph-payload.js';

const NOW = 1_700_000_000_000;

interface Row {
  id: string;
  name: string;
  kind: string;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  status: string;
  l0: string;
  tokL0: number;
  tokL1: number;
  tokL2: number;
  updatedAt: number;
}

function row(partial: Partial<Row> & { id: string; name: string }): Row {
  return {
    kind: 'function',
    filePath: 'packages/core/src/auth/jwt.ts',
    startLine: 1,
    endLine: 20,
    status: 'live',
    l0: `${partial.name} signature`,
    tokL0: 10,
    tokL1: 0,
    tokL2: 0,
    updatedAt: NOW,
    ...partial,
  };
}

/**
 * Minimal stand-in for better-sqlite3. The builder only issues three prepared
 * statements, so a stub keeps these tests runnable on machines where the native
 * binding does not match the Node ABI (see the sqlite suite at the bottom).
 */
function makeStub(opts: {
  rows: Row[];
  links?: Array<{ src: string; dst: string; rel: string; w: number }>;
  bm25?: Array<{ id: string; name: string; l0: string; bm25: number }>;
}): DatabaseType {
  const links = opts.links ?? [];
  const bm25 = opts.bm25 ?? [];

  return {
    prepare(sql: string) {
      return {
        all: (...args: unknown[]) => {
          if (sql.includes('FROM nodes_fts')) return bm25;
          if (sql.includes('FROM links')) return links;
          const limit = typeof args[0] === 'number' ? args[0] : opts.rows.length;
          return opts.rows.slice(0, limit);
        },
        get: () => undefined,
      };
    },
  } as unknown as DatabaseType;
}

/** Tiny in-memory table for real-SQLite-based tests. */
function seedNodes(db: import('better-sqlite3').Database): void {
  const insert = db.prepare(
    `INSERT INTO nodes
      (id, tree, parent, kind, name, filePath, startLine, endLine, status, ver, hash,
       l0, l1, l2, tokL0, tokL1, tokL2, stale, createdAt, updatedAt)
     VALUES (?, 'code', NULL, ?, ?, ?, 1, 20, 'live', 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  );
  const NOW = 1_700_000_000_000;
  insert.run('c:auth', 'function', 'verifyToken', 'packages/core/src/auth/jwt.ts', 'h1',
    'verifyToken signature', 'Verifies a JWT bearer token', 'export function verifyToken(t: string) {}',
    10, 30, 120, NOW, NOW);
  insert.run('c:routes', 'function', 'authRoutes', 'packages/mcp/src/routes/auth.ts', 'h2',
    'authRoutes signature', 'Mounts /login route', 'router.post(...) calls verifyToken',
    10, 30, 120, NOW, NOW);
  insert.run('c:docs', 'markdown', 'Auth docs', 'docs/auth.md', 'h3',
    'Auth docs summary', null, null, 4, 10, 60, NOW - 5000, NOW - 5000);
  db.prepare('INSERT INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)').run('c:routes', 'c:auth', 'calls', 0.9);
  db.prepare('INSERT INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)').run('c:auth', 'c:docs', 'documents', 0.5);
  db.prepare('INSERT INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)').run('c:routes', 'c:auth', 'imports', 0.7);
}

describe('deriveSubsystem', () => {
  it('groups workspace packages by package name', () => {
    expect(deriveSubsystem('packages/core/src/db.ts')).toBe('packages/core');
    expect(deriveSubsystem('packages/mcp/src/sse-server.ts')).toBe('packages/mcp');
  });

  it('groups loose source by its first two path segments', () => {
    expect(deriveSubsystem('src/auth/jwt.ts')).toBe('src/auth');
    expect(deriveSubsystem('README.md')).toBe('root');
    expect(deriveSubsystem(null)).toBe('unknown');
  });

  it('normalises backslashes', () => {
    expect(deriveSubsystem('packages\\core\\src\\db.ts')).toBe('packages/core');
  });
});

describe('buildGraphPayload (stubbed db)', () => {
  const rows: Row[] = [
    row({ id: 'c:auth', name: 'verifyToken', filePath: 'packages/core/src/auth/jwt.ts' }),
    row({ id: 'c:routes', name: 'authRoutes', filePath: 'packages/mcp/src/routes/auth.ts' }),
    row({ id: 'c:docs', name: 'JWT notes', kind: 'markdown', filePath: 'README.md', updatedAt: NOW - 5000 }),
  ];
  const links = [
    { src: 'c:routes', dst: 'c:auth', rel: 'calls', w: 0.9 },
    { src: 'c:auth', dst: 'c:docs', rel: 'documents', w: 0.5 },
  ];

  it('returns nodes and only links whose endpoints are present', () => {
    const payload = buildGraphPayload(makeStub({ rows, links }), { tenant: 'default' });
    expect(payload.nodes).toHaveLength(3);
    expect(payload.links).toHaveLength(2);
    expect(payload.truncated).toBe(false);

    const routes = payload.nodes.find((n) => n.id === 'c:routes')!;
    expect(routes.degree).toEqual({ in: 0, out: 1 });
    expect(routes.subsystem).toBe('packages/mcp');
    expect(routes.lines).toEqual([1, 20]);
  });

  it('labels scores as structural when no task is given', () => {
    const payload = buildGraphPayload(makeStub({ rows, links }), { tenant: 'default' });
    for (const node of payload.nodes) {
      expect(node.score.kind).toBe('structural');
      expect(node.score.bm25).toBeNull();
      expect(node.score.vector).toBeNull();
      expect(node.score.composite).toBeGreaterThanOrEqual(0);
      expect(node.score.composite).toBeLessThanOrEqual(1);
    }
  });

  it('uses pack scores when a task is supplied', () => {
    const bm25 = [
      { id: 'c:auth', name: 'verifyToken', l0: 'x', bm25: -8 },
      { id: 'c:routes', name: 'authRoutes', l0: 'x', bm25: -2 },
    ];
    const payload = buildGraphPayload(makeStub({ rows, links, bm25 }), {
      tenant: 'default',
      task: 'verifyToken',
    });
    expect(payload.task).toBe('verifyToken');
    expect(payload.nodes.every((n) => n.score.kind === 'pack')).toBe(true);

    const auth = payload.nodes.find((n) => n.id === 'c:auth')!;
    expect(auth.score.bm25).toBeCloseTo(0.8, 5);
    expect(payload.nodes[0].id).toBe('c:auth');

    const composites = payload.nodes.map((n) => n.score.composite);
    expect([...composites].sort((a, b) => b - a)).toEqual(composites);
  });

  it('honours the limit and flags truncation', () => {
    const payload = buildGraphPayload(makeStub({ rows, links }), { tenant: 'default', limit: 2 });
    expect(payload.nodes).toHaveLength(2);
    expect(payload.truncated).toBe(true);
  });

  it('drops links that point outside the kept node set', () => {
    const payload = buildGraphPayload(makeStub({ rows, links }), { tenant: 'default', limit: 1 });
    expect(payload.nodes).toHaveLength(1);
    for (const link of payload.links) {
      expect(payload.nodes.some((n) => n.id === link.src)).toBe(true);
      expect(payload.nodes.some((n) => n.id === link.dst)).toBe(true);
    }
  });
});

describe('graph payload metadata (stubbed db)', () => {
  const rows: Row[] = [
    row({ id: 'c:auth', name: 'verifyToken', filePath: 'packages/core/src/auth/jwt.ts', l0: 'verifyToken signature' }),
    row({ id: 'c:routes', name: 'authRoutes', filePath: 'packages/mcp/src/routes/auth.ts', l0: 'authRoutes signature' }),
  ];
  const links = [
    { src: 'c:routes', dst: 'c:auth', rel: 'calls', w: 0.9 },
    { src: 'c:routes', dst: 'c:auth', rel: 'imports', w: 0.7 },
    { src: 'c:auth', dst: 'c:routes', rel: 'implements', w: 0.6 },
  ];

  it('carries the L0 summary for the client NLP layer', () => {
    const payload = buildGraphPayload(makeStub({ rows, links }), { tenant: 'default' });
    expect(payload.nodes.find((n) => n.id === 'c:auth')!.l0).toBe('verifyToken signature');
  });

  it('buckets link relations into the per-node label lists', () => {
    const payload = buildGraphPayload(makeStub({ rows, links }), { tenant: 'default' });
    const auth = payload.nodes.find((n) => n.id === 'c:auth')!;
    const routes = payload.nodes.find((n) => n.id === 'c:routes')!;
    expect(auth.labels.calls).toEqual(['c:routes']);
    expect(auth.labels.imports).toEqual(['c:routes']);
    expect(auth.labels.implements).toEqual(['c:routes']);
    expect(routes.labels.calls).toEqual(['c:auth']);
    expect(routes.labels.implements).toEqual(['c:auth']);
  });

  it('reports recency in [0,1] on every node', () => {
    const payload = buildGraphPayload(
      makeStub({
        rows: [
          row({ id: 'a', name: 'older' }),
          row({ id: 'b', name: 'newer', updatedAt: 1_700_000_000_000 + 10_000 }),
        ],
        links: [],
      }),
      { tenant: 'default' }
    );
    for (const node of payload.nodes) {
      expect(node.score.recency).toBeGreaterThanOrEqual(0);
      expect(node.score.recency).toBeLessThanOrEqual(1);
    }
  });
});

  describe.skipIf(!sqliteAvailable())('buildNodeDetail explanations against real SQLite', () => {
  it('synthesises a structural explanation and score components', async () => {
    const { initializeDatabase } = await import('@hivemind/core');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-graph-ex-'));
    const db = initializeDatabase(path.join(dir, 'tenant.db'));

    try {
      seedNodes(db as unknown as import('better-sqlite3').Database);

      const detail = buildNodeDetail(db, 'c:auth')!;
      expect(detail.incoming.map((l) => l.id)).toContain('c:routes');
      expect(detail.explanation.summary).toContain('authRoutes');
      expect(detail.explanation.path).toContain('authRoutes');
      expect(detail.explanation.labels.calls).toContain('c:routes');
      expect(detail.explanation.labels.imports).toContain('c:routes');
      // No task/embeddings here: both stay null instead of being invented.
      expect(detail.explanation.scores.bm25).toBeNull();
      expect(detail.explanation.scores.semantic).toBeNull();
      expect(detail.explanation.scores.recency).toBeGreaterThanOrEqual(0);
      expect(detail.explanation.scores.recency).toBeLessThanOrEqual(1);
      expect(buildNodeDetail(db, 'c:missing')).toBeNull();
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!sqliteAvailable())('assembleContextPack against real SQLite', () => {
  it('builds a markdown pack with excerpts and the exclusion directive', async () => {
    const { initializeDatabase } = await import('@hivemind/core');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-graph-pack-'));
    const db = initializeDatabase(path.join(dir, 'tenant.db'));

    try {
      seedNodes(db as unknown as import('better-sqlite3').Database);

      const pack = assembleContextPack(db, {
        included: ['c:routes', 'c:auth'],
        excluded: ['c:docs'],
        budget: 4000,
        task: 'Fix JWT verification',
        tenant: 'default',
      });


      expect(pack.items.map((i) => i.id)).toEqual(['c:routes', 'c:auth']);
      expect(pack.items.every((i) => i.tokens > 0)).toBe(true);
      expect(pack.exclusions.map((e) => e.id)).toEqual(['c:docs']);
      expect(pack.overBudget).toBe(false);

      expect(pack.markdown).toContain('# Active Task / Goal');
      expect(pack.markdown).toContain('Fix JWT verification');
      expect(pack.markdown).toContain('| `c:auth` |');
      expect(pack.markdown).toContain('STRICT EXCLUSION DIRECTIVE FOR ASSISTANT');
      expect(pack.markdown).toContain('docs/auth.md');
      // L2 is the richest level and fits in this budget, so the excerpt is the
      // full L2 implementation, not the L1 summary.
      expect(pack.markdown).toContain('export function verifyToken');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('greedily drops nodes that no longer fit and reports them as deferred', async () => {
    const { initializeDatabase } = await import('@hivemind/core');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-graph-pack2-'));
    const db = initializeDatabase(path.join(dir, 'tenant.db'));

    try {
      seedNodes(db as unknown as import('better-sqlite3').Database);

      // L2 costs 120 tokens; with a 125 budget only the first node's richest
      // level fits — the second cannot even afford its 10-token L0 excerpt.
      const pack = assembleContextPack(db, {
        included: ['c:auth', 'c:routes', 'missing:node'],
        excluded: [],
        budget: 125,
        tenant: 'default',
      });

      expect(pack.usedTokens).toBeLessThanOrEqual(125);
      expect(pack.items).toHaveLength(1);
      expect(pack.items[0]!.id).toBe('c:auth');
      expect(pack.deferred.map((d) => d.id)).toContain('c:routes');
      expect(pack.deferred.map((d) => d.id)).toContain('missing:node');
      expect(pack.deferred.find((d) => d.id === 'c:routes')!.reason).toContain('Budget');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real SQLite suite. Skipped only when the native binding cannot load for the
// running Node ABI; it runs in CI/Docker where the module is built correctly.
// ---------------------------------------------------------------------------
function sqliteAvailable(): boolean {
  try {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!sqliteAvailable())('graph payload against real SQLite', () => {
  it('reads levels and both link directions from a tenant db', async () => {
    const { initializeDatabase } = await import('@hivemind/core');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-graph-'));
    const db = initializeDatabase(path.join(dir, 'tenant.db'));

    try {
      const insert = db.prepare(
        `INSERT INTO nodes
          (id, tree, parent, kind, name, filePath, startLine, endLine, status, ver, hash,
           l0, l1, l2, tokL0, tokL1, tokL2, stale, createdAt, updatedAt)
         VALUES (?, 'code', NULL, ?, ?, ?, 1, 20, 'live', 1, ?, ?, ?, ?, 10, 30, 120, 0, ?, ?)`
      );
      insert.run('c:auth', 'function', 'verifyToken', 'packages/core/src/auth/jwt.ts', 'h1', 'verifyToken', 'Validates a JWT', 'export function verifyToken() {}', NOW, NOW);
      insert.run('c:routes', 'function', 'authRoutes', 'packages/mcp/src/routes/auth.ts', 'h2', 'authRoutes', 'Mounts /login', null, NOW, NOW);
      db.prepare('INSERT INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)').run('c:routes', 'c:auth', 'calls', 0.9);

      const payload = buildGraphPayload(db, { tenant: 'default' });
      expect(payload.nodes).toHaveLength(2);
      expect(payload.links).toHaveLength(1);

      const detail = buildNodeDetail(db, 'c:auth')!;
      expect(detail.name).toBe('verifyToken');
      expect(detail.l1).toContain('Validates');
      expect(detail.tokens.l2).toBe(120);
      expect(detail.incoming.map((l) => l.id)).toContain('c:routes');
      expect(buildNodeDetail(db, 'c:missing')).toBeNull();
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
