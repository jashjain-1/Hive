/**
 * Graph payload for the interactive UI.
 *
 * Two honest scoring modes:
 *   - task supplied  -> "pack" score: BM25 from FTS5 + a graph-degree bonus. The vector
 *     component is reported as null because the hosted process does not run the ONNX
 *     encoder; claiming one would be a lie.
 *   - no task        -> "structural" score: degree + recency + live status. This is not
 *     relevance and must never be presented as such.
 *
 * The semantic component is computed client-side by the UI's lightweight NLP layer
 * (concept taxonomy + 1-hop diffusion). It is not the hosted ONNX embedder.
 */

import type Database from 'better-sqlite3';
import { ftsSearch } from '@hivemind/core';

/** Relation buckets exposed to the UI for per-node link lists. */
export interface NodeLinkLists {
  calls: string[];
  imports: string[];
  defines: string[];
  implements: string[];
}

export interface GraphNode {
  id: string;
  name: string;
  kind: string;
  subsystem: string;
  file: string | null;
  lines: [number, number] | null;
  status: string;
  /** One-line L0 summary, used by the client NLP layer as an extra matching field. */
  l0: string;
  tokens: { l0: number; l1: number; l2: number };
  degree: { in: number; out: number };
  labels: NodeLinkLists;
  score: {
    kind: 'pack' | 'structural';
    bm25: number | null;
    vector: number | null;
    graph: number;
    recency: number;
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

const REL_BUCKETS: Array<[keyof NodeLinkLists, ReadonlySet<string>]> = [
  ['calls', new Set(['calls', 'tests', 'mentions'])],
  ['imports', new Set(['imports', 'depends_on', 'next_step'])],
  ['defines', new Set(['defines', 'specifies', 'documents'])],
  ['implements', new Set(['implements'])],
];

function bucketFor(rel: string): keyof NodeLinkLists | null {
  for (const [key, rels] of REL_BUCKETS) {
    if (rels.has(rel)) return key;
  }
  return null;
}

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
  const labels = new Map<string, NodeLinkLists>();
  const links: GraphLink[] = [];

  for (const l of allLinks) {
    if (!ids.has(l.src) || !ids.has(l.dst)) continue;
    links.push({ src: l.src, dst: l.dst, rel: l.rel, w: l.w });
    degreeOut.set(l.src, (degreeOut.get(l.src) ?? 0) + 1);
    degreeIn.set(l.dst, (degreeIn.get(l.dst) ?? 0) + 1);
    const bucket = bucketFor(l.rel);
    if (bucket) {
      for (const [owner, target] of [[l.src, l.dst], [l.dst, l.src]] as const) {
        const entry = labels.get(owner) ?? emptyLabelLists();
        if (!entry[bucket].includes(target)) entry[bucket].push(target);
        labels.set(owner, entry);
      }
    }
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
      l0: (r.l0 ?? '').slice(0, 200),
      tokens: { l0: r.tokL0, l1: r.tokL1, l2: r.tokL2 },
      degree: { in: degreeIn.get(r.id) ?? 0, out: degreeOut.get(r.id) ?? 0 },
      labels: labels.get(r.id) ?? emptyLabelLists(),
      score: {
        kind: task ? 'pack' : 'structural',
        bm25: task ? bm25.get(r.id) ?? 0 : null,
        vector: null,
        graph,
        recency,
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

function emptyLabelLists(): NodeLinkLists {
  return { calls: [], imports: [], defines: [], implements: [] };
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
  updatedAt: number;
  explanation: NodeExplanation;
}

export interface NodeExplanation {
  /** One-sentence natural-language answer to "why is this node here / relevant?" */
  summary: string;
  /** Structural trace: who reaches this node and what it reaches. */
  path: string;
  /** Numerical components for the UI's score bars. */
  scores: {
    bm25: number | null;
    semantic: number | null;
    graph: number;
    recency: number;
    composite: number;
  };
  labels: NodeLinkLists;
}

function buildExplanation(db: Database.Database, row: NodeDetailRow, totalLinks: number): NodeExplanation {
  const totalDegree = row.incoming.length + row.outgoing.length;
  const newest = Math.max(row.updatedAt, 1);
  const spans = db
    .prepare('SELECT MIN(updatedAt) AS oldest, MAX(updatedAt) AS newest FROM nodes')
    .get() as { oldest: number | null; newest: number | null };
  const oldest = spans.oldest ?? row.updatedAt;
  const span = Math.max(1, (spans.newest ?? row.updatedAt) - oldest);
  const recency = Math.max(0, Math.min(1, (row.updatedAt - oldest) / span));
  const graph = Math.min(1, Math.log1p(totalDegree) / Math.log1p(Math.max(2, totalLinks)));

  const positives: string[] = [];

  const uses = row.incoming.slice(0, 3);
  if (uses.length > 0) {
    positives.push(
      `Imported/called by ${uses
        .map((l) => `'${l.name}'`)
        .join(', ')} — it sits inside the selected context's dependency closure.`
    );
  }

  const calls = row.outgoing.slice(0, 3);
  if (calls.length > 0) {
    positives.push(
      `Reaches ${calls.map((l) => `'${l.name}'`).join(', ')} via ${row.outgoing.length} outgoing link${row.outgoing.length === 1 ? '' : 's'}.`
    );
  }

  if (totalDegree >= 6) {
    positives.push(
      `Core architectural hub with ${row.incoming.length} incoming and ${row.outgoing.length} outgoing dependencies.`
    );
  }

  if (totalDegree === 0) {
    positives.push(
      'Leaf node with no graph links in the current index; its relevance comes from name and summary text only.'
    );
  }

  positives.push(
    `${row.status === 'live' ? 'Live' : row.status} node, ${recency >= 0.66 ? 'recently updated' : recency >= 0.33 ? 'recently touched' : 'older revision'}.`
  );

  return {
    summary: positives[0],
    path: positives.join(' '),
    scores: {
      // No task and no embeddings in this process: both stay null instead of
      // inventing numbers. The client NLP layer supplies its own semantic score.
      bm25: null,
      semantic: null,
      graph,
      recency,
      composite: Math.min(1, 0.55 * graph + 0.25 * recency + (row.status === 'live' ? 0.2 : 0)),
    },
    labels: row.labels,
  };
}

interface NodeDetailRow {
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
  updatedAt: number;
  incoming: Array<{ id: string; name: string; rel: string; w: number; kind: string }>;
  outgoing: Array<{ id: string; name: string; rel: string; w: number; kind: string }>;
  labels: NodeLinkLists;
}

export function buildNodeDetail(db: Database.Database, id: string): NodeDetail | null {
  const row = db
    .prepare(
      `SELECT id, name, kind, filePath, startLine, endLine, status, hash, l0, l1, l2,
              tokL0, tokL1, tokL2, updatedAt
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
        updatedAt: number;
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

  const labels = emptyLabelLists();
  const seen = new Set<string>();
  for (const link of [...outgoing, ...incoming]) {
    const bucket = bucketFor(link.rel);
    if (!bucket || seen.has(`${bucket}:${link.id}`)) continue;
    seen.add(`${bucket}:${link.id}`);
    labels[bucket].push(link.id);
  }

  const detail: NodeDetailRow = { ...row, incoming, outgoing, labels };
  const totalLinks = (db.prepare('SELECT COUNT(*) AS c FROM links').get() as { c: number }).c;

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
    updatedAt: row.updatedAt,
    explanation: buildExplanation(db, detail, totalLinks),
  };
}

// ---------------------------------------------------------------------------
// Context pack assembly
// ---------------------------------------------------------------------------

export interface ContextPack {
  packId: string;
  tenant: string;
  task: string | null;
  budget: number;
  usedTokens: number;
  overBudget: boolean;
  /** Included nodes actually carried into the markdown, with their chosen level. */
  items: ContextPackItem[];
  /** Included nodes dropped because they did not fit the budget. */
  deferred: Array<{ id: string; name: string; reason: string }>;
  /** Excluded entries resolved to display names / paths. */
  exclusions: Array<{ id: string; name: string; file: string | null }>;
  /** Ready-to-hand-over markdown, including the strict exclusion directive. */
  markdown: string;
}

export interface ContextPackItem {
  id: string;
  name: string;
  kind: string;
  subsystem: string;
  file: string | null;
  lines: [number, number] | null;
  level: 0 | 1 | 2;
  tokens: number;
  excerpt: string;
}

export interface ContextPackOptions {
  included: string[];
  excluded: string[];
  budget: number;
  task?: string;
  /** Tenant label stamped into the pack id/markdown. */
  tenant?: string;
}

const MAX_EXCERPT_CHARS = 400;

function memoToken(text: string, tokens: number): number {
  return tokens > 0 ? tokens : Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Assemble a hand-over-ready context pack: greedy budget fill over the user's
 * include list (their order is the priority order), L2 -> L1 -> L0 fallback per
 * node, and an explicit exclusion directive so the assistant never touches the
 * files the user deliberately removed.
 */
export function assembleContextPack(
  db: Database.Database,
  opts: ContextPackOptions
): ContextPack {
  const budget = Math.max(64, Math.min(Math.floor(opts.budget) || 8000, 2_000_000));
  const tenant = (opts.tenant ?? '').trim();
  const task = (opts.task ?? '').trim() || null;

  const includedIds = Array.from(new Set(opts.included.filter((v) => typeof v === 'string' && v.length > 0)));
  const excludedIds = Array.from(new Set(opts.excluded.filter((v) => typeof v === 'string' && v.length > 0)));

  const detail = new Map<string, ContextPackItem>();
  const exclusions: Array<{ id: string; name: string; file: string | null }> = [];

  const loadNode = (id: string): NodeDetail | null => buildNodeDetail(db, id);

  for (const id of excludedIds) {
    const node = loadNode(id);
    exclusions.push({
      id,
      name: node ? node.name : id,
      file: node ? node.file : null,
    });
  }

  const items: ContextPackItem[] = [];
  const deferred: ContextPack['deferred'] = [];
  let usedTokens = 0;

  for (const id of includedIds) {
    const node = loadNode(id);
    if (!node) {
      deferred.push({ id, name: id, reason: 'Not found in the tenant index.' });
      continue;
    }

    const candidates: Array<{ level: 0 | 1 | 2; tokens: number; text: string | null }> = [
      { level: 2, tokens: memoToken(node.l2 ?? node.l1 ?? node.l0, node.tokens.l2), text: node.l2 ?? node.l1 ?? node.l0 },
      { level: 1, tokens: memoToken(node.l1 ?? node.l0, node.tokens.l1), text: node.l1 ?? node.l0 },
      { level: 0, tokens: memoToken(node.l0, node.tokens.l0), text: node.l0 },
    ];

    let chosen: (typeof candidates)[number] | null = null;
    for (const candidate of candidates) {
      if (usedTokens + candidate.tokens <= budget) {
        chosen = candidate;
        break;
      }
    }

    if (!chosen) {
      deferred.push({
        id: node.id,
        name: node.name,
        reason: `Budget exhausted (${usedTokens}/${budget} tokens used before this node's L0 excerpt).`,
      });
      continue;
    }

    usedTokens += chosen.tokens;
    items.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      subsystem: node.subsystem,
      file: node.file,
      lines: node.lines,
      level: chosen.level,
      tokens: chosen.tokens,
      excerpt: (chosen.text ?? '').slice(0, MAX_EXCERPT_CHARS),
    });
    detail.set(node.id, items[items.length - 1]);
  }

