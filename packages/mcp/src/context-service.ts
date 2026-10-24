import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import {
  GitImpactAnalyzer,
  MerkleTree,
  SecretsRedactor,
  initializeDatabase,
  insertNode,
  rebuildClosure
} from '@hivemind/core';
import {
  ExplainEngine,
  KnapsackPacker,
  LocalEmbeddingEngine,
  NextHopPredictor,
  OverridesManager,
  RelevanceRanker,
  RoiLedger
} from '@hivemind/pack';
import {
  DeferredSelection,
  HIVE_CONSTANTS,
  LinkRelation,
  NodeProofEntry,
  NodeRecord,
  PackRequest,
  PackResponse,
  PackSelection
} from '@hivemind/types';
import { HiveIndexer, IndexSummary } from './indexer';
import { writeSearchDocument } from './search-index';

export interface HiveServiceOptions {
  repoRoot: string;
  dbPath?: string;
  tenantId?: string;
  allowLocalIndex?: boolean;
  embeddings?: 'auto' | 'off';
}

export interface PackResult {
  pack: PackResponse;
  text: string;
}

export interface SearchHit {
  node: NodeRecord;
  bm25: number;
}

interface NodeRow {
  id: string;
  tree: NodeRecord['tree'];
  parent: string | null;
  kind: NodeRecord['kind'];
  name: string;
  subsystem?: string | null;
  filePath?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  status: NodeRecord['status'];
  ver: number;
  hash: string;
  linkHash?: string | null;
  l0: string;
  l1?: string | null;
  l2?: string | null;
  blobHash?: string | null;
  tokL0: number;
  tokL1: number;
  tokL2: number;
  embedding?: Buffer | null;
  stale: number;
  createdAt: number;
  updatedAt: number;
}

export class HiveContextService {
  readonly db: Database.Database;
  readonly tenantId: string;
  readonly dbPath: string;
  repoRoot: string;

  private indexer: HiveIndexer;
  private readonly embeddings: LocalEmbeddingEngine;
  private readonly ranker: RelevanceRanker;
  private packer: KnapsackPacker;
  private readonly nextHop: NextHopPredictor;
  private explainEngine: ExplainEngine;
  private overrides: OverridesManager;
  private readonly embeddingsEnabled: boolean;
  private readonly allowLocalIndex: boolean;
  private lastIndex: IndexSummary | null = null;

  constructor(options: HiveServiceOptions) {
    this.repoRoot = path.resolve(options.repoRoot);
    this.tenantId = options.tenantId ?? 'default';
    this.dbPath = path.resolve(
      options.dbPath ?? path.join(this.repoRoot, '.hive', 'tenants', `${this.tenantId}.db`)
    );
    this.embeddingsEnabled = options.embeddings !== 'off';
    this.allowLocalIndex = options.allowLocalIndex ?? true;

    fs.mkdirSync(this.repoRoot, { recursive: true });
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.db = initializeDatabase(this.dbPath);
    this.ensureServiceTables();

    this.embeddings = new LocalEmbeddingEngine();
    this.ranker = new RelevanceRanker(this.embeddings, this.embeddingsEnabled);
    this.overrides = new OverridesManager(this.repoRoot);
    this.packer = new KnapsackPacker(this.embeddings, this.overrides, this.ranker);
    this.nextHop = new NextHopPredictor();
    this.explainEngine = new ExplainEngine(this.overrides);

    this.indexer = new HiveIndexer(this.db, {
      workspaceRoot: this.repoRoot,
      allowLocalIndex: this.allowLocalIndex,
      githubToken: process.env.GITHUB_TOKEN
    });
  }

  async index(target: string, githubToken?: string): Promise<IndexSummary> {
    const localTarget = path.isAbsolute(target) ? target : path.resolve(this.repoRoot, target);
    const summary = /^https:\/\//i.test(target)
      ? await this.indexer.indexRepo(target, githubToken)
      : await this.indexer.indexLocal(localTarget);

    this.repoRoot = summary.repoRoot;
    this.overrides = new OverridesManager(this.repoRoot);
    this.packer = new KnapsackPacker(this.embeddings, this.overrides, this.ranker);
    this.explainEngine = new ExplainEngine(this.overrides);
    this.indexer = new HiveIndexer(this.db, {
      workspaceRoot: this.repoRoot,
      allowLocalIndex: this.allowLocalIndex,
      githubToken: process.env.GITHUB_TOKEN
    });
    this.lastIndex = summary;
    return summary;
  }

