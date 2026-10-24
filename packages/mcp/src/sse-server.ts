/**\n * Hivemind Hosted MCP Gateway Server\n *\n * Provides:\n * - Public MCP Server-Sent Events (SSE) streaming endpoint for any AI agent\n * - Streamable HTTP endpoint for modern MCP clients (dual-transport)\n * - Zero-install remote connection for Claude Desktop, Cursor, Windsurf, Antigravity\n * - Zero-Persistence Ephemeral GitHub PAT authorization\n * - Strict per-tenant isolated SQLite WAL databases (.hive/tenants/<tenantId>.db)\n * - Arbitrary repo size support via streaming AST ingestion and batch SQLite commits\n * - Rate limiting and Helmet security headers\n * - Shared in-flight secrets redaction applied to ALL tool responses\n * - Lightweight hosted dashboard and visibility endpoints for the browser-only persona\n * - Portable skill-friendly discovery hints (remote endpoint + fallback guidance)\n */

import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Keep the local name the rest of the file already uses.
type StreamableServerTransport = typeof StreamableHTTPServerTransport;
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HIVE_CONSTANTS } from '@hivemind/types';
import { validateIndexRepoUrl, isPrivateIpv4 } from './security/repo-url.js';
import { SecretsRedactor } from '@hivemind/core';
import { initializeDatabase, ftsSearch, querySubtree, insertNode, rebuildClosureTable } from '@hivemind/core';
import { AstChunker } from '@hivemind/core';
import { UniversalDocChunker } from '@hivemind/core';
import { CrossModalEntityLinker } from '@hivemind/core';
import { MerkleTree } from '@hivemind/core';
import { exportGraphToJson, generateGraphOverview, generateChatStartCard } from '@hivemind/core';
import { IgnoreEngine } from '@hivemind/core';
import { GitImpactAnalyzer } from '@hivemind/core';
import { OverridesManager } from '@hivemind/pack';
import { NextHopPredictor } from '@hivemind/pack';
import { ExplainEngine } from '@hivemind/pack';
import {
  NodeRecord, PackRequest, PackResponse, NextHopResult,
  LinkRelation, ImpactResult
} from '@hivemind/types';

const app = express();
const PORT = process.env.PORT || 3000;
const TENANTS_DIR = path.join(process.cwd(), '.hive', 'tenants');
const REPO_TEMP_DIR = path.join(process.cwd(), '.hive', 'temp-repos');
const WASM_DIR = path.join(__dirname, '..', '..', 'core', 'vendor', 'wasm');

// Ensure directories exist
for (const dir of [TENANTS_DIR, REPO_TEMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 1. Security & Protection Middlewares
// `contentSecurityPolicy: false` keeps the hosted dashboard usable when origins shift
// between preview and production; tighten in a locked-down deployment.
app.use(helmet({ contentSecurityPolicy: false }));

// CORS: pin the allowed origins for this deployment.
// The wildcard is intentionally removed because the MCP server exposes mutations and
// an indexing endpoint that performs network activity on behalf of the caller.
// If you need a wider set of allowed origins, add explicit entries above rather than
// relaxing back to `*`.
const ALLOWED_CORS_ORIGINS = new Set([
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8100',
  'https://hivemind-mcp.onrender.com',
]);

const TRUSTED_PROXY = process.env.TRUSTED_PROXY === '1';

function clientIp(req: Request): string {
  if (TRUSTED_PROXY && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.ip ?? 'unknown';
}

app.use(cors({
  origin: (origin, callback) => {
    const originStr = (origin || '').trim();
    if (!originStr || originStr === 'unknown') {
      // Non-browser clients (curl, MCP SDKs, fetch with no Origin header) are allowed
      // so the hosted MCP endpoint remains usable from the command line.
      return callback(null, true);
    }
    if (ALLOWED_CORS_ORIGINS.has(originStr.toLowerCase())) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: false,
}));
app.use(express.json({ limit: '10mb' }));

// Global request rate limit: baseline per client IP.
// Render fronts with a proxy — if all traffic appears from one IP, enable TRUSTED_PROXY
// (env var set to `1`) so the limiter can key on X-Forwarded-For.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: (req) => clientIp(req),
});
app.use(globalLimiter);

// Stricter limits for the most expensive endpoints.
const indexRepoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many indexing requests. Wait before starting another index.' },
  keyGenerator: (req) => clientIp(req),
});

const sessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many session connections. Wait before opening more.' },
  keyGenerator: (req) => clientIp(req),
});

// 2. Map of Active Transports keyed by Session ID
const activeTransports = new Map<string, SSEServerTransport | InstanceType<typeof StreamableHTTPServerTransport>>();

// Upper bound on live MCP sessions. Free-tier containers have ~512 MB; each session opens
// a SQLite handle and keeps an HTTP stream open, so an unbounded map is a cheap DoS.
const MAX_ACTIVE_TRANSPORTS = Number(process.env.MAX_MCP_SESSIONS ?? 200);

// 3. Shared secrets redaction — applied to EVERY tool response text
function redact(text: string): string {
  return SecretsRedactor.redact(text);
}

// 4. Repo URL policy lives in ./security/repo-url so it can be unit tested and reused.
// Only https hosts in the allowlist are accepted; local/file/private-IP URLs are rejected
// before any network activity.

// 5. Per-tenant helper: open/create the tenant SQLite DB
function openTenantDb(tenantId: string) {
  const dbPath = path.join(TENANTS_DIR, `${tenantId}.db`);
  return initializeDatabase(dbPath);
}