  const packId = tenant ? `${tenant}:${Date.now().toString(36).slice(-6)}` : `p:${Date.now().toString(36).slice(-6)}`;
  const markdown = renderPackMarkdown(task, items, deferred, exclusions, usedTokens, budget);

  return {
    packId,
    tenant,
    task,
    budget,
    usedTokens,
    overBudget: usedTokens > budget,
    items,
    deferred,
    exclusions,
    markdown,
  };
}

function renderPackMarkdown(
  task: string | null,
  items: ContextPackItem[],
  deferred: ContextPack['deferred'],
  exclusions: ContextPack['exclusions'],
  usedTokens: number,
  budget: number
): string {
  const lines: string[] = [];
  lines.push('# Active Task / Goal');
  lines.push(task ?? 'Not specified — freeform exploration of the repository graph.');
  lines.push('');
  lines.push(`_Context pack: ${items.length} node${items.length === 1 ? '' : 's'} · ${usedTokens} / ${budget} tokens (counts are L0/L1/L2 estimates)._`);
  lines.push('');
  lines.push('## Included Files & Symbols');
  lines.push('');
  lines.push('| Node ID | Name | Kind | File | Lines | Level | Tokens |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const item of items) {
    const file = item.file ?? '(memory)';
    const linesRange = item.lines ? `${item.lines[0]}–${item.lines[1]}` : '—';
    lines.push(
      `| \`${item.id}\` | ${item.name} | ${item.kind} | ${file} | ${linesRange} | L${item.level} | ${item.tokens} |`
    );
  }
  if (items.length === 0) {
    lines.push('_No nodes included yet._');
  }
  lines.push('');

  lines.push('## Context excerpts');
  lines.push('');
  for (const item of items) {
    lines.push(`### ${item.id} — ${item.name} (L${item.level}, ${item.tokens} tok)`);
    lines.push('');
    lines.push('```');
    lines.push(item.excerpt || '(empty summary)');
    lines.push('```');
    lines.push('');
  }

  // Dependency relationships carried into the pack are printed by the caller if
  // needed; the markdown itself stays excerpt-first to keep the token cost low.

  if (deferred.length > 0) {
    lines.push('## Deferred (did not fit the budget)');
    lines.push('');
    for (const d of deferred) {
      lines.push(`- ${d.id} — ${d.name}: ${d.reason}`);
    }
    lines.push('');
  }

  if (exclusions.length > 0) {
    lines.push('### ⚠️ STRICT EXCLUSION DIRECTIVE FOR ASSISTANT');
    lines.push('');
    lines.push('The user has explicitly EXCLUDED the following files from context.');
    lines.push(
      'Under NO circumstances should you read, reference, import, suggest modifications to, or hallucinate dependencies from these paths:'
    );
    lines.push('');
    for (const e of exclusions) {
      lines.push(`- ${e.file ?? e.name}${e.file && e.file !== e.name ? ` (${e.name})` : ''}`);
    }
    lines.push('');
  } else {
    lines.push('### Exclusion note');
    lines.push('');
    lines.push('No files were explicitly excluded in this pack. Everything in the Included table is fair game.');
    lines.push('');
  }

  return lines.join('\n');
}