  getStatus(): Record<string, unknown> {
    const counts = this.db.prepare(`
      SELECT tree, COUNT(*) as count FROM nodes WHERE status != 'superseded' GROUP BY tree
    `).all() as Array<{ tree: string; count: number }>;
    const files = this.db.prepare(`
      SELECT COUNT(DISTINCT filePath) as count FROM nodes WHERE filePath IS NOT NULL
    `).get() as { count: number };
    const links = this.db.prepare('SELECT COUNT(*) as count FROM links').get() as { count: number };
    const packs = this.db.prepare('SELECT COUNT(*) as count FROM pack_receipts').get() as { count: number };
    const roi = this.aggregateRoi();

    return {
      tenantId: this.tenantId,
      repoRoot: this.repoRoot,
      dbPath: this.dbPath,
      embeddings: this.embeddingsEnabled ? 'local-onnx-auto' : 'disabled',
      nodes: counts.reduce((sum, row) => sum + row.count, 0),
      nodesByTree: Object.fromEntries(counts.map(row => [row.tree, row.count])),
      indexedFiles: files.count,
      links: links.count,
      packReceipts: packs.count,
      roi,
      lastIndex: this.lastIndex
    };
  }

  search(query: string, limit = 20): SearchHit[] {
    const bm25Map = this.searchBm25(query, limit * 3);
    if (bm25Map.size === 0) {
      return this.likeSearch(query, limit);
    }

    const ids = Array.from(bm25Map.keys());
    const rows = this.nodesByIds(ids);
    return rows
      .map(node => ({ node, bm25: bm25Map.get(node.id) ?? 0 }))
      .sort((a, b) => b.bm25 - a.bm25)
      .slice(0, limit);
  }

  find(query: string, budget: number = 400): string {
    const hits = this.search(query, 30);
    if (hits.length === 0) {
      return `No matches for "${query}". Run the index tool first, or try a more specific symbol/file name.`;
    }

    const lines = [`FIND "${query}" | ${hits.length} matches | budget ${budget} tokens`];
    let used = 0;
    for (const hit of hits) {
      const row = `${hit.node.id}\t${hit.node.name}\t${hit.node.kind}\t${hit.node.filePath ?? '(memory)'}\t${hit.node.l0}`;
      const cost = this.estimateTokens(row);
      if (used + cost > budget && lines.length > 1) break;
      lines.push(row);
      used += cost;
    }

    lines.push('', this.buildNextHopFooter(hits[0].node.id));
    return this.redact(lines.join('\n'));
  }

  async pack(task: string, budget: number = HIVE_CONSTANTS.DEFAULT_BUDGET, explain = true): Promise<PackResult> {
    const request: PackRequest = { task, budget, slackPct: HIVE_CONSTANTS.SLACK_PCT, explain };
    const candidates = this.selectPackCandidates(task);
    const graphLinks = this.loadGraphLinks();
    const bm25Results = this.lexicalScores(task, candidates);
    const modifiedIds = this.getModifiedNodeIds();

    let pack: PackResponse;
    let fallbackUsed = false;
    const fallbackScores = new Map(candidates.map(node => [node.id, this.lexicalPseudoVector(node, task)]));

    try {
      pack = await this.packer.compilePack(
        request,
        candidates,
        graphLinks,
        bm25Results,
        modifiedIds,
        this.embeddingsEnabled ? undefined : fallbackScores
      );
    } catch (error) {
      if (!this.embeddingsEnabled) throw error;
      fallbackUsed = true;
      pack = await this.packer.compilePack(
        request,
        candidates,
        graphLinks,
        bm25Results,
        modifiedIds,
        fallbackScores
      );
    }

    pack.roi = RoiLedger.calculateRoi(pack.packId, pack.items, this.fullFileTokenCounts());
    this.storePackReceipt(pack);
    return { pack, text: this.formatPack(pack, explain, fallbackUsed) };
  }

