import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { buildGraphPayload, buildNodeDetail, deriveSubsystem } from '../src/ui/graph-payload.js';

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
