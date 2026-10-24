/**
 * Graph payload for the interactive UI.
 *
 * Two honest scoring modes:
 *   - task supplied  -> "pack" score: BM25 from FTS5 + a graph-degree bonus. The vector
 *     component is reported as null because the hosted process does not run the ONNX
 *     encoder; claiming one would be a lie.
 *   - no task        -> "structural" score: degree + recency + live status. This is not
 *     relevance and must never be presented as such.
 */

import type Database from 'better-sqlite3';
import { ftsSearch } from '@hivemind/core';

export interface GraphNode {
  id: string;
  name: string;
  kind: string;
  subsystem: string;
  file: string | null;
  lines: [number, number] | null;
  status: string;
  tokens: { l0: number; l1: number; l2: number };
  degree: { in: number; out: number };
  score: {
    kind: 'pack' | 'structural';
    bm25: number | null;
    vector: number | null;
    graph: number;
    composite: number;
    level: 0 | 1 | 2;
    reason: string;
  };
}

export interface GraphLink {
  src: string;
  dst: string;
  rel: string;
  w: number;
}

export interface GraphPayload {
  tenant: string;
  generatedAt: number;
  task: string | null;
  truncated: boolean;
  stats: { nodes: number; links: number; subsystems: number; tokens: number };
  nodes: GraphNode[];
  links: GraphLink[];
}

interface NodeRow {
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

const DEFAULT_LIMIT = 5000;

/**
 * Derive a subsystem label from a path so the UI can colour clusters without a
 * schema change. `packages/core/src/db.ts` -> `packages/core`, `src/auth/jwt.ts` -> `src/auth`.
 */
export function deriveSubsystem(filePath?: string | null): string {
  if (!filePath) return 'unknown';
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 1) return 'root';
  if (parts[0] === 'packages' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

function levelForScore(composite: number): 0 | 1 | 2 {
  if (composite > 0.7) return 2;
  if (composite > 0.4) return 1;
  return 0;
}

export function buildGraphPayload(
  db: Database.Database,
  opts: { tenant: string; task?: string; limit?: number }
): GraphPayload {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT));

  const rows = db
    .prepare(
      `SELECT id, name, kind, filePath, startLine, endLine, status, l0,
              tokL0, tokL1, tokL2, updatedAt
         FROM nodes
        WHERE status != 'superseded'
        ORDER BY updatedAt DESC
        LIMIT ?`
    )
    .all(limit + 1) as NodeRow[];

  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;
  const ids = new Set(kept.map((r) => r.id));

  const allLinks = db
    .prepare('SELECT src, dst, rel, w FROM links')
    .all() as Array<{ src: string; dst: string; rel: string; w: number }>;

  const degreeOut = new Map<string, number>();
  const degreeIn = new Map<string, number>();
  const links: GraphLink[] = [];
  for (const l of allLinks) {
    if (!ids.has(l.src) || !ids.has(l.dst)) continue;
    links.push({ src: l.src, dst: l.dst, rel: l.rel, w: l.w });
    degreeOut.set(l.src, (degreeOut.get(l.src) ?? 0) + 1);
    degreeIn.set(l.dst, (degreeIn.get(l.dst) ?? 0) + 1);
  }

  const maxDegree = kept.reduce(
    (m, r) => Math.max(m, (degreeOut.get(r.id) ?? 0) + (degreeIn.get(r.id) ?? 0)),
    1
  );
  const degreeNorm = (id: string) =>
    Math.log1p((degreeOut.get(id) ?? 0) + (degreeIn.get(id) ?? 0)) / Math.log1p(maxDegree);

  // BM25 is only meaningful with a query; the FTS index throws on an empty MATCH.
  const bm25 = new Map<string, number>();
  const task = opts.task?.trim();
  if (task) {
    const safeQuery = task.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
    if (safeQuery) {
      for (const hit of ftsSearch(db, safeQuery, 300)) {
        bm25.set(hit.id, Math.min(1, Math.abs(hit.bm25) / 10));
      }
    }
  }

  const newest = kept.reduce((m, r) => Math.max(m, r.updatedAt), 0) || 1;
  const oldest = kept.reduce((m, r) => Math.min(m, r.updatedAt), newest) || newest;
  const span = Math.max(1, newest - oldest);