  peek(nodeRef: string, depth = 1, level: 0 | 1 = 0): string {
    const node = this.resolveNode(nodeRef);
    if (!node) {
      return `Node not found: ${nodeRef}. Use find to locate a node id.`;
    }

    const lines = [
      `# peek ${node.id} (${node.kind} ${node.name})`,
      `${node.id}\t${level}\t${level === 0 ? node.tokL0 : node.tokL1}\t${node.status}\t${level === 0 ? node.l0 : node.l1 ?? node.l0}`
    ];

    if (depth > 0) {
      let frontier = [node.id];
      for (let currentDepth = 1; currentDepth <= Math.min(depth, 3); currentDepth++) {
        const children = this.childrenOfMany(frontier);
        if (children.length === 0) break;
        lines.push(`## depth ${currentDepth}`);
        for (const child of children.slice(0, 30)) {
          lines.push(
            `${child.id}\t${level}\t${level === 0 ? child.tokL0 : child.tokL1}\t${child.status}\t${level === 0 ? child.l0 : child.l1 ?? child.l0}`
          );
        }
        frontier = children.map(child => child.id);
      }
    }

    lines.push('', this.buildNextHopFooter(node.id));
    return this.redact(this.cap(lines.join('\n'), HIVE_CONSTANTS.RESP_CAP));
  }

  expand(nodeRef: string, level: 0 | 1 | 2 | 3): string {
    const node = this.resolveNode(nodeRef);
    if (!node) {
      return `Node not found: ${nodeRef}. Use find to locate a node id.`;
    }

    const content =
      level >= 2 ? (node.l2 ?? node.l1 ?? node.l0) :
      level === 1 ? (node.l1 ?? node.l0) :
      node.l0;

    const header = `# expand ${node.id} (${node.name}) -> L${level} | ${node.filePath ?? node.tree}${node.startLine ? `:${node.startLine}-${node.endLine ?? node.startLine}` : ''}`;
    return this.redact(`${header}\n\n${content}\n\n${this.buildNextHopFooter(node.id)}`);
  }

  explain(nodeRef: string, task?: string): string {
    const node = this.resolveNode(nodeRef);
    if (!node) {
      return `Node not found: ${nodeRef}.`;
    }

    const row = this.db.prepare(
      'SELECT payload FROM pack_receipts ORDER BY created_at DESC LIMIT 1'
    ).get() as { payload: string } | undefined;

    if (!row) {
      return [
        `${node.id} (${node.name}) is indexed as ${node.kind} in ${node.filePath ?? node.tree}.`,
        'No pack receipt exists yet. Run pack with a task to receive a measured inclusion/deferral decision.'
      ].join('\n');
    }

    const pack = JSON.parse(row.payload) as PackResponse;
    const included = pack.items.find(item => item.nodeId === node.id);
    const deferred = pack.deferred.find(item => item.nodeId === node.id);
    const proof = pack.proofMatrix?.proofEntries.find(entry => entry.nodeId === node.id);

    if (included) {
      return this.redact([
        `${node.id} (${node.name}) -> INCLUDED in ${pack.packId} at L${included.level} (${included.tokens} tokens)`,
        `Task: ${pack.task}`,
        `Reason: ${included.reason}`,
        this.formatProofEntry(proof)
      ].filter(Boolean).join('\n'));
    }

    if (deferred) {
      return this.redact([
        `${node.id} (${node.name}) -> DEFERRED from ${pack.packId}`,
        `Task: ${pack.task}`,
        `Reason: ${deferred.reason}`,
        this.formatProofEntry(proof)
      ].filter(Boolean).join('\n'));
    }

    return this.redact([
      `${node.id} (${node.name}) was not part of the latest pack (${pack.packId}, task: ${pack.task}).`,
      proof ? this.formatProofEntry(proof) : 'It did not enter the candidate set for that task.',
      task ? `Requested task context: ${task}` : ''
    ].filter(Boolean).join('\n'));
  }