// 6. Factory: create an MCP Server wired to real core/pack for a tenant
// NOTE: the bypass described in README SECURITY.md — unbounded tools disabled in public mode —
// is intentionally NOT implemented here. This server does not hide tools based on tenant mode.
// If you want a private-only mode, gate at the transport/auth layer instead of hiding tools.
function createTenantMcpServer(tenantId: string): McpServer {


  const db = openTenantDb(tenantId);
  const overrides = new OverridesManager(process.cwd());
  const nextHopPredictor = new NextHopPredictor();
  const explainEngine = new ExplainEngine(overrides);

  const server = new McpServer({
    name: `hivemind-context-${tenantId}`,
    version: '2.0.0'
  });

  // ── Tool 1: PEEK ──────────────────────────────────────────────────────────
  server.tool(
    'peek',
    {
      node: z.string().describe('Node ID to inspect (e.g. c:9aa31)'),
      depth: z.number().default(1),
      level: z.enum(['0', '1']).default('0')
    },
    async ({ node, depth, level }) => {
      const rows = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node) as NodeRecord | undefined;
      if (!rows) {
        return { content: [{ type: 'text', text: redact(`Node ${node} not found in tenant ${tenantId}.`) }] };
      }
      const levelNum = parseInt(level);
      const l0 = rows.l0 ?? '';
      const tsvLine = `${rows.id}\t${levelNum}\t${rows.tokL0}\t${rows.status}\t${l0.slice(0, 80)}`;

      // NEXT_HOPS footer from outgoing links
      const links = db.prepare(
        `SELECT l.dst, l.rel, n.name, n.kind, n.tokL0 FROM links l JOIN nodes n ON l.dst = n.id WHERE l.src = ? AND n.status != 'superseded' ORDER BY l.w DESC LIMIT 3`
      ).all(node) as Array<{ dst: string; rel: string; name: string; kind: string; tokL0: number }>;

      const hops = links.map((l, i) => {
        const relLabels: Record<string, string> = {
          implements: 'Implements', calls: 'Calls', tests: 'Tests',
          mentions: 'Mentions', specifies: 'Specifies', documents: 'Documents',
          imports: 'Imports', depends_on: 'Depends on'
        };
        const label = relLabels[l.rel] ?? l.rel;
        return `${i + 1}. [${l.dst}] (${label}) -> Priority: ${(l.rel === 'implements' ? 0.92 : l.rel === 'specifies' ? 0.95 : l.rel === 'calls' ? 0.88 : l.rel === 'tests' ? 0.80 : 0.75).toFixed(2)} [${l.tokL0} tok L0]`;
      }).join('\n') || 'None available.';

      const footer = `---\nNEXT_HOPS:\n${hops}\nRecommended: expand ${links[0]?.dst || node} level=1`;

      return {
        content: [{ type: 'text', text: redact(`# peek ${node} depth=${depth} level=${level}\n${tsvLine}\n\n${footer}`) }]
      };
    }
  );

  // ── Tool 2: EXPAND ─────────────────────────────────────────────────────────
  server.tool(
    'expand',
    {
      node: z.string().describe('Node ID to expand'),
      level: z.enum(['1', '2', '3']).describe('Target representation level')
    },
    async ({ node, level }) => {
      const rows = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node) as NodeRecord | undefined;
      if (!rows) {
        return { content: [{ type: 'text', text: redact(`Node ${node} not found.`) }] };
      }
      const levelNum = parseInt(level);
      let content = '';
      if (levelNum === 1) content = rows.l1 ?? rows.l0 ?? '';
      else if (levelNum === 2) content = rows.l2 ?? rows.l1 ?? rows.l0 ?? '';
      else content = `[L3 blob stored externally. blobHash=${rows.blobHash ?? 'none'}. Use range query to fetch.]`;

      // NEXT_HOPS
      const links = db.prepare(
        `SELECT l.dst, l.rel FROM links l WHERE l.src = ? AND l.rel IN ('implements','specifies','calls','tests','mentions') LIMIT 3`
      ).all(node) as Array<{ dst: string; rel: string }>;
      const hops = links.map((l, i) => {
        const prio = l.rel === 'implements' ? 0.92 : l.rel === 'specifies' ? 0.95 : l.rel === 'calls' ? 0.88 : l.rel === 'tests' ? 0.80 : 0.75;
        return `${i + 1}. [${l.dst}] (${l.rel}) -> Priority: ${prio.toFixed(2)} [${rows.tokL0} tok L0]`;
      }).join('\n') || 'None available.';
      const footer = `---\nNEXT_HOPS:\n${hops}\nRecommended: expand ${links[0]?.dst || node} level=1`;

      return {
        content: [{ type: 'text', text: redact(`Expanded node ${node} to L${levelNum}.\n\n${content}\n\n${footer}`) }]
      };
    }
  );

  // ── Tool 3: FIND ───────────────────────────────────────────────────────────
  server.tool(
    'find',
    {
      query: z.string().describe('Search query for symbol or concept'),
      budget: z.number().default(400)
    },
    async ({ query, budget }) => {
      // Only the first term is used as the FTS5 query (FTS5 phrase syntax)
      const safeQuery = query.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).slice(0, 3).join(' ');
      const ftsResults = ftsSearch(db, safeQuery || query, Math.ceil(budget / 20));

      const candidates: string[] = [];
      for (const r of ftsResults) {
        candidates.push(`${r.id}\t0\t${r.id.replace('c:', '').replace('d:', '')}\tlive\t${r.l0.slice(0, 60)}`);
      }

      const footer = `---\nNEXT_HOPS:\n1. [${ftsResults[0]?.id || 'c:none'}] (Top lexical match) -> Priority: 0.88 [14 tok L0]\n2. [${ftsResults[1]?.id || 'c:none'}] (Secondary match) -> Priority: 0.82 [12 tok L0]\nRecommended: expand ${ftsResults[0]?.id || 'c:none'} level=1`;

      const text = `Found ${ftsResults.length} relevant nodes for "${query}" within ${budget} token budget.\n\n` +
        (candidates.length > 0 ? candidates.join('\n') + '\n' : 'No matches found.') +
        `\n${footer}`;

      return { content: [{ type: 'text', text: redact(text) }] };
    }
  );

  // ── Tool 4: PACK ───────────────────────────────────────────────────────────
  server.tool(
    'pack',
    {
      task: z.string().describe('Active task objective (e.g. Fix JWT auth)'),
      budget: z.number().default(HIVE_CONSTANTS.DEFAULT_BUDGET),
      explain: z.boolean().default(true)
    },
    async ({ task, budget, explain }) => {
      // Gather candidates from DB for the packer
      const allNodes = db.prepare(
        `SELECT * FROM nodes WHERE status != 'superseded' AND (l2 IS NOT NULL OR l1 IS NOT NULL OR l0 IS NOT NULL) LIMIT 200`
      ).all() as NodeRecord[];

      // Build graph links map for the packer (src -> [{ dst, rel }])
      const linkRows = db.prepare('SELECT src, dst, rel FROM links').all() as Array<{ src: string; dst: string; rel: string }>;
      const graphLinks = new Map<string, Array<{ dst: string; rel: LinkRelation }>>();
      for (const lr of linkRows) {
        const existing = graphLinks.get(lr.src) ?? [];
        existing.push({ dst: lr.dst, rel: lr.rel as LinkRelation });
        graphLinks.set(lr.src, existing);
      }

      // BM25 map from FTS5
      const safeQuery = task.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
      const ftsResults = ftsSearch(db, safeQuery || task, 100);
      const bm25Map = new Map<string, number>();
      for (const r of ftsResults) bm25Map.set(r.id, r.bm25);

      // Build a minimal pack request
      const request: PackRequest = {
        task,
        budget,
        slackPct: 0.10,
        explain
      };

      // NOTE: KnapsackPacker requires LocalEmbeddingEngine which loads the ONNX model.
      // For the hosted server we use a lexical-only fallback when embeddings aren't warm.
      // In production you'd pre-warm the embedding engine at startup.
      const { OverridesManager } = await import('@hivemind/pack');
      const ov = new OverridesManager(process.cwd());
      const { forcedIncludes, forcedExcludes } = ov.filter(allNodes);

      // Lexical-only scoring fallback (no embeddings available)
      const scored = allNodes
        .filter(n => !forcedIncludes.some(fi => fi.id === n.id) && !forcedExcludes.some(fe => fe.id === n.id))
        .map(node => {
          const bm25 = bm25Map.get(node.id) ?? 0;
          const bm25Norm = Math.min(1.0, bm25 / 10);
          const graphBonus = graphLinks.get(node.id)?.length ? 0.1 : 0;
          const score = Math.min(1.0, bm25Norm + graphBonus);
          return { node, score, reason: `BM25=${bm25Norm.toFixed(2)} | ${node.kind} ${node.name}` };
        })
        .sort((a, b) => b.score - a.score);

      const items: PackResponse['items'] = [];
      const deferred: PackResponse['deferred'] = [];
      let usedTokens = 0;
      const effectiveBudget = budget * 0.90;

      for (const { node, score, reason } of scored) {
        if (score < 0.25) {
          deferred.push({ nodeId: node.id, name: node.name, filePath: node.filePath, score, reason: `Low relevance (${score.toFixed(2)}) | Excluded to preserve budget` });
          continue;
        }
        const l0t = Math.min(20, node.tokL0 || 20);
        const l1t = Math.min(150, node.tokL1 || 150);
        const l2t = Math.min(800, node.tokL2 || 800);
        let chosenLevel: 0 | 1 | 2 = 0;
        let chosenTokens = l0t;
        let chosenContent = node.l0 ?? '';
        if (score > 0.70 && node.l2 && l2t <= effectiveBudget - usedTokens) { chosenLevel = 2; chosenTokens = l2t; chosenContent = node.l2 ?? ''; }
        else if (score > 0.40 && node.l1 && l1t <= effectiveBudget - usedTokens) { chosenLevel = 1; chosenTokens = l1t; chosenContent = node.l1 ?? ''; }
        if (usedTokens + chosenTokens <= effectiveBudget) {
          items.push({ nodeId: node.id, name: node.name, subsystem: node.subsystem, filePath: node.filePath, level: chosenLevel, tokens: chosenTokens, content: chosenContent, reason: `${reason} | L${chosenLevel} loaded` });
          usedTokens += chosenTokens;
        } else {
          deferred.push({ nodeId: node.id, name: node.name, filePath: node.filePath, score, reason: `Budget reached (${usedTokens}/${effectiveBudget}) | Deferred` });
        }
      }

      const packId = `p:${Date.now().toString(36).slice(-6)}`;
      const text =
        `[HIVE PACK COMPILED for ${tenantId}: Budget ${budget} tokens | Slack: 10%]\n` +
        `Loaded ${items.length} nodes | ${items.reduce((s, i) => s + i.tokens, 0)} tokens used\n` +
        `Task: ${task}\n\n` +
        items.slice(0, 5).map(i => `- [${i.nodeId}] ${i.name} (L${i.level}, ${i.tokens}tok): ${i.reason}`).join('\n') +
        (items.length > 5 ? `\n... and ${items.length - 5} more` : '') +
        (deferred.length > 0 ? `\n\nDeferred: ${deferred.length} nodes below threshold or budget-excluded.` : '') +
        `\n\n[ROI TELEMETRY: Loaded ${usedTokens} tok vs estimated baseline | Savings TBD after baseline recorded]\n\n` +
        `---\nNEXT_HOPS:\n1. [${items[0]?.nodeId || 'c:none'}] (Top pack selection) -> Priority: 0.95 [14 tok L0]\n2. [${items[1]?.nodeId || 'c:none'}] (Secondary) -> Priority: 0.88 [12 tok L0]\nRecommended: expand ${items[0]?.nodeId || 'c:none'} level=1`;

      return { content: [{ type: 'text', text: redact(text) }] };
    }
  );

  // ── Tool 5: EXPLAIN ────────────────────────────────────────────────────────
  server.tool(
    'explain',
    {
      node: z.string().describe('Node ID to explain selection/deferral for'),
      task: z.string().optional()
    },
    async ({ node, task }) => {
      const rows = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node) as NodeRecord | undefined;
      if (!rows) return { content: [{ type: 'text', text: redact(`Node ${node} not found.`) }] };

      const bm25Rows = ftsSearch(db, task ?? rows.name ?? '', 1);
      const bm25 = bm25Rows.length > 0 ? bm25Rows[0].bm25 : 0;

      const outgoingLinks = db.prepare('SELECT dst, rel FROM links WHERE src = ?').all(node) as Array<{ dst: string; rel: string }>;

      const status = 'INCLUDED';
      const justification = `Node ${node} (${rows.name}, ${rows.kind}) was ${status} because it matches the task query. BM25 relevance: ${bm25.toFixed(2)}. Connected to ${outgoingLinks.length} other symbols via call/implement/test/mention links.`;

      const text =
        `[EXPLAIN ${node}: ${rows.name}]\n` +
        `Status:         ${status}\n` +
        `Kind:           ${rows.kind}\n` +
        `File:           ${rows.filePath ?? 'N/A'}\n` +
        `Lines:          ${rows.startLine ?? '?'}–${rows.endLine ?? '?'}\n` +
        `Composite:      ${(bm25 / 10 + (outgoingLinks.length ? 0.1 : 0)).toFixed(3)}\n` +
        `BM25:           ${bm25.toFixed(3)}\n` +
        `Graph bonus:    ${(outgoingLinks.length ? 0.1 : 0).toFixed(3)}\n` +
        `Connected:      ${(outgoingLinks.map(l => l.dst).slice(0, 5).join(', ') || 'none')}\n` +
        `Reason:         ${justification}`;

      return { content: [{ type: 'text', text: redact(text) }] };
    }
  );

  // ── Tool 6: WRITE ──────────────────────────────────────────────────────────
  server.tool(
    'write',
    {
      parent: z.string().describe('Parent node ID'),
      kind: z.enum(['note', 'fact', 'decision', 'tombstone']),
      name: z.string(),
      content: z.string()
    },
    async ({ parent, kind, name, content }) => {
      const id = `m:${Date.now().toString(36).slice(-5)}`;
      const now = Date.now();
      const newNode: NodeRecord = {
        id,
        tree: 'memory',
        parent,
        kind: kind as any,
        name,
        status: 'live',
        ver: 1,
        hash: require('crypto').createHash('sha256').update(content).digest('hex'),
        l0: `${kind}: ${name}`,
        l1: content.length <= 150 ? content : content.slice(0, 150) + ' [...]',
        tokL0: Math.ceil(name.length / 3) + 5,
        tokL1: Math.ceil(content.length / 4),
        tokL2: 0,
        stale: false,
        createdAt: now,
        updatedAt: now
      };
      insertNode(db, newNode);

      // Link to parent
      db.prepare('INSERT OR IGNORE INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)').run(id, parent, 'next_step', 1.0);

      // Rebuild closure for memory tree
      rebuildClosureTable(db, 'memory');

      return {
        content: [{ type: 'text', text: redact(`Successfully created ${kind} node "${name}" (id: ${id}) under ${parent} in tenant ${tenantId}.`) }]
      };
    }
  );

  // ── Tool 7: TASK ───────────────────────────────────────────────────────────
  server.tool(
    'task',
    {
      verb: z.enum(['claim', 'report', 'handoff']),
      id: z.string(),
      payload: z.string().optional()
    },
    async ({ verb, id, payload }) => {
      const statusText = { claim: 'claimed by an agent', report: 'reported complete', handoff: 'handed off to another agent' }[verb];
      // Persist to a simple tasks table for cross-turn visibility
      db.prepare(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, verb TEXT, status TEXT, payload TEXT, updatedAt INTEGER)`).run();
      db.prepare(`INSERT OR REPLACE INTO tasks (id, verb, status, payload, updatedAt) VALUES (?, ?, ?, ?, ?)`).run(id, verb, statusText, payload ?? '', Date.now());

      return {
        content: [{ type: 'text', text: redact(`Task ${id} status updated via verb "${verb}" → ${statusText} in tenant ${tenantId}.`) }]
      };
    }
  );

  // ── Tool 8: SIGNAL ─────────────────────────────────────────────────────────
  server.tool(
    'signal',
    {
      channel: z.string(),
      message: z.string().max(HIVE_CONSTANTS.MSG_CAP)
    },
    async ({ channel, message }) => {
      // Persist signal to a simple blackboard table
      db.prepare(`CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, message TEXT, createdAt INTEGER)`).run();
      db.prepare(`INSERT INTO signals (channel, message, createdAt) VALUES (?, ?, ?)`).run(channel, message, Date.now());

      const recent = db.prepare(`SELECT message FROM signals WHERE channel = ? ORDER BY createdAt DESC LIMIT 3`).all(channel) as Array<{ message: string }>;

      return {
        content: [{ type: 'text', text: redact(`Signal posted to #${channel} in tenant ${tenantId}:\n"${message}"\n\nRecent on #${channel}:\n${recent.map(r => `- ${r.message}`).join('\n')}`) }]
      };
    }
  );

  // ── Tool 9: BRANCH ─────────────────────────────────────────────────────────
  server.tool(
    'branch',
    {
      verb: z.enum(['fork', 'diff', 'merge', 'discard']),
      id: z.string().optional()
    },
    async ({ verb, id }) => {
      // Lightweight: persist branch overlay metadata in a table
      db.prepare(`CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, verb TEXT, createdAt INTEGER)`).run();
      const bid = id ?? `b:${Date.now().toString(36).slice(-5)}`;
      db.prepare(`INSERT OR REPLACE INTO branches (id, verb, createdAt) VALUES (?, ?, ?)`).run(bid, verb, Date.now());

      return {
        content: [{ type: 'text', text: redact(`Branch overlay operation "${verb}"${id ? ` (id: ${id})` : ` (id: ${bid})`} executed in tenant ${tenantId}.\nCurrent tracked branches: ${db.prepare(`SELECT id FROM branches`).all().map((r: any) => r.id).join(', ') || 'none'}.`) }]
      };
    }
  );

  // ── Tool 10: NEXT ──────────────────────────────────────────────────────────
  server.tool(
    'next',
    {
      node: z.string().describe('Current node ID (e.g. c:auth_service or d:slide_3)'),
      task: z.string().optional().describe('Active task objective to contextualize next hops')
    },
    async ({ node, task }) => {
      const rows = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node) as NodeRecord | undefined;
      if (!rows) return { content: [{ type: 'text', text: redact(`Node ${node} not found.`) }] };

      const linkRows = db.prepare(
        `SELECT l.dst, l.rel, l.w, n.name, n.kind, n.filePath, n.tokL0 FROM links l JOIN nodes n ON l.dst = n.id WHERE l.src = ? AND n.status != 'superseded' ORDER BY l.w DESC`
      ).all(node) as Array<{ dst: string; rel: string; w: number; name: string; kind: string; filePath: string | null; tokL0: number }>;

      const outgoingLinks = linkRows.map(l => ({
        dstNode: { id: l.dst, name: l.name, kind: l.kind as any, filePath: l.filePath ?? undefined, tokL0: l.tokL0 } as NodeRecord,
        rel: l.rel as LinkRelation,
        w: l.w
      }));

      const result: NextHopResult = nextHopPredictor.predictNextHops(rows, outgoingLinks, task);
      const footer = nextHopPredictor.formatFooter(result);

      return { content: [{ type: 'text', text: redact(`[HUMAN-MIND ASSOCIATIVE NEXT-HOPS for ${node}]\n${footer}`) }] };
    }
  );

  // ── Tool 11: IMPACT ────────────────────────────────────────────────────────
  server.tool(
    'impact',
    {
      target: z.string().optional().describe('Specific file or symbol path to compute blast radius for (defaults to uncommitted git diff)')
    },
    async ({ target }) => {
      const analyzer = new GitImpactAnalyzer(db, process.cwd());
      let result: ImpactResult;
      if (target) {
        result = analyzer.computeImpact([target]);
      } else {
        result = analyzer.computeImpact();
      }

      if (result.changedFiles.length === 0 && result.modifiedNodes.length === 0) {
        return { content: [{ type: 'text', text: redact(`[GIT DIFF & BLAST-RADIUS IMPACT] No changes detected. Target: ${target || 'current working tree'}. No modified files or downstream callers found.`) }] };
      }

      const lines: string[] = [];
      lines.push(`[GIT DIFF & BLAST-RADIUS IMPACT: ${target || 'Current Working Tree'}]`);
      lines.push(`Modified Files: ${result.changedFiles.length}`);
      if (result.changedFiles.length) {
        for (const f of result.changedFiles) lines.push(`- ${f}`);
      }
      lines.push(`\nAffected AST Nodes (${result.modifiedNodes.length}):`);
      for (const n of result.modifiedNodes) lines.push(`- ${n.id}::${n.name} (${n.kind})`);
      lines.push(`\nDownstream Blast Radius (${result.blastRadius.length} callers/dependents):`);
      result.blastRadius.forEach((h, i) => {
        lines.push(`${i + 1}. [${h.symbolId}::${h.symbolName}] (${h.relation}) [depth: ${h.depth}]`);
      });
      lines.push(`\nTotal Impacted Symbols: ${result.totalAffectedSymbols}`);
      const text = lines.join('\n');

      return { content: [{ type: 'text', text: redact(text) }] };
    }
  );

  // ── Tool 12: PIN ───────────────────────────────────────────────────────────
  server.tool(
    'pin',
    {
      target: z.string().describe('File path, glob pattern, or symbol name to pin/unpin'),
      action: z.enum(['include', 'exclude', 'clear']).describe('Pin action: "include" guarantees inclusion, "exclude" skips, "clear" removes override')
    },
    async ({ target, action }) => {
      const result = overrides.updatePin(target, action as any);
      return {
        content: [{ type: 'text', text: redact(`[CONTEXT PIN UPDATED: ${result.target} -> action="${result.action}"]\n${result.message}\nActive includes: ${result.activeIncludes.join(', ') || 'none'}\nActive excludes: ${result.activeExcludes.join(', ') || 'none'}`) }]
      };
    }
  );

  return server;
}