  const nodes: GraphNode[] = kept.map((r) => {
    const graph = 0.15 * degreeNorm(r.id);
    const recency = (r.updatedAt - oldest) / span;
    const live = r.status === 'live' ? 1 : 0;

    let composite: number;
    let reason: string;
    if (task) {
      const lexical = bm25.get(r.id) ?? 0;
      composite = Math.min(1, 0.85 * lexical + graph);
      reason = `BM25=${lexical.toFixed(2)} | graph=${graph.toFixed(2)} | ${r.kind} ${r.name}`;
    } else {
      composite = Math.min(1, 0.6 * degreeNorm(r.id) + 0.25 * recency + 0.15 * live);
      reason = `structural: degree=${degreeNorm(r.id).toFixed(2)} recency=${recency.toFixed(2)} ${r.status}`;
    }

    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      subsystem: deriveSubsystem(r.filePath),
      file: r.filePath,
      lines: r.startLine != null && r.endLine != null ? [r.startLine, r.endLine] : null,
      status: r.status,
      tokens: { l0: r.tokL0, l1: r.tokL1, l2: r.tokL2 },
      degree: { in: degreeIn.get(r.id) ?? 0, out: degreeOut.get(r.id) ?? 0 },
      score: {
        kind: task ? 'pack' : 'structural',
        bm25: task ? bm25.get(r.id) ?? 0 : null,
        vector: null,
        graph,
        composite,
        level: levelForScore(composite),
        reason,
      },
    };
  });

  nodes.sort((a, b) => b.score.composite - a.score.composite || a.name.localeCompare(b.name));

  return {
    tenant: opts.tenant,
    generatedAt: Date.now(),
    task: task ?? null,
    truncated,
    stats: {
      nodes: nodes.length,
      links: links.length,
      subsystems: new Set(nodes.map((n) => n.subsystem)).size,
      tokens: nodes.reduce((sum, n) => sum + n.tokens.l0 + n.tokens.l1 + n.tokens.l2, 0),
    },
    nodes,
    links,
  };
}

export interface NodeDetail {
  id: string;
  name: string;
  kind: string;
  subsystem: string;
  file: string | null;
  lines: [number, number] | null;
  status: string;
  hash: string;
  l0: string;
  l1: string | null;
  l2: string | null;
  tokens: { l0: number; l1: number; l2: number };
  outgoing: Array<{ id: string; name: string; rel: string; w: number; kind: string }>;
  incoming: Array<{ id: string; name: string; rel: string; w: number; kind: string }>;
}

export function buildNodeDetail(db: Database.Database, id: string): NodeDetail | null {
  const row = db
    .prepare(
      `SELECT id, name, kind, filePath, startLine, endLine, status, hash, l0, l1, l2,
              tokL0, tokL1, tokL2
         FROM nodes WHERE id = ?`
    )
    .get(id) as
    | {
        id: string;
        name: string;
        kind: string;
        filePath: string | null;
        startLine: number | null;
        endLine: number | null;
        status: string;
        hash: string;
        l0: string;
        l1: string | null;
        l2: string | null;
        tokL0: number;
        tokL1: number;
        tokL2: number;
      }
    | undefined;

  if (!row) return null;

  const outgoing = db
    .prepare(
      `SELECT l.dst AS id, n.name, l.rel, l.w, n.kind
         FROM links l JOIN nodes n ON n.id = l.dst
        WHERE l.src = ? ORDER BY l.w DESC LIMIT 50`
    )
    .all(id) as NodeDetail['outgoing'];

  const incoming = db
    .prepare(
      `SELECT l.src AS id, n.name, l.rel, l.w, n.kind
         FROM links l JOIN nodes n ON n.id = l.src
        WHERE l.dst = ? ORDER BY l.w DESC LIMIT 50`
    )
    .all(id) as NodeDetail['incoming'];

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    subsystem: deriveSubsystem(row.filePath),
    file: row.filePath,
    lines: row.startLine != null && row.endLine != null ? [row.startLine, row.endLine] : null,
    status: row.status,
    hash: row.hash,
    l0: row.l0,
    l1: row.l1,
    l2: row.l2,
    tokens: { l0: row.tokL0, l1: row.tokL1, l2: row.tokL2 },
    outgoing,
    incoming,
  };
}