  next(nodeRef: string, task?: string): string {
    const node = this.resolveNode(nodeRef);
    if (!node) {
      return `Node not found: ${nodeRef}.`;
    }

    const outgoing = this.outgoingLinks(node.id);
    const adjacency = new Map<string, Array<{ dstNode: NodeRecord; rel: LinkRelation; w: number }>>();
    if (outgoing.length > 0) {
      adjacency.set(node.id, outgoing);
    }

    const result = this.nextHop.predictNextHops(node, outgoing, task);
    if (outgoing.length > 0) {
      result.trails = this.nextHop.predictMultiHopTrails(node, this.loadTrailAdjacency(), 3, task);
    }

    const header = `[NEXT_HOPS for ${node.id} (${node.name})${task ? ` | task: ${task}` : ''}]`;
    return this.redact(`${header}\n${this.nextHop.formatFooter(result)}`);
  }

  impact(target?: string): string {
    try {
      const analyzer = new GitImpactAnalyzer(this.db, this.repoRoot);
      const result = analyzer.computeImpact(target ? [target] : undefined);
      if (result.changedFiles.length === 0) {
        const summary = this.getStatus();
        return `No changed files detected in ${this.repoRoot}.\nIndexed files: ${summary.indexedFiles}, nodes: ${summary.nodes}. Pass a target file path to compute impact explicitly.`;
      }

      const lines = [
        `[IMPACT] ${result.changedFiles.length} changed file(s) | ${result.totalAffectedSymbols} affected symbols`,
        'Changed files:',
        ...result.changedFiles.map(file => `- ${file}`),
        '',
        'Modified nodes:',
        ...result.modifiedNodes.slice(0, 20).map(node => `- ${node.id} ${node.kind} ${node.name} (${node.filePath})`),
        '',
        'Blast radius:',
        ...result.blastRadius.slice(0, 30).map(hop => `- ${hop.symbolId} ${hop.symbolName} (${hop.relation}, depth ${hop.depth}) in ${hop.filePath}`)
      ];
      return this.redact(lines.join('\n'));
    } catch (error) {
      return `Impact analysis failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  pin(target: string, action: 'include' | 'exclude' | 'clear'): string {
    const response = this.overrides.updatePin(target, action);
    return this.redact([
      response.message,
      `force_include: ${JSON.stringify(response.activeIncludes)}`,
      `force_exclude: ${JSON.stringify(response.activeExcludes)}`
    ].join('\n'));
  }

  write(parentRef: string, kind: 'note' | 'fact' | 'decision' | 'tombstone', name: string, content: string): string {
    const parent = parentRef && parentRef !== 'root' ? this.resolveNode(parentRef) : null;
    if (parentRef && parentRef !== 'root' && !parent) {
      return `Parent node not found: ${parentRef}.`;
    }

    const now = Date.now();
    const prefix = kind === 'decision' ? 'm:d' : 'm:n';
    const id = `${prefix}:${crypto.createHash('sha256').update(`${name}\n${now}`).digest('hex').slice(0, 12)}`;
    const firstLine = content.split('\n').find(line => line.trim().length > 0)?.trim() ?? name;
    const tree = kind === 'decision' ? 'decision' : 'memory';

    const node: NodeRecord = {
      id,
      tree,
      parent: parent?.id ?? null,
      kind,
      name,
      subsystem: parent?.subsystem,
      filePath: parent?.filePath,
      status: 'live',
      ver: 1,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      l0: firstLine.slice(0, 120),
      l1: content.slice(0, 500),
      l2: content,
      tokL0: this.estimateTokens(firstLine),
      tokL1: this.estimateTokens(content.slice(0, 500)),
      tokL2: this.estimateTokens(content),
      stale: false,
      createdAt: now,
      updatedAt: now
    };

    const [hashed] = MerkleTree.computeAllHashes([node]);
    insertNode(this.db, hashed);
    writeSearchDocument(this.db, hashed);
    rebuildClosure(this.db, tree);
    return `Created ${kind} node ${id} "${name}"${parent ? ` under ${parent.id}` : ' at tree root'}.`;
  }

  coordinateTask(verb: 'claim' | 'report' | 'handoff', id: string, payload?: string): string {
    const status = verb === 'claim' ? 'claimed' : verb === 'report' ? 'reported' : 'handed_off';
    this.db.prepare(`
      INSERT INTO tasks (id, status, payload, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at
    `).run(id, status, payload ?? '', Date.now());
    return `Task ${id} -> ${status}${payload ? ` | ${payload.slice(0, 200)}` : ''}`;
  }

  signal(channel: string, message: string): string {
    const trimmed = message.slice(0, HIVE_CONSTANTS.MSG_CAP * 4);
    this.db.prepare('INSERT INTO signals (channel, message, created_at) VALUES (?, ?, ?)')
      .run(channel, trimmed, Date.now());
    const recent = this.db.prepare(
      'SELECT message, created_at FROM signals WHERE channel = ? ORDER BY id DESC LIMIT 5'
    ).all(channel) as Array<{ message: string; created_at: number }>;
    return this.redact([
      `Signal posted to #${channel}.`,
      ...recent.map((row, idx) => `${idx + 1}. ${row.message}`)
    ].join('\n'));
  }

