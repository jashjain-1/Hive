import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type Database from 'better-sqlite3';
import {
  AstChunker,
  CrossModalEntityLinker,
  IgnoreEngine,
  MerkleTree,
  UniversalDocChunker,
  exportGraphToJson,
  insertNode,
  rebuildClosure
} from '@hivemind/core';
import { NodeRecord } from '@hivemind/types';
import { ensureSearchIndex, removeSearchDocuments, writeSearchDocument } from './search-index';

const execFileAsync = promisify(execFile);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py'
]);

const DOC_EXTENSIONS = new Set([
  '.pdf', '.pptx', '.docx', '.xlsx', '.csv', '.md', '.markdown', '.txt'
]);

const TEXT_EXTENSIONS = new Set([
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sql', '.graphql', '.gql', '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.go',
  '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.cpp', '.cc', '.c', '.h',
  '.hpp', '.proto', '.tf', '.hcl', '.env.example'
]);

export interface IndexSummary {
  repoRoot: string;
  filesIndexed: number;
  filesSkipped: number;
  nodesInserted: number;
  linksCreated: number;
  durationMs: number;
  errors: string[];
}

export interface IndexerOptions {
  workspaceRoot: string;
  maxFiles?: number;
  maxFileBytes?: number;
  allowLocalIndex?: boolean;
  githubToken?: string;
  allowedHosts?: string[];
}

export class HiveIndexer {
  private astChunker: AstChunker | null = null;
  private docChunker = new UniversalDocChunker();
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly allowedHosts: Set<string>;

  constructor(
    private readonly db: Database.Database,
    private readonly options: IndexerOptions
  ) {
    this.maxFiles = options.maxFiles ?? Number(process.env.HIVE_MAX_FILES ?? 5000);
    this.maxFileBytes = options.maxFileBytes ?? Number(process.env.HIVE_MAX_FILE_BYTES ?? 2_000_000);
    this.allowedHosts = new Set(
      (options.allowedHosts ?? (process.env.HIVE_ALLOWED_HOSTS ?? 'github.com,gitlab.com,bitbucket.org').split(','))
        .map(h => h.trim().toLowerCase())
        .filter(Boolean)
    );
    ensureSearchIndex(this.db);
  }

  async indexLocal(targetPath: string, internal = false): Promise<IndexSummary> {
    if (!internal && this.options.allowLocalIndex === false) {
      throw new Error('Local path indexing is disabled on this hosted server. Use a Git repository URL.');
    }

    const startedAt = Date.now();
    const repoRoot = path.resolve(targetPath);
    if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
      throw new Error(`Repository path does not exist or is not a directory: ${repoRoot}`);
    }

    const files = this.walk(repoRoot);
    let filesIndexed = 0;
    let filesSkipped = 0;
    let nodesInserted = 0;
    const errors: string[] = [];

    for (const absolutePath of files) {
      const relativePath = this.toPosix(path.relative(repoRoot, absolutePath));
      try {
        const inserted = await this.indexFile(repoRoot, absolutePath, relativePath);
        if (inserted === 0) {
          filesSkipped++;
        } else {
          filesIndexed++;
          nodesInserted += inserted;
        }
      } catch (error) {
        filesSkipped++;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${relativePath}: ${message}`);
      }
    }

    const linksBefore = this.countLinks();
    rebuildClosure(this.db, 'code');
    rebuildClosure(this.db, 'knowledge');
    rebuildClosure(this.db, 'memory');
    rebuildClosure(this.db, 'decision');

    const linker = new CrossModalEntityLinker(this.db);
    linker.linkDocumentsToCode();
    linker.linkCodeSymbols();
    const linksCreated = Math.max(0, this.countLinks() - linksBefore);

    try {
      exportGraphToJson(this.db, path.join(repoRoot, '.hive', 'graph.json'));
    } catch (error) {
      errors.push(`graph export: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      repoRoot,
      filesIndexed,
      filesSkipped,
      nodesInserted,
      linksCreated,
      durationMs: Date.now() - startedAt,
      errors
    };
  }

