/**
 * Hivemind Hosted MCP Gateway
 *
 * - Streamable HTTP at /mcp (recommended, stateless, works with modern clients)
 * - Legacy SSE at /sse + POST /messages
 * - Interactive graph UI at /graph (standalone browser page + MCP Apps resource)
 * - Per-tenant SQLite WAL database and workspace isolation
 * - Repository indexing by public/authorized https Git URL
 * - Optional bearer-token auth, health checks, rate limiting, secret redaction
 */

import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SecretsRedactor, generateGraphOverview, generateChatStartCard } from '@hivemind/core';
import { HiveContextService } from './context-service';
import { createHiveMcpServer } from './server';
import { buildGraphPayload, buildNodeDetail, assembleContextPack } from './ui/graph-payload';
import { validateIndexRepoUrl } from './security/repo-url';

export interface HostedServerOptions {
  port?: number;
  dataRoot?: string;
  embeddings?: 'auto' | 'off';
  apiKey?: string;
  corsOrigin?: string;
  maxTenants?: number;
  /** Directory containing graph.html; defaults to dist/ui next to the compiled server. */
  uiDir?: string;
}

interface ActiveSession {
  transport: SSEServerTransport;
  close: () => Promise<void>;
}

const sessions = new Map<string, ActiveSession>();
const tenantServices = new Map<string, HiveContextService>();

/** Close cached tenant databases. Used by graceful shutdown and integration tests. */
export function closeHostedServices(): void {
  for (const service of tenantServices.values()) {
    service.close();
  }
  tenantServices.clear();
  sessions.clear();
}

function sanitizeTenant(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'public';
}

function resolveTenant(req: Request): string {
  const header = req.get('x-hive-tenant');
  const query = typeof req.query.tenantId === 'string' ? req.query.tenantId : 'public';
  const body = (req.body ?? {}) as { tenantId?: unknown };
  const bodyTenant = typeof body.tenantId === 'string' ? body.tenantId : undefined;
  return sanitizeTenant(header || bodyTenant || query);
}

function bearerToken(req: Request): string | undefined {
  const header = req.get('authorization');
  if (header && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, '').trim();
  }
  const apiKeyHeader = req.get('x-api-key');
  if (apiKeyHeader) return apiKeyHeader.trim();
  if (process.env.HIVE_ALLOW_QUERY_KEY === 'true' && typeof req.query.apiKey === 'string') {
    return req.query.apiKey;
  }
  return undefined;
}

function safelyEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createSseApp(options: HostedServerOptions = {}): express.Express {
  const dataRoot = path.resolve(options.dataRoot ?? process.env.HIVE_DATA_ROOT ?? process.cwd());
  const tenantsDir = path.join(dataRoot, '.hive', 'tenants');
  const workspacesDir = path.join(dataRoot, '.hive', 'workspaces');
  fs.mkdirSync(tenantsDir, { recursive: true });
  fs.mkdirSync(workspacesDir, { recursive: true });

  const apiKey = (options.apiKey ?? process.env.HIVE_API_KEY ?? '').trim();
  const configuredTenantLimit = options.maxTenants ?? Number(process.env.HIVE_MAX_TENANTS ?? 50);
  const maxTenants = Number.isFinite(configuredTenantLimit) && configuredTenantLimit > 0
    ? Math.floor(configuredTenantLimit)
    : 50;
  const corsOrigin = options.corsOrigin ?? process.env.HIVE_CORS_ORIGIN ?? '*';

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, frameguard: false }));
  // MCP Apps hosts embed /graph in cross-origin iframes, so framing must stay
  // allowed; frameguard: false above keeps helmet from sending X-Frame-Options.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-GitHub-Token',
      'X-Hive-Tenant',
      'Mcp-Session-Id',
      'Mcp-Protocol-Version',
      'Last-Event-ID'
    ],
    exposedHeaders: ['Mcp-Session-Id'],
    maxAge: 600
  }));
  app.use(express.json({ limit: '10mb' }));
  const configuredRateLimit = Number(process.env.HIVE_RATE_LIMIT ?? 120);
  const rateLimitMax = Number.isFinite(configuredRateLimit) && configuredRateLimit > 0
    ? Math.floor(configuredRateLimit)
    : 120;
  app.use(rateLimit({
    windowMs: 60 * 1000,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
  }));

  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (!apiKey) return next();
    const provided = bearerToken(req);
    if (provided && safelyEqual(apiKey, provided)) return next();
    res.set('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'Unauthorized. Send Authorization: Bearer <HIVE_API_KEY>.' });
  };

  const getService = (rawTenant: string): HiveContextService => {
    const tenantId = sanitizeTenant(rawTenant);
    let service = tenantServices.get(tenantId);
    if (!service) {
      if (tenantServices.size >= maxTenants) {
        throw new Error(`Tenant limit reached (${maxTenants}). Reuse an existing tenantId or raise HIVE_MAX_TENANTS.`);
      }
      service = new HiveContextService({
        tenantId,
        repoRoot: path.join(workspacesDir, tenantId),
        dbPath: path.join(tenantsDir, `${tenantId}.db`),
        allowLocalIndex: false,
        embeddings: options.embeddings ?? (process.env.HIVE_EMBEDDINGS === 'off' ? 'off' : 'auto')
      });
      tenantServices.set(tenantId, service);
    }
    return service;
  };

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'hivemind-mcp',
      version: '2.0.0',
      authRequired: Boolean(apiKey),
      transport: 'Streamable HTTP (recommended) + legacy SSE',
      endpoints: {
        health: 'GET /health',
        mcp: 'POST /mcp?tenantId=default',
        sse: 'GET /sse?tenantId=default',
        messages: 'POST /messages?sessionId=<session>',
        graph: 'GET /graph?tenantId=default',
        graphJson: 'GET /graph.json?tenantId=default',
        graphNode: 'GET /graph/node?tenantId=default&id=<node>',
        graphOverview: 'GET /graph-overview?tenantId=default',
        chatStart: 'GET /chat-start?tenantId=default&task=<task>',
        indexStatus: 'GET /index-status?tenantId=default',
        contextPack: 'POST /graph/context-pack { included, excluded, budget }',
        indexRepo: 'POST /index-repo { "repoUrl": "...", "tenantId": "default" }'
      },
      headers: {
        tenant: 'X-Hive-Tenant (alternative to ?tenantId=)',
        auth: 'Authorization: Bearer <HIVE_API_KEY>',
        github: 'X-GitHub-Token (private repositories, /index-repo only)'
      },
      quickstart: [
        '1. Point your MCP client at POST /mcp?tenantId=default (or /sse for legacy clients).',
        '2. Call the index tool with a public https Git repository URL, or POST /index-repo.',
        '3. Call find, pack, peek, next, or impact — or open /graph to curate context by hand.'
      ]
    });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      version: '2.0.0',
      uptime: process.uptime(),
      activeConnections: sessions.size,
      activeTenants: tenantServices.size,
      timestamp: Date.now()
    });
  });

  // ---------------------------------------------------------------- Streamable HTTP
  app.post('/mcp', requireAuth, async (req: Request, res: Response) => {
    let service: HiveContextService;
    try {
      service = getService(resolveTenant(req));
    } catch (error) {
      res.status(429).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const server = createHiveMcpServer(service, `hivemind-context-${service.tenantId}`);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] Streamable HTTP request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  app.all('/mcp', (_req: Request, res: Response) => {
    res.set('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed. This server runs /mcp in stateless JSON mode; use POST.' });
  });

  // ------------------------------------------------------------------------ Legacy SSE
  app.get('/sse', requireAuth, async (req: Request, res: Response) => {
    let service: HiveContextService;
    try {
      service = getService(resolveTenant(req));
    } catch (error) {
      res.status(429).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const server = createHiveMcpServer(service, `hivemind-context-${service.tenantId}`);
    const transport = new SSEServerTransport('/messages', res);

    try {
      await server.connect(transport);
    } catch (error) {
      console.error('[SSE] Failed to connect transport:', error);
      res.status(500).json({ error: 'MCP transport initialization failed.' });
      return;
    }

    sessions.set(transport.sessionId, {
      transport,
      close: async () => {
        await server.close();
      }
    });

    console.log(`[SSE] Connected session=${transport.sessionId} tenant=${service.tenantId}`);

    req.on('close', () => {
      sessions.delete(transport.sessionId);
      server.close().catch(() => undefined);
      console.log(`[SSE] Disconnected session=${transport.sessionId} tenant=${service.tenantId}`);
    });
  });

  app.post('/messages', requireAuth, async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found or expired.' });
      return;
    }

    try {
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error('[SSE] Message handling failed:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Message handling failed.' });
      }
    }
  });

  // ------------------------------------------------------------------ Indexing endpoint
  app.post('/index-repo', requireAuth, async (req: Request, res: Response) => {
    const { repoUrl, tenantId } = req.body as { repoUrl?: string; tenantId?: string };
    if (!repoUrl || typeof repoUrl !== 'string') {
      res.status(400).json({ error: 'Missing repoUrl.' });
      return;
    }
    if (repoUrl.length > 2048) {
      res.status(400).json({ error: 'repoUrl is too long.' });
      return;
    }
    // Defense in depth on top of the indexer's own checks: https-only, host
    // allowlist, no shell metacharacters, no embedded credentials.
    const validation = validateIndexRepoUrl(repoUrl);
    if ('error' in validation) {
      res.status(400).json({ error: validation.error });
      return;
    }

    try {
      const service = getService(tenantId ?? resolveTenant(req));
      // This token lives only for the duration of the request; it is never
      // written to the database, logs, or the response.
      const githubToken = req.get('x-github-token') ?? undefined;
      const summary = await service.index(validation.repoUrl, githubToken);
      res.json({
        status: 'indexed',
        tenantId: service.tenantId,
        repoUrl,
        summary: {
          filesIndexed: summary.filesIndexed,
          filesSkipped: summary.filesSkipped,
          nodesInserted: summary.nodesInserted,
          linksCreated: summary.linksCreated,
          durationMs: summary.durationMs,
          warnings: summary.errors.length
        }
      });
    } catch (error) {
      const message = SecretsRedactor.redact(error instanceof Error ? error.message : String(error));
      res.status(400).json({ error: message });
    }
  });

  // ------------------------------------------------------------- Interactive graph UI
  // Same page for the standalone browser and MCP Apps hosts. Single file served
  // from dist/ui so it needs no CDN links and no client-side downloads.
  const uiDir = options.uiDir ?? path.join(__dirname, 'ui');
  let graphHtmlCache: string | null = null;
  let graphHtmlCachedMtimeMs = -1;
  let graphHtmlFailedToLog = false;
  const readGraphHtml = (): string => {
    // Cache by file mtime so a dev rebuild lands on the next request without a
    // full restart, while production keeps a single stat() per request.
    try {
      const file = path.join(uiDir, 'graph.html');
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (!graphHtmlCache || mtimeMs !== graphHtmlCachedMtimeMs) {
        graphHtmlCache = fs.readFileSync(file, 'utf8');
        graphHtmlCachedMtimeMs = mtimeMs;
      }
      return graphHtmlCache;
    } catch {
      if (!graphHtmlFailedToLog) console.error('[graph] missing dist/ui/graph.html — ensure copy-ui ran.');
      graphHtmlFailedToLog = true;
      throw new Error('graph.html not available (did copy-ui run?)');
    }
  };

  // The page itself is a static shell with no tenant data. Keeping it public
  // lets a browser open the link while the JSON endpoints stay authenticated;
  // the page prompts for the API key and replays it as an Authorization header.
  app.get('/graph', (_req: Request, res: Response) => {
    try {
      res
        .setHeader('Cache-Control', 'no-store')
        .setHeader(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; font-src 'none'"
        )
        .type('html')
        .send(readGraphHtml());
    } catch (error) {
      // Log the details server-side only; the response stays generic.
      console.error('[HTTP] Graph page request failed:', error);
      res.status(500).json({
        error: 'Graph page was not built. Run npm run build in packages/mcp so dist/ui is populated.'
      });
    }
  });

  app.get('/graph.json', requireAuth, (req: Request, res: Response) => {
    const tenantId = resolveTenant(req);
    const task = typeof req.query.task === 'string' ? req.query.task.slice(0, 200) : undefined;
    try {
      const service = getService(tenantId);
      const payload = buildGraphPayload(service.db, { tenant: tenantId, task });
      // l0/name can carry a pasted secret; redact before it leaves the process.
      for (const node of payload.nodes) {
        node.name = SecretsRedactor.redact(node.name);
        if (node.l0) node.l0 = SecretsRedactor.redact(node.l0);
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    } catch (error) {
      console.error('[HTTP] /graph.json failed:', error);
      res.status(500).json({ error: 'Failed to build graph payload.' });
    }
  });

  app.get('/graph-overview', requireAuth, (req: Request, res: Response) => {
    const tenantId = resolveTenant(req);
    const task = typeof req.query.task === 'string' ? req.query.task.slice(0, 200) : undefined;
    try {
      const service = getService(tenantId);
      const outputDir = path.join(dataRoot, '.hive', 'overviews', tenantId);
      fs.mkdirSync(outputDir, { recursive: true });
      const overviewPath = generateGraphOverview({ tenantId, db: service.db, outputDir, task });
      const markdown = SecretsRedactor.redact(fs.readFileSync(overviewPath, 'utf8'));
      res.setHeader('Cache-Control', 'no-store');
      res.type('text/markdown; charset=utf-8').send(markdown);
    } catch (error) {
      console.error('[HTTP] /graph-overview failed:', error);
      res.status(500).json({ error: 'Failed to generate the graph overview.' });
    }
  });

  app.get('/chat-start', requireAuth, (req: Request, res: Response) => {
    const tenantId = resolveTenant(req);
    const task = typeof req.query.task === 'string' ? req.query.task.slice(0, 200) : undefined;
    try {
      const service = getService(tenantId);
      const outputDir = path.join(dataRoot, '.hive', 'overviews', tenantId);
      fs.mkdirSync(outputDir, { recursive: true });
      const card = generateChatStartCard({ tenantId, db: service.db, outputDir, task });
      res.setHeader('Cache-Control', 'no-store');
      res.type('text/markdown; charset=utf-8').send(SecretsRedactor.redact(card));
    } catch (error) {
      console.error('[HTTP] /chat-start failed:', error);
      res.status(500).json({ error: 'Failed to generate the chat-start card.' });
    }
  });

  app.get('/index-status', requireAuth, (req: Request, res: Response) => {
    const tenantId = resolveTenant(req);
    try {
      const service = getService(tenantId);
      res.setHeader('Cache-Control', 'no-store');
      res.json(JSON.parse(SecretsRedactor.redact(JSON.stringify(service.getStatus()))));
    } catch (error) {
      console.error('[HTTP] /index-status failed:', error);
      res.status(500).json({ error: 'Failed to read indexing status.' });
    }
  });

  app.get('/graph/node', requireAuth, (req: Request, res: Response) => {
    const tenantId = resolveTenant(req);
    const id = typeof req.query.id === 'string' ? req.query.id.slice(0, 512) : '';
    if (!id) {
      res.status(400).json({ error: 'id is required.' });
      return;
    }
    try {
      const service = getService(tenantId);
      const detail = buildNodeDetail(service.db, id);
      if (!detail) {
        res.status(404).json({ error: 'Node not found.' });
        return;
      }
      detail.l0 = SecretsRedactor.redact(detail.l0);
      if (detail.l1) detail.l1 = SecretsRedactor.redact(detail.l1);
      if (detail.l2) detail.l2 = SecretsRedactor.redact(detail.l2);
      res.setHeader('Cache-Control', 'no-store');
      res.json(detail);
    } catch (error) {
      console.error('[HTTP] /graph/node failed:', error);
      res.status(500).json({ error: 'Failed to load node.' });
    }
  });

  // Programmatic access to the same context pack the UI assembles, so external
  // tools can fetch or validate the bundle without touching SQLite themselves.
  app.post('/graph/context-pack', requireAuth, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      included?: unknown;
      excluded?: unknown;
      budget?: unknown;
      task?: unknown;
    };
    const included = Array.isArray(body.included) ? body.included.filter((v): v is string => typeof v === 'string').slice(0, 5000) : [];
    const excluded = Array.isArray(body.excluded) ? body.excluded.filter((v): v is string => typeof v === 'string').slice(0, 5000) : [];
    // Clamp so a crafted payload cannot churn the DB with a 10-billion-token budget.
    const budget = typeof body.budget === 'number' && Number.isFinite(body.budget)
      ? Math.max(64, Math.min(2_000_000, Math.floor(body.budget)))
      : 8000;
    const task = typeof body.task === 'string' ? body.task.slice(0, 400) : undefined;

    try {
      const tenantId = resolveTenant(req);
      const service = getService(tenantId);
      const pack = assembleContextPack(service.db, { included, excluded, budget, task, tenant: tenantId });
      // Excerpts ride into markdown sent to the model; redact before it leaves.
      for (const item of pack.items) item.excerpt = SecretsRedactor.redact(item.excerpt);
      pack.markdown = SecretsRedactor.redact(pack.markdown);
      res.setHeader('Cache-Control', 'no-store');
      res.json(pack);
    } catch (error) {
      console.error('[HTTP] /graph/context-pack failed:', error);
      res.status(500).json({ error: 'Failed to assemble context pack.' });
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = error as { type?: string; status?: number; message?: string };
    // Malformed / oversized bodies: tell the client what happened, nothing more.
    if (e.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON body.' });
      return;
    }
    if (e.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large.' });
      return;
    }
    console.error('[HTTP] Unhandled error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  return app;
}

export function startSseServer(options: HostedServerOptions = {}): ReturnType<express.Express['listen']> {
  const app = createSseApp(options);
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => {
    const auth = (options.apiKey ?? process.env.HIVE_API_KEY) ? 'bearer-token required' : 'open (set HIVE_API_KEY to lock down)';
    console.log(`[Hivemind MCP] Hosted gateway listening on port ${port} | auth: ${auth}`);
    console.log(`[Hivemind MCP] Streamable HTTP: http://localhost:${port}/mcp?tenantId=default`);
    console.log(`[Hivemind MCP] Legacy SSE:      http://localhost:${port}/sse?tenantId=default`);
    console.log(`[Hivemind MCP] Interactive graph: http://localhost:${port}/graph?tenantId=default`);
    console.log('[Hivemind MCP] Index:            POST /index-repo {"repoUrl":"https://github.com/owner/repo","tenantId":"default"}');
  });
  return server;
}

if (require.main === module) {
  startSseServer();
}