  branch(verb: 'fork' | 'diff' | 'merge' | 'discard', id?: string): string {
    if (verb === 'fork') {
      const branchId = id ?? `branch:${crypto.randomBytes(4).toString('hex')}`;
      this.db.prepare(
        'INSERT OR REPLACE INTO branches (id, base, created_at, updated_at) VALUES (?, ?, ?, ?)'
      ).run(branchId, 'main', Date.now(), Date.now());
      return `Forked memory overlay ${branchId} from main.`;
    }

    if (!id) {
      return `Branch id is required for ${verb}.`;
    }

    const existing = this.db.prepare('SELECT id, base, created_at FROM branches WHERE id = ?').get(id);
    if (!existing) {
      return `Branch not found: ${id}.`;
    }

    if (verb === 'diff') {
      const status = this.getStatus();
      return `Branch ${id} (base: main) | current live nodes: ${status.nodes} | links: ${status.links}`;
    }

    this.db.prepare('DELETE FROM branches WHERE id = ?').run(id);
    return `${verb === 'merge' ? 'Merged' : 'Discarded'} branch ${id}.`;
  }

  close(): void {
    this.db.close();
  }

  private ensureServiceTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pack_receipts (
        pack_id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        budget INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        payload TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        base TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private selectPackCandidates(task: string): NodeRecord[] {
    // Use the same hybrid fallback as find(): FTS5 handles exact identifiers,
    // while LIKE catches camelCase fragments such as "jwt" inside "verifyJwt".
    const hits = this.search(task, 120);
    const ids = new Set(hits.map(hit => hit.node.id));
    const candidates = new Map<string, NodeRecord>();

    const addNode = (node: NodeRecord | undefined): void => {
      if (node && candidates.size < 400) candidates.set(node.id, node);
    };

    if (ids.size > 0) {
      for (const node of this.nodesByIds(Array.from(ids))) addNode(node);

      const filePaths = new Set(
        Array.from(candidates.values())
          .map(node => node.filePath)
          .filter((filePath): filePath is string => Boolean(filePath))
      );
      if (filePaths.size > 0) {
        const placeholders = Array.from(filePaths).map(() => '?').join(',');
        const rows = this.db.prepare(
          `SELECT * FROM nodes WHERE filePath IN (${placeholders}) AND status != 'superseded' LIMIT 200`
        ).all(...Array.from(filePaths)) as NodeRow[];
        for (const row of rows) addNode(this.rowToNode(row));
      }

      for (const neighborId of this.neighborIds(Array.from(candidates.keys()))) {
        addNode(this.getNode(neighborId));
      }
    }

    if (candidates.size < 20) {
      const rows = this.db.prepare(
        `SELECT * FROM nodes WHERE status != 'superseded' ORDER BY updatedAt DESC LIMIT 200`
      ).all() as NodeRow[];
      for (const row of rows) addNode(this.rowToNode(row));
    }

    // Force-included nodes must enter the pack even when lexical search misses them.
    const allForOverrides = this.db.prepare(
      `SELECT * FROM nodes WHERE status != 'superseded' LIMIT 5000`
    ).all() as NodeRow[];
    const forced = this.overrides.filter(allForOverrides.map(row => this.rowToNode(row)));
    for (const node of forced.forcedIncludes) addNode(node);

    return Array.from(candidates.values());
  }

  private formatPack(pack: PackResponse, explain: boolean, fallbackUsed: boolean): string {
    const lines = [
      `HIVE_PACK ${pack.packId}`,
      `Task: ${pack.task}`,
      `Budget: ${pack.budget} tok | Used: ${pack.usedTokens} tok | Slack remaining: ${pack.slackRemaining} tok`,
      `Items: ${pack.items.length} | Deferred: ${pack.deferred.length}${fallbackUsed ? ' | embeddings unavailable, lexical fallback' : ''}`
    ];

    if (pack.roi) {
      lines.push(RoiLedger.formatBadge(pack.roi));
    }

    if (pack.intent) {
      lines.push(`Intent: ${pack.intent.intent} (${pack.intent.confidence.toFixed(2)}) | weights bm25=${pack.intent.weights.bm25.toFixed(2)} vec=${pack.intent.weights.vector.toFixed(2)} graph=${pack.intent.weights.graph.toFixed(2)}`);
    }

    for (const item of pack.items) {
      lines.push('');
      lines.push(`## ${item.nodeId} ${item.name} [L${item.level}, ${item.tokens} tok]`);
      lines.push(`reason: ${item.reason}`);
      if (item.content) {
        const maxChars = Math.max(400, item.tokens * 4);
        const content = item.content.length > maxChars
          ? `${item.content.slice(0, maxChars)}\n... [truncated to L${item.level} token budget]`
          : item.content;
        lines.push('```');
        lines.push(content);
        lines.push('```');
      }
    }

    if (pack.deferred.length > 0) {
      lines.push('', `Deferred (${pack.deferred.length}):`);
      for (const item of pack.deferred.slice(0, 8)) {
        lines.push(`- ${item.nodeId} ${item.name}: ${item.reason}`);
      }
    }

    if (explain && pack.proofMatrix) {
      lines.push('', 'Cluster allocations:');
      for (const cluster of pack.proofMatrix.clusterAllocations.slice(0, 10)) {
        lines.push(`- ${cluster.clusterKey}: ${cluster.usedTokens}/${cluster.allocatedTokens} tok, ${cluster.selectedCount}/${cluster.candidateCount} nodes`);
      }
      const included = pack.proofMatrix.proofEntries.filter(entry => entry.status === 'INCLUDED').slice(0, 10);
      if (included.length > 0) {
        lines.push('Proof entries:');
        for (const entry of included) {
          lines.push(`- ${entry.nodeId}: score=${entry.compositeScore.toFixed(3)} bm25=${entry.bm25Norm.toFixed(3)} vec=${entry.vecScore.toFixed(3)} graph=${entry.graphScore.toFixed(2)}`);
        }
      }
    }

    if (pack.items[0]) {
      lines.push('', this.buildNextHopFooter(pack.items[0].nodeId));
    }

    return this.redact(lines.join('\n'));
  }

  private formatProofEntry(entry: NodeProofEntry | undefined): string {
    if (!entry) return '';
    return `Scores: composite=${entry.compositeScore.toFixed(3)}, bm25=${entry.bm25Norm.toFixed(3)}, vec=${entry.vecScore.toFixed(3)}, graph=${entry.graphScore.toFixed(2)} | status=${entry.status}, level=L${entry.chosenLevel}, factor=${entry.decisionFactor}`;
  }

  private buildNextHopFooter(nodeId: string): string {
    const node = this.getNode(nodeId);
    if (!node) return 'NEXT_HOPS: none';
    const outgoing = this.outgoingLinks(node.id);
    if (outgoing.length === 0) {
      return 'NEXT_HOPS: none (no graph links). Use find or pack to discover related nodes.';
    }
    const result = this.nextHop.predictNextHops(node, outgoing);
    return this.nextHop.formatFooter(result);
  }

  private outgoingLinks(nodeId: string): Array<{ dstNode: NodeRecord; rel: LinkRelation; w: number }> {
    const rows = this.db.prepare(`
      SELECT l.rel, l.w, n.* FROM links l JOIN nodes n ON n.id = l.dst
      WHERE l.src = ? AND n.status != 'superseded'
      ORDER BY l.w DESC LIMIT 20
    `).all(nodeId) as Array<NodeRow & { rel: LinkRelation; w: number }>;

    return rows.map(row => ({
      dstNode: this.rowToNode(row),
      rel: row.rel,
      w: row.w
    }));
  }

  private loadTrailAdjacency(): Map<string, Array<{ dstNode: NodeRecord; rel: LinkRelation; w: number }>> {
    const rows = this.db.prepare(`
      SELECT l.src, l.rel, l.w, n.* FROM links l JOIN nodes n ON n.id = l.dst
      WHERE n.status != 'superseded' LIMIT 500
    `).all() as Array<NodeRow & { src: string; rel: LinkRelation; w: number }>;

    const adjacency = new Map<string, Array<{ dstNode: NodeRecord; rel: LinkRelation; w: number }>>();
    for (const row of rows) {
      const list = adjacency.get(row.src) ?? [];
      list.push({ dstNode: this.rowToNode(row), rel: row.rel, w: row.w });
      adjacency.set(row.src, list);
    }
    return adjacency;
  }

  private loadGraphLinks(): Map<string, Array<{ dst: string; rel: LinkRelation }>> {
    const rows = this.db.prepare('SELECT src, dst, rel FROM links').all() as Array<{ src: string; dst: string; rel: LinkRelation }>;
    const links = new Map<string, Array<{ dst: string; rel: LinkRelation }>>();
    for (const row of rows) {
      const list = links.get(row.src) ?? [];
      list.push({ dst: row.dst, rel: row.rel });
      links.set(row.src, list);
    }
    return links;
  }

  private neighborIds(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT DISTINCT dst as id FROM links WHERE src IN (${placeholders})
      UNION
      SELECT DISTINCT src as id FROM links WHERE dst IN (${placeholders})
      LIMIT 120
    `).all(...ids, ...ids) as Array<{ id: string }>;
    return rows.map(row => row.id);
  }

  private searchBm25(query: string, limit: number): Map<string, number> {
    const tokens = (query
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [])
      .filter(token => token.length > 1)
      .slice(0, 12);
    if (tokens.length === 0) return new Map();

    const ftsQuery = tokens.map(token => `"${token}"`).join(' OR ');
    try {
      const rows = this.db.prepare(`
        SELECT id, bm25(hive_fts) as bm25 FROM hive_fts
        WHERE hive_fts MATCH ? ORDER BY bm25 ASC LIMIT ?
      `).all(ftsQuery, limit) as Array<{ id: string; bm25: number }>;
      return new Map(rows.map(row => [row.id, Math.abs(row.bm25)]));
    } catch {
      return new Map();
    }
  }

  private likeSearch(query: string, limit: number): SearchHit[] {
    const tokens = (query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
      .filter(token => token.length > 1)
      .slice(0, 8);
    if (tokens.length === 0) return [];

    const clauses = tokens.map(() =>
      '(LOWER(name) LIKE ? OR LOWER(l0) LIKE ? OR LOWER(l1) LIKE ? OR LOWER(l2) LIKE ?)'
    ).join(' OR ');
    const params = tokens.flatMap(token => {
      const term = `%${token}%`;
      return [term, term, term, term];
    });

    const rows = this.db.prepare(`
      SELECT * FROM nodes
      WHERE status != 'superseded' AND (${clauses})
      LIMIT ?
    `).all(...params, limit) as NodeRow[];
    return rows.map(row => ({ node: this.rowToNode(row), bm25: 1 }));
  }

  private lexicalScores(task: string, candidates: NodeRecord[]): Map<string, number> {
    const scores = this.searchBm25(task, 200);
    if (scores.size > 0) return scores;

    const hits = this.search(task, Math.max(candidates.length, 120));
    return new Map(hits.map(hit => [hit.node.id, hit.bm25]));
  }

  private nodesByIds(ids: string[]): NodeRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).all(...ids) as NodeRow[];
    const byId = new Map(rows.map(row => [row.id, this.rowToNode(row)]));
    return ids.map(id => byId.get(id)).filter((node): node is NodeRecord => Boolean(node));
  }

  private childrenOfMany(ids: string[]): NodeRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT * FROM nodes WHERE parent IN (${placeholders}) AND status != 'superseded' ORDER BY startLine ASC LIMIT 100
    `).all(...ids) as NodeRow[];
    return rows.map(row => this.rowToNode(row));
  }