  async indexRepo(repoUrl: string, githubToken?: string): Promise<IndexSummary> {
    let parsed: URL;
    try {
      parsed = new URL(repoUrl);
    } catch {
      throw new Error('Invalid repository URL.');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('Only https:// Git repository URLs are supported.');
    }
    if (parsed.username || parsed.password) {
      throw new Error('Credentials in the repository URL are not allowed. Use X-GitHub-Token instead.');
    }
    if (parsed.port) {
      throw new Error('Repository URLs must use the default https port (443).');
    }
    if (!this.allowedHosts.has(parsed.hostname.toLowerCase())) {
      throw new Error(
        `Repository host is not allowed. Allowed hosts: ${Array.from(this.allowedHosts).join(', ')}`
      );
    }

    const repoHash = crypto.createHash('sha256').update(repoUrl).digest('hex').slice(0, 12);
    const reposDir = path.join(this.options.workspaceRoot, '.hive', 'repos');
    const destination = path.join(reposDir, repoHash);

    fs.mkdirSync(reposDir, { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });

    const args = ['clone', '--depth', '1', '--single-branch'];
    const token = githubToken || this.options.githubToken || process.env.GITHUB_TOKEN;
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (token) {
      // Pass the credential through git's environment config instead of argv so
      // it does not appear in the process list or shell history.
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    }
    args.push('--', repoUrl, destination);

    try {
      // Async so a slow clone does not block every other tenant's tool calls.
      await execFileAsync('git', args, {
        encoding: 'utf8',
        timeout: Number(process.env.HIVE_GIT_TIMEOUT_MS ?? 180_000),
        maxBuffer: 10 * 1024 * 1024,
        env
      });
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      const failure = error as { stderr?: string; message?: string; killed?: boolean };
      const detail = failure.killed
        ? 'timed out'
        : (failure.stderr || failure.message || 'unknown error').trim();
      throw new Error(`Git clone failed: ${detail}`);
    }

    // The clone is created by the server itself, so it is safe to index even
    // when arbitrary local path indexing is disabled for hosted tenants.
    return this.indexLocal(destination, true);
  }