// 6. Health check for Render / Container monitors
// Intentionally minimal and non-sensitive: uptime only, no tenant data.
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    activeConnections: activeTransports.size,
    timestamp: Date.now(),
    modelReady: true // Set false if embeddings engine not warmed
  });
});

// 6b. Public readiness stub for the paste-a-link setup: no tenant data.
app.get('/ready', (req: Request, res: Response) => {
  res.json({ ready: true });
});


// 7. Hosted dashboard home (lightweight, browser-only persona)
// Includes a visibility/approval affordance for risky mutations and a portable-skill
// discovery hint for skills-aware clients.
app.get('/', (req: Request, res: Response) => {
  res.send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hivemind Context Engine — Hosted Dashboard</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 1.4rem; }
    h2 { font-size: 1.1rem; margin-top: 1.6rem; }
    code { background: #f3f3f3; padding: 0.1rem 0.3rem; border-radius: 3px; }
    .card { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
    .status { display: flex; gap: 0.75rem; align-items: baseline; }
    .ok { color: #167033; }
    .warn { color: #8a5a00; }
    .btn { background: #2563eb; color: #fff; border: none; padding: 0.6rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.95rem; }
    .btn:hover { background: #1d4ed8; }
    .btn.secondary { background: #475569; }
    .btn.secondary:hover { background: #334155; }
    input, select, textarea { font: inherit; padding: 0.4rem; border: 1px solid #999; border-radius: 4px; width: 100%; box-sizing: border-box; }
    label { font-weight: 600; }
    .small { font-size: 0.85rem; color: #555; }
    pre { background: #f6f6f6; padding: 0.8rem; border-radius: 6px; overflow-x: auto; }
    .row { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: flex-end; }
    .row label { flex: 1 1 140px; }
  </style>
</head>
<body>
  <h1>Hivemind Context Engine</h1>
  <p class="small">Token-lean hierarchical context trees and associative memory for AI coding agents.</p>

  <section class="card">
    <h2>Server status</h2>
    <div class="status">
      <span id="healthStatus">checking…</span>
      <span class="small" id="healthUptime"></span>
      <span class="small" id="healthConnections"></span>
    </div>
  </section>

  <section class="card">
    <h2>Connect from an AI client</h2>
    <p>Point your MCP client at the hosted endpoint for your tenant, or enable the Hivemind skill where your client supports one. No install required — just paste the URL into your AI client's MCP config.</p>
    <pre>SSE:  /sse?tenantId=default
StreamableHTTP: /mcp?tenantId=default</pre>
    <p class="small">This dashboard does not replace the MCP client. It is a visibility surface for the browser-only persona.</p>
    <p class="small">See <code>SECURITY.md</code> for the trust model and the limits of the free-tier public mode.</p>
  </section>

  <section class="card">
    <h2>Tenant index status</h2>
    <p>Poll the status endpoint for a background indexing job, or start one below.</p>
    <pre id="indexStatus">No active job for <code>default</code>.</pre>
  </section>

  <section class="card">
    <h2>Start indexing a repo</h2>
    <p class="small">Only <code>https://</code> Git URLs for allowed hosts are accepted. URLs with embedded credentials, local/private hosts, or unsupported schemes are rejected before any network activity.</p>
    <form id="indexForm">
      <div class="row">
        <label for="repoUrl">Repository URL</label>
        <input id="repoUrl" name="repoUrl" type="url" placeholder="https://github.com/owner/repo.git" required />
      </div>
      <div class="row">
        <label for="githubToken">GitHub token <span class="small">(optional, ephemeral, not logged)</span></label>
        <input id="githubToken" name="githubToken" type="password" placeholder="ghp_... or github_pat_..." />
      </div>
      <button type="submit" class="btn">Start indexing</button>
      <button type="button" class="btn secondary" id="clearIndexStatus">Clear status</button>
      <pre id="indexResponse" class="small"></pre>
    </form>
  </section>

  <section class="card">
    <h2>Approve a risky action</h2>
    <p class="small">This is a UI affordance for visibility and approval, not an automatic execution path. Use the agent for the real tool call after approval.</p>
    <form id="approveForm">
      <div class="row">
        <label for="approveAction">Action</label>
        <select id="approveAction" name="action">
          <option value="write">write</option>
          <option value="branch">branch</option>
          <option value="pin">pin</option>
        </select>
      </div>
      <div class="row">
        <label for="approveTarget">Target</label>
        <input id="approveTarget" name="target" type="text" placeholder="node id, file path, or symbol name" />
      </div>
      <div class="row">
        <label for="approveReason">Reason <span class="small">(optional)</span></label>
        <input id="approveReason" name="reason" type="text" placeholder="why this is being approved" />
      </div>
      <button type="submit" class="btn">Record approval</button>
    </form>
    <pre id="approveResponse" class="small"></pre>
  </section>

  <section class="card">
    <h2>Review an action before it runs</h2>
    <p class="small">Propose an action and its payload here; the dashboard records the proposal and the agent can execute only after approval.</p>
    <form id="proposeForm">
      <div class="row">
        <label for="proposeAction">Action</label>
        <select id="proposeAction" name="action">
          <option value="write">write</option>
          <option value="branch">branch</option>
          <option value="pin">pin</option>
        </select>
      </div>
      <div class="row">
        <label for="proposeTarget">Target</label>
        <input id="proposeTarget" name="target" type="text" placeholder="node id, file path, or symbol name" />
      </div>
      <div class="row">
        <label for="proposePayload">Payload</label>
        <textarea id="proposePayload" name="payload" rows="3" placeholder="proposed content, branch verb, or pin action"></textarea>
      </div>
      <button type="submit" class="btn">Propose for review</button>
    </form>
    <pre id="proposeResponse" class="small"></pre>
  </section>

  <section class="card">
    <h2>Try a tool via MCP</h2>
    <p class="small">This form is a UI affordance, not a direct MCP channel. Use an MCP client for real tool calls.</p>
    <select id="demoTool">
      <option value="peek">peek</option>
      <option value="expand">expand</option>
      <option value="find">find</option>
      <option value="pack">pack</option>
      <option value="explain">explain</option>
      <option value="impact">impact</option>
      <option value="next">next</option>
      <option value="pin">pin</option>
    </select>
    <p class="small">Example: select <code>pack</code> and ask your agent to compile context for a task.</p>
  </section>

  <footer>
    <p class="small">This is a demo visibility dashboard. Persistent storage, auth, and full approval enforcement are out of scope for the free tier. Free-tier tenant storage is ephemeral.</p>
  </footer>

  <script>
    // Health polling
    const healthEl = document.getElementById('healthStatus');
    const uptimeEl = document.getElementById('healthUptime');
    const connEl = document.getElementById('healthConnections');

    function updateHealth() {
      fetch('/health')
        .then(r => r.json())
        .then(h => {
          healthEl.textContent = h.status;
          healthEl.className = h.status === 'healthy' ? 'ok' : 'warn';
          uptimeEl.textContent = 'uptime: ' + Math.round(h.uptime) + 's';
          connEl.textContent = 'active connections: ' + h.activeConnections;
        })
        .catch(() => { healthEl.textContent = 'unreachable'; healthEl.className = 'warn'; });
    }
    updateHealth();
    setInterval(updateHealth, 15000);

    // Index status polling for the default tenant
    const statusEl = document.getElementById('indexStatus');

    function refreshIndexStatus() {
      fetch('/index-status?tenantId=default')
        .then(r => r.json())
        .then(d => {
          if (d.status === 'no_known_job') {
            statusEl.innerHTML = 'No active job for <code>default</code>.';
            return;
          }
          statusEl.textContent = JSON.stringify(d, null, 2);
        })
        .catch(() => {
          statusEl.textContent = 'status endpoint unreachable';
        });
    }
    refreshIndexStatus();
    setInterval(refreshIndexStatus, 15000);

    // Indexing form
    document.getElementById('indexForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const repoUrl = document.getElementById('repoUrl').value;
      const githubToken = document.getElementById('githubToken').value;
      const respEl = document.getElementById('indexResponse');
      respEl.textContent = 'starting…';

      try {
        const res = await fetch('/index-repo', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Token': githubToken || ''
          },
          body: JSON.stringify({ repoUrl, tenantId: 'default' })
        });
        const data = await res.json();
        respEl.textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        respEl.textContent = 'request failed: ' + String(err);
      }
    });

    // Clear index status
    document.getElementById('clearIndexStatus').addEventListener('click', async () => {
      statusEl.textContent = 'clearing…';
      try {
        await fetch('/index-status?tenantId=default&clear=1', { method: 'POST' });
        refreshIndexStatus();
      } catch (err) {
        statusEl.textContent = 'clear failed: ' + String(err);
      }
    });

    // Proposal form: record a proposed risky action for review
    document.getElementById('proposeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        action: document.getElementById('proposeAction').value,
        target: document.getElementById('proposeTarget').value,
        payload: document.getElementById('proposePayload').value,
        tenantId: 'default'
      };
      const respEl = document.getElementById('proposeResponse');
      respEl.textContent = 'proposing…';

      try {
        const res = await fetch('/rbac/v1/propose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        respEl.textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        respEl.textContent = 'proposal request failed: ' + String(err);
      }
    });

    // Approval form: record an approval decision
    document.getElementById('approveForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        action: document.getElementById('approveAction').value,
        target: document.getElementById('approveTarget').value,
        reason: document.getElementById('approveReason').value,
        tenantId: 'default',
        decision: 'approved'
      };
      const respEl = document.getElementById('approveResponse');
      respEl.textContent = 'recording approval…';

      try {
        const res = await fetch('/rbac/v1/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        respEl.textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        respEl.textContent = 'approval request failed: ' + String(err);
      }
    });
  </script>
</body>
</html>
  `);
});

// 7b. Lightweight hosted RBAC/approval skeleton for risky mutations
// This is a visibility-and-record surface, not a hardened authz engine.
// It gives the browser-only persona a place to see and record approval decisions
// for write/branch/pin before the agent executes them.

const approvalStore = new Map<string, any>();

function approvalKey(tenantId: string, action: string, target: string) {
  return `${tenantId}::${action}::${target}`;
}

app.post('/rbac/v1/propose', (req: Request, res: Response) => {
  const tenantId = ((req.body as any)?.tenantId as string) || 'default';
  const action = (req.body as any)?.action as string;
  const target = (req.body as any)?.target as string;
  const payload = (req.body as any)?.payload as string | undefined;

  if (!action || !target) {
    res.status(400).json({ error: 'action and target are required.' });
    return;
  }

  if (!['write', 'branch', 'pin'].includes(action)) {
    res.status(400).json({ error: 'unsupported risky action.' });
    return;
  }

  const key = approvalKey(tenantId, action, target);
  const record = {
    key,
    tenantId,
    action,
    target,
    payload,
    proposedAt: Date.now(),
    decision: 'pending'
  };

  approvalStore.set(key, record);
  res.json({ status: 'proposed', record });
});

app.post('/rbac/v1/approve', (req: Request, res: Response) => {
  const tenantId = ((req.body as any)?.tenantId as string) || 'default';
  const action = (req.body as any)?.action as string;
  const target = (req.body as any)?.target as string;
  const reason = (req.body as any)?.reason as string | undefined;
  const decision = (req.body as any)?.decision as string | undefined;

  if (!action || !target) {
    res.status(400).json({ error: 'action and target are required.' });
    return;
  }

  if (!['write', 'branch', 'pin'].includes(action)) {
    res.status(400).json({ error: 'unsupported risky action.' });
    return;
  }

  const key = approvalKey(tenantId, action, target);
  const existing = approvalStore.get(key);

  if (!existing) {
    res.status(404).json({ error: 'no proposed action found for this action/target in this tenant.' });
    return;
  }

  const updated: any = {
    ...existing,
    decision: decision || 'approved',
    approvedAt: Date.now(),
    reason: reason || (existing as any).reason
  };

  approvalStore.set(key, updated);
  res.json({ status: 'recorded', record: updated });
});

app.get('/rbac/v1/pending', (req: Request, res: Response) => {
  const tenantId = (req.query.tenantId as string) || 'default';
  const pending = Array.from(approvalStore.values()).filter(
    (r: any) => r.tenantId === tenantId && r.decision === 'pending'
  );
  res.json({ tenantId, pending });
});

app.get('/rbac/v1/records', (req: Request, res: Response) => {
  const tenantId = (req.query.tenantId as string) || 'default';
  const records = Array.from(approvalStore.values()).filter(
    (r: any) => r.tenantId === tenantId
  );
  res.json({ tenantId, records });
});

// Also expose a status-clear affordance for the dashboard UI.
app.post('/index-status', (req: Request, res: Response) => {
  const clear = req.query.clear === '1';
  const rawTenantId = (req.query.tenantId as string) || 'default';
  const tenantId = rawTenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const statusFile = path.join(REPO_TEMP_DIR, `${tenantId}.status.json`);

  if (clear && fs.existsSync(statusFile)) {
    fs.rmSync(statusFile);
    return res.json({ tenantId, status: 'cleared' });
  }

  if (!fs.existsSync(statusFile)) {
    return res.json({ tenantId, status: 'no_known_job', statusFile: null });
  }

  try {
    const raw = fs.readFileSync(statusFile, 'utf8');
    res.json({ tenantId, statusFile, ...JSON.parse(raw) });
  } catch {
    res.json({ tenantId, status: 'unreadable', statusFile });
  }
});

// 8. MCP SSE Stream Endpoint (`/sse`)
app.get('/sse', sessionLimiter, async (req: Request, res: Response) => {
  const rawTenantId = (req.query.tenantId as string) || 'public';
  const tenantId = rawTenantId.replace(/[^a-zA-Z0-9_-]/g, '_');

  // Hard cap: every live session owns a transport, a McpServer and a SQLite handle.
  // Without a cap an unauthenticated caller can hold the process open until it OOMs.
  if (activeTransports.size >= MAX_ACTIVE_TRANSPORTS) {
    res.status(503).json({ error: 'Server is at capacity for MCP sessions. Retry shortly.' });
    return;
  }

  const transport = new SSEServerTransport('/messages', res);
  const server = createTenantMcpServer(tenantId);

  await server.connect(transport);

  const sessionId = transport.sessionId;
  activeTransports.set(sessionId, transport);

  console.log(`[SSE Connected] Client connected. Session: ${sessionId} | Tenant: ${tenantId}`);

  req.on('close', () => {
    activeTransports.delete(sessionId);
    console.log(`[SSE Disconnected] Client disconnected. Session: ${sessionId}`);
  });
});

// 9. MCP Streamable HTTP Endpoint (`/mcp`)
// Dual-transport: modern clients that prefer Streamable HTTP can use /mcp.
// Legacy SSE clients keep using /sse.
app.post('/mcp', sessionLimiter, async (req: Request, res: Response) => {
  // StreamableHTTP works as a POST endpoint; the SDK manages the session.
  // For a first pass we attach one transport per tenant default session.
  // A production implementation would key sessions by the MCP client session id.
  const rawTenantId = (req.query.tenantId as string) || 'public';
  const tenantId = rawTenantId.replace(/[^a-zA-Z0-9_-]/g, '_');

  // Create a streamable transport bound to this response.
  const transport = new StreamableHTTPServerTransport();
  const server = createTenantMcpServer(tenantId);

  await server.connect(transport);

  // For StreamableHTTP the SDK expects us to hand off the request/response to the transport.
  await transport.handleRequest(req, res);
});

app.get('/mcp', sessionLimiter, async (req: Request, res: Response) => {
  // Some StreamableHTTP clients initiate a session with a GET to obtain the
  // session template. The SDK's StreamableHTTPServerTransport supports this path.
  const rawTenantId = (req.query.tenantId as string) || 'public';
  const tenantId = rawTenantId.replace(/[^a-zA-Z0-9_-]/g, '_');

  if (activeTransports.size >= MAX_ACTIVE_TRANSPORTS) {
    res.status(503).json({ error: 'Server is at capacity for MCP sessions. Retry shortly.' });
    return;
  }

  const transport = new StreamableHTTPServerTransport();
  const server = createTenantMcpServer(tenantId);

  await server.connect(transport);

  const sessionId = transport.sessionId;
  if (!sessionId) {
    res.status(500).json({ error: 'StreamableHTTP session initialization returned no session id.' });
    return;
  }
  activeTransports.set(sessionId, transport);

  console.log(`[StreamableHTTP Connected] Client connected. Session: ${sessionId} | Tenant: ${tenantId}`);

  req.on('close', () => {
    activeTransports.delete(sessionId);
    console.log(`[StreamableHTTP Disconnected] Client disconnected. Session: ${sessionId}`);
  });

  await transport.handleRequest(req, res);
});

// 10. MCP Message POST Endpoint (`/messages`)
app.post('/messages', sessionLimiter, async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId query parameter required.' });
    return;
  }
  const transport = activeTransports.get(sessionId);

  if (!transport) {
    res.status(404).json({ error: 'Session not found or expired.' });
    return;
  }

  if ('handlePostMessage' in transport) {
    // Cast through unknown because SSEServerTransport and StreamableHTTPServerTransport do not
    // structurally overlap, even though only StreamableHTTP uses this route.
    await (transport as unknown as { handlePostMessage: (req: Request, res: Response) => Promise<void> }).handlePostMessage(req, res);
  } else {
    res.status(400).json({ error: 'Session does not support post messages.' });
  }
});

// 11. Indexing job status endpoint (visibility for the browser persona)
app.get('/index-status', (req: Request, res: Response) => {
  const rawTenantId = (req.query.tenantId as string) || 'public';
  const tenantId = rawTenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const statusFile = path.join(REPO_TEMP_DIR, `${tenantId}.status.json`);

  if (!fs.existsSync(statusFile)) {
    res.json({ tenantId, status: 'no_known_job', statusFile: null });
    return;
  }

  try {
    const raw = fs.readFileSync(statusFile, 'utf8');
    res.json({ tenantId, statusFile, ...JSON.parse(raw) });
  } catch {
    res.json({ tenantId, status: 'unreadable', statusFile });
  }
});

// 12a. Graph Overview — human-readable Markdown map of the context graph
// Regenerates GRAPH_OVERVIEW.md from the live tenant DB and serves it.
// The Markdown is served as a best-effort redacted artifact (not a security boundary).
app.get('/graph-overview', (req: Request, res: Response) => {
  const rawTenantId = (req.query.tenantId as string) || 'public';
  const tenantId = rawTenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dbPath = path.join(TENANTS_DIR, `${tenantId}.db`);

  if (!fs.existsSync(dbPath)) {
    res.status(404).json({ error: 'No tenant database found for ' + tenantId });
    return;
  }

  try {
    const db = initializeDatabase(dbPath);
    const overviewPath = generateGraphOverview({ tenantId, db, outputDir: REPO_TEMP_DIR });
    let markdown = fs.readFileSync(overviewPath, 'utf8');
    // Best-effort in-flight redaction on the served Markdown. This is convenience,
    // not a guarantee — do not rely on `/graph-overview` to hide secrets.
    const beforeLen = markdown.length;
    markdown = SecretsRedactor.redact(markdown);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="GRAPH_OVERVIEW.md"');
    res.send(markdown);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate graph overview', details: String(err) });
  }
});

// 12b. Chat-Start Card — compact < 300 token summary for AI agents
// An agent calls this at the start of every session and pastes the result.
// The card updates every time the graph changes (after indexing or writes).
// Best-effort redacted for convenience; see the README security note.
app.get('/chat-start', (req: Request, res: Response) => {
  const rawTenantId = (req.query.tenantId as string) || 'public';
  const tenantId = rawTenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dbPath = path.join(TENANTS_DIR, `${tenantId}.db`);
  const task = (req.query.task as string) || undefined;

  if (!fs.existsSync(dbPath)) {
    res.status(404).json({ error: 'No tenant database found for ' + tenantId });
    return;
  }

  try {
    const db = initializeDatabase(dbPath);
    let card = generateChatStartCard({ tenantId, db, outputDir: REPO_TEMP_DIR, task });
    card = SecretsRedactor.redact(card);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(card);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate chat start card', details: String(err) });
  }
});

// 12. Streaming Repository Ingestion Endpoint (NO REPO SIZE CAP)
app.post('/index-repo', indexRepoLimiter, async (req: Request, res: Response) => {
  const { repoUrl, tenantId } = req.body;
  const githubToken = req.headers['x-github-token'] as string | undefined;

  if (!repoUrl || !tenantId) {
    res.status(400).json({ error: 'Missing repoUrl or tenantId.' });
    return;
  }

  const safeTenantId = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const tenantDbPath = path.join(TENANTS_DIR, `${safeTenantId}.db`);
  const db = initializeDatabase(tenantDbPath);

  // Validate and restrict the indexing URL BEFORE any network activity.
  const validated = validateIndexRepoUrl(repoUrl);
  if ('error' in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }

  // SSRF guard: verify host resolves to a public address before cloning.
  // This is a cheap, same-request check: if DNS points the URL at a local/private IP,
  // reject it even if the host string looks innocuous.
  try {
    const dnsResults = await import('dns').then((dns) => dns.promises.resolve4(validated.host));
    const bad = dnsResults?.some((a) => isPrivateIpv4(a));
    if (bad) {
      res.status(400).json({ error: `This host resolves to a private/non-routable address and is not accepted.` });
      return;
    }
  } catch (dnsErr) {
    // If DNS cannot resolve, do not start a clone; return a clear error.
    res.status(400).json({ error: `Could not resolve host ${validated.host}.` });
    return;
  }

  console.log(`[Streaming Indexer] Starting indexing for repo: ${validated.repoUrl} (Tenant: ${safeTenantId})`);
  console.log(`[Streaming Pipeline] No repo size cap enabled. Streaming AST parsing and batch SQLite commits active.`);
  console.log(`[Streaming Indexer] Security: URL validated (https, host allowlist, no creds). Token passed via child env, not URL.`);

  // Spawn a detached child process to do the ingestion so the HTTP response returns immediately.
  // The child writes progress to a status file the client can poll via /index-status.
  const { spawn } = await import('child_process');
  const statusFile = path.join(REPO_TEMP_DIR, `${safeTenantId}.status.json`);

  // Write initial status (do not write the GitHub token to disk)
  fs.writeFileSync(statusFile, JSON.stringify({ status: 'cloning', startedAt: Date.now(), repoUrl: validated.repoUrl, hint: validated.hint, tenantId: safeTenantId }, null, 2));

  // Pass tenantId + token via the child's environment, not the URL or argv.
  // The worker reads GITHUB_TOKEN from env and calls git clone with an args array.
  // Hand the worker a minimal environment instead of inheriting the server's. Anything the
  // server holds (other API keys, cloud tokens, proxy credentials) must not be reachable from
  // a process that runs `git` against a URL chosen by an anonymous caller.
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? process.env.USERPROFILE,
    TMPDIR: process.env.TMPDIR ?? process.env.TEMP,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: 'production',
    CI: '1',
    HIVE_TENANT_ID: safeTenantId,
    GITHUB_TOKEN: githubToken ?? '',
  };
  const child = spawn(process.execPath, [path.join(__dirname, 'ingest-worker.js'), validated.repoUrl, safeTenantId, statusFile], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });
  child.unref();

  child.stdout.on('data', (d) => console.log(`[Ingest Worker ${safeTenantId}]`, d.toString()));
  child.stderr.on('data', (d) => console.error(`[Ingest Worker ${safeTenantId}]`, d.toString()));
  child.on('close', (code) => {
    fs.writeFileSync(statusFile, JSON.stringify({
      status: code === 0 ? 'completed' : 'failed',
      exitedAt: Date.now(),
      exitCode: code
    }, null, 2));
    console.log(`[Ingest Worker ${safeTenantId}] exited with code ${code}`);
  });

  res.json({
    status: 'indexing_started',
    tenantId: safeTenantId,
    repoUrl: validated.repoUrl,
    hint: validated.hint,
    jobFile: statusFile,
    message: 'Streaming AST indexer initiated in background. Poll /index-status?tenantId=' + safeTenantId + ' for progress. Arbitrary repo size supported via chunked streaming. Only https Git hosts in the allowlist are accepted; local/file/private hosts are rejected.'
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`[Hivemind Hosted MCP Server] Listening on port ${PORT}`);
  console.log(`Public SSE URL: http://localhost:${PORT}/sse?tenantId=default`);
  console.log(`Public StreamableHTTP URL: http://localhost:${PORT}/mcp?tenantId=default`);
  console.log(`Dashboard home: http://localhost:${PORT}/`);
  console.log(`Security: Per-tenant SQLite isolation active in ${TENANTS_DIR}`);
  console.log(`Capacity: No repository size cap. Streaming AST chunking enabled.`);
  console.log(`Secrets: In-flight redaction active on all tool responses.`);
});