  private getNode(id: string): NodeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    return row ? this.rowToNode(row) : undefined;
  }

  private resolveNode(ref: string): NodeRecord | undefined {
    const trimmed = ref.trim();
    const direct = this.getNode(trimmed);
    if (direct) return direct;

    const byName = this.db.prepare(
      'SELECT * FROM nodes WHERE name = ? AND status != \'superseded\' ORDER BY updatedAt DESC LIMIT 1'
    ).get(trimmed) as NodeRow | undefined;
    if (byName) return this.rowToNode(byName);

    const byLike = this.db.prepare(
      'SELECT * FROM nodes WHERE (name LIKE ? OR filePath LIKE ?) AND status != \'superseded\' ORDER BY updatedAt DESC LIMIT 1'
    ).get(`%${trimmed}%`, `%${trimmed}%`) as NodeRow | undefined;
    return byLike ? this.rowToNode(byLike) : undefined;
  }

  private fullFileTokenCounts(): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT filePath, SUM(tokL2) as tokens FROM nodes
      WHERE filePath IS NOT NULL AND status != 'superseded'
      GROUP BY filePath
    `).all() as Array<{ filePath: string; tokens: number | null }>;

    return new Map(rows.map(row => [row.filePath, Math.max(0, row.tokens ?? 0)]));
  }

  private aggregateRoi(): { packsMeasured: number; tokensSaved: number; avgSavingsPct: number } {
    const rows = this.db.prepare(
      'SELECT payload FROM pack_receipts ORDER BY created_at DESC LIMIT 200'
    ).all() as Array<{ payload: string }>;

    let tokensSaved = 0;
    let savingsSum = 0;
    let measured = 0;
    for (const row of rows) {
      try {
        const roi = (JSON.parse(row.payload) as PackResponse).roi;
        if (!roi) continue;
        measured++;
        tokensSaved += roi.tokensSaved;
        savingsSum += roi.savingsPercentage;
      } catch {
        // Ignore receipts written by an older schema.
      }
    }

    return {
      packsMeasured: measured,
      tokensSaved,
      avgSavingsPct: measured > 0 ? Number((savingsSum / measured).toFixed(1)) : 0
    };
  }

  private storePackReceipt(pack: PackResponse): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO pack_receipts (pack_id, task, budget, created_at, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(pack.packId, pack.task, pack.budget, pack.receipt.timestamp, JSON.stringify(pack));
  }

  private getModifiedNodeIds(): Set<string> {
    try {
      const analyzer = new GitImpactAnalyzer(this.db, this.repoRoot);
      const impacted = analyzer.computeImpact();
      return new Set(impacted.modifiedNodes.map(node => node.id));
    } catch {
      return new Set();
    }
  }

  private lexicalPseudoVector(node: NodeRecord, task: string): number {
    const terms = new Set((task.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(term => term.length > 2));
    const text = `${node.name} ${node.l0} ${node.l1 ?? ''}`.toLowerCase();
    if (terms.size === 0) return 0.25;
    let overlap = 0;
    for (const term of terms) {
      if (text.includes(term)) overlap++;
    }
    return Math.min(0.95, 0.2 + (overlap / terms.size) * 0.75);
  }

  private rowToNode(row: NodeRow): NodeRecord {
    let embedding: Float32Array | undefined;
    if (row.embedding) {
      const copy = row.embedding.buffer.slice(
        row.embedding.byteOffset,
        row.embedding.byteOffset + row.embedding.byteLength
      );
      embedding = new Float32Array(copy);
    }

    return {
      id: row.id,
      tree: row.tree,
      parent: row.parent,
      kind: row.kind,
      name: row.name,
      subsystem: row.subsystem ?? undefined,
      filePath: row.filePath ?? undefined,
      startLine: row.startLine ?? undefined,
      endLine: row.endLine ?? undefined,
      status: row.status,
      ver: row.ver,
      hash: row.hash,
      linkHash: row.linkHash ?? undefined,
      l0: row.l0,
      l1: row.l1 ?? undefined,
      l2: row.l2 ?? undefined,
      blobHash: row.blobHash ?? undefined,
      tokL0: row.tokL0,
      tokL1: row.tokL1,
      tokL2: row.tokL2,
      embedding,
      stale: Boolean(row.stale),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private cap(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n... [truncated at ${maxTokens} token response cap]`;
  }

  private redact(text: string): string {
    return SecretsRedactor.redact(text);
  }
}