  private walk(repoRoot: string): string[] {
    const results: string[] = [];
    const pending = [repoRoot];

    while (pending.length > 0 && results.length < this.maxFiles) {
      const current = pending.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (results.length >= this.maxFiles) break;

        const absolute = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          if (entry.name === '.hive') continue;
          if (IgnoreEngine.shouldSkipDirectory(entry.name)) continue;
          pending.push(absolute);
          continue;
        }

        if (entry.isFile()) {
          results.push(absolute);
        }
      }
    }

    return results;
  }

  private async indexFile(repoRoot: string, absolutePath: string, relativePath: string): Promise<number> {
    const ext = path.extname(absolutePath).toLowerCase();
    const stat = fs.statSync(absolutePath);

    this.deleteFileNodes(relativePath);

    if (IgnoreEngine.isBinaryAsset(absolutePath)) {
      const node = this.buildBinaryStub(repoRoot, absolutePath, relativePath, stat.size);
      this.insertSingle(node);
      return 1;
    }

    if (stat.size > this.maxFileBytes) {
      const node = this.buildOversizedStub(repoRoot, absolutePath, relativePath, stat.size);
      this.insertSingle(node);
      return 1;
    }

    if (CODE_EXTENSIONS.has(ext)) {
      const chunker = await this.getAstChunker();
      const source = fs.readFileSync(absolutePath, 'utf8');
      const nodes = chunker.parseSource(relativePath, source).map(node => {
        const enriched = { ...node, subsystem: IgnoreEngine.extractSubsystem(absolutePath, repoRoot) };
        this.enrichSummary(enriched);
        return enriched;
      });
      this.insertNodes(nodes);
      return nodes.length;
    }

    if (DOC_EXTENSIONS.has(ext)) {
      const buffer = fs.readFileSync(absolutePath);
      const nodes = (await this.docChunker.parseDocument(relativePath, buffer)).map(node => ({
        ...node,
        subsystem: IgnoreEngine.extractSubsystem(absolutePath, repoRoot)
      }));
      this.insertNodes(nodes);
      return nodes.length;
    }

    if (TEXT_EXTENSIONS.has(ext) || ext === '' || ext === '.example') {
      const text = fs.readFileSync(absolutePath, 'utf8');
      const node = this.buildTextFileNode(repoRoot, absolutePath, relativePath, text);
      this.insertSingle(node);
      return 1;
    }

    // Unknown textual formats are still useful as a lightweight file pointer.
    const node = this.buildOversizedStub(repoRoot, absolutePath, relativePath, stat.size);
    node.l0 = `${path.basename(absolutePath)} (${stat.size} bytes, unparsed)`;
    this.insertSingle(node);
    return 1;
  }

  private insertNodes(nodes: NodeRecord[]): void {
    // Invariant I5: hashes cover authored content plus sorted child hashes.
    const hashed = MerkleTree.computeAllHashes(nodes);
    const tx = this.db.transaction(() => {
      for (const node of hashed) {
        insertNode(this.db, node);
        writeSearchDocument(this.db, node);
      }
    });
    tx();
  }

  private insertSingle(node: NodeRecord): void {
    const hashed = MerkleTree.computeAllHashes([node])[0];
    const tx = this.db.transaction(() => {
      insertNode(this.db, hashed);
      writeSearchDocument(this.db, hashed);
    });
    tx();
  }

  private deleteFileNodes(relativePath: string): void {
    const rows = this.db.prepare('SELECT id FROM nodes WHERE filePath = ?').all(relativePath) as Array<{ id: string }>;
    if (rows.length === 0) return;

    const ids = rows.map(row => row.id);
    const placeholders = ids.map(() => '?').join(',');

    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE nodes SET parent = NULL WHERE parent IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM links WHERE src IN (${placeholders}) OR dst IN (${placeholders})`).run(...ids, ...ids);
      this.db.prepare(`DELETE FROM closure WHERE anc IN (${placeholders}) OR desc IN (${placeholders})`).run(...ids, ...ids);
      removeSearchDocuments(this.db, ids);
      this.db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...ids);
    });
    tx();
  }

  private async getAstChunker(): Promise<AstChunker> {
    if (!this.astChunker) {
      const chunker = new AstChunker();
      await chunker.init();
      this.astChunker = chunker;
    }
    return this.astChunker;
  }

  private buildBinaryStub(repoRoot: string, absolutePath: string, relativePath: string, bytes: number): NodeRecord {
    const now = Date.now();
    const name = path.basename(absolutePath);
    const size = bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

    return {
      id: this.stableId(relativePath, 'binary'),
      tree: 'code',
      parent: null,
      kind: 'tool',
      name,
      subsystem: IgnoreEngine.extractSubsystem(absolutePath, repoRoot),
      filePath: relativePath,
      status: 'live',
      ver: 1,
      hash: crypto.createHash('sha256').update(`${relativePath}:${bytes}`).digest('hex'),
      l0: `Binary asset ${name} (${size}) | metadata stub, not tokenized`,
      l1: `Binary asset: ${name}, ${size}, extension ${path.extname(name) || '(none)'}`,
      tokL0: Math.ceil((name.length + 40) / 4),
      tokL1: Math.ceil((name.length + 30) / 4),
      tokL2: 0,
      stale: false,
      createdAt: now,
      updatedAt: now
    };
  }

  private buildOversizedStub(repoRoot: string, absolutePath: string, relativePath: string, bytes: number): NodeRecord {
    const now = Date.now();
    const name = path.basename(absolutePath);
    return {
      id: this.stableId(relativePath, 'large'),
      tree: 'code',
      parent: null,
      kind: 'file',
      name,
      subsystem: IgnoreEngine.extractSubsystem(absolutePath, repoRoot),
      filePath: relativePath,
      status: 'live',
      ver: 1,
      hash: crypto.createHash('sha256').update(`${relativePath}:${bytes}`).digest('hex'),
      l0: `${name} (${Math.round(bytes / 1024)} KB) | skipped full-content indexing`,
      tokL0: 12,
      tokL1: 0,
      tokL2: 0,
      stale: false,
      createdAt: now,
      updatedAt: now
    };
  }

  private buildTextFileNode(
    repoRoot: string,
    absolutePath: string,
    relativePath: string,
    text: string
  ): NodeRecord {
    const now = Date.now();
    const name = path.basename(absolutePath);
    const lines = text.split('\n');
    const l2 = text.length <= 12_000 ? text : text.slice(0, 12_000);
    const summaryCap = Math.min(600, Math.max(40, Math.floor(text.length * 0.6)));
    const l1 = text.slice(0, summaryCap).replace(/\s+/g, ' ').trim();

    return {
      id: this.stableId(relativePath, 'file'),
      tree: 'code',
      parent: null,
      kind: 'file',
      name,
      subsystem: IgnoreEngine.extractSubsystem(absolutePath, repoRoot),
      filePath: relativePath,
      startLine: 1,
      endLine: lines.length,
      status: 'live',
      ver: 1,
      hash: crypto.createHash('sha256').update(text).digest('hex'),
      l0: `${name} (${lines.length} lines)`,
      l1: l1 || name,
      l2,
      tokL0: Math.ceil(name.length / 4) + 2,
      tokL1: Math.ceil(l1.length / 4),
      tokL2: Math.ceil(l2.length / 4),
      stale: false,
      createdAt: now,
      updatedAt: now
    };
  }

  private enrichSummary(node: NodeRecord): void {
    if (!node.l2) return;
    // Keep L1 strictly smaller than L2 so L0 -> L1 -> L2 upgrades always add
    // coverage for a positive token cost.
    const cap = Math.min(500, Math.max(40, Math.floor(node.l2.length * 0.6)));
    const summary = node.l2.slice(0, cap).trim();
    node.l1 = summary.length >= node.l2.length ? node.l0 : summary;
    node.tokL1 = Math.max(node.tokL0, Math.ceil(node.l1.length / 4));
  }

  private stableId(relativePath: string, suffix: string): string {
    return `c:${crypto.createHash('sha256').update(`${relativePath}\n${suffix}`).digest('hex').slice(0, 24)}`;
  }

  private countLinks(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM links').get() as { count: number };
    return row.count;
  }

  private toPosix(value: string): string {
    return value.split(path.sep).join('/');
  }
}
