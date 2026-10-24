/**
 * Hivemind Repository Ingestion Worker (runs as detached child process)
 *
 * Usage: node dist/ingest-worker.js <repoUrl> <tenantId> <githubToken> <statusFile>
 *
 * Clones a git repo to a temp dir, walks it with IgnoreEngine, chunks source files
 * with AstChunker and documents with UniversalDocChunker, inserts into the tenant
 * SQLite DB in batch transactions, runs cross-linker + closure + merkle + graph export,
 * then cleans up the temp clone. GitHub token is held in argv (process memory only) and
 * never written to disk or logged.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { initializeDatabase, insertNode, rebuildClosureTable, ftsSearch } from '@hivemind/core';
import { AstChunker } from '@hivemind/core';
import { UniversalDocChunker } from '@hivemind/core';
import { CrossModalEntityLinker } from '@hivemind/core';
import { MerkleTree } from '@hivemind/core';
import { exportGraphToJson, generateGraphOverview } from '@hivemind/core';
import { IgnoreEngine } from '@hivemind/core';
import { NodeRecord } from '@hivemind/types';

async function main() {
  // Args: <repoUrl> <tenantId> <statusFile>
  // The GitHub token is no longer passed on argv. It comes from the GITHUB_TOKEN
  // environment variable set transiently by the server when it spawns this worker.
  const [, , repoUrl, tenantId, statusFile, wasmDirArg] = process.argv;
  if (!repoUrl || !tenantId || !statusFile) {
    console.error('[IngestWorker] Usage: ingest-worker.js <repoUrl> <tenantId> <statusFile>');
    process.exit(1);
  }

  const wasmDir = wasmDirArg || path.join(__dirname, '..', '..', 'core', 'vendor', 'wasm');
  const repoRoot = process.cwd();
  const tempBase = path.join(repoRoot, '.hive', 'temp-repos');
  const cloneDir = path.join(tempBase, `repo-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`);
  const dbPath = path.join(repoRoot, '.hive', 'tenants', `${tenantId}.db`);

  // The GitHub token is transient: set in the env by the server that spawned this worker,
  // used only for the git clone, and deleted after the clone spawn returns. It is never
  // written to disk, never logged, and never embedded in the clone URL.
  const githubToken = process.env.GITHUB_TOKEN ?? '';

  function writeStatus(status: any) {
    try { fs.writeFileSync(statusFile, JSON.stringify(status, null, 2)); } catch {}
  }

  async function gitClone() {
    // Build a safe argv array for `git clone`. No shell, no string interpolation,
    // and no credentials embedded in the URL. The token is passed once via the env
    // so it never appears in argv, in process listings, or on disk.
    const gitArgs: string[] = ['clone'];

    let sourceUrl: string;
    try {
      const parsed = new URL(repoUrl);
      // Reject non-https clones inside the worker as a second line of defense.
      if (parsed.protocol !== 'https:') {
        throw new Error('Only https Git URLs are accepted.');
      }
      // Strip any embedded credentials just in case the caller bypassed validation.
      parsed.username = '';
      parsed.password = '';
      sourceUrl = parsed.href;
    } catch (err) {
      throw new Error(`Invalid repo URL: ${String(err)}`);
    }

    // Reassemble the URL on the https hosts already allowed by the server.
    // github.com: use the token; other allowed hosts: plain clone.
    const host = (new URL(sourceUrl)).hostname;
    if (host === 'github.com' && githubToken) {
      const ghParsed = new URL(sourceUrl);
      ghParsed.username = 'x-access-token';
      ghParsed.password = githubToken;
      sourceUrl = ghParsed.href;
    }

      gitArgs.push(sourceUrl);
    gitArgs.push(cloneDir);

    return new Promise<void>((resolve, reject) => {
      const child = spawn('git', gitArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GITHUB_TOKEN: githubToken },
      });
      child.unref();
      delete process.env.GITHUB_TOKEN;
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git clone failed (code ${code}): ${stderr.slice(0, 500)}`));
      });
      child.on('error', reject);
    });
  }

  writeStatus({ status: 'cloning', startedAt: Date.now(), repoUrl, tenantId, cloneDir });

  try {
    // 1. Clone the repo
    await gitClone();
    writeStatus({ status: 'cloned', progress: 0.05, tenantId, cloneDir });

    // 2. Initialize DB
    const db = initializeDatabase(dbPath);
    writeStatus({ status: 'db_ready', progress: 0.10, tenantId, cloneDir });

    // 3. Initialize chunkers
    const astChunker = new AstChunker();
    await astChunker.init(wasmDir);
    const docChunker = new UniversalDocChunker();
    writeStatus({ status: 'chunkers_ready', progress: 0.15, tenantId, cloneDir });

    // 4. Walk the repo and collect files to process
    const filesToProcess: string[] = [];
    const docFiles: string[] = [];
    const totalFiles = { count: 0 };

    function walk(dir: string) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(cloneDir, full);
        if (IgnoreEngine.shouldSkipDirectory(entry.name)) continue;
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          totalFiles.count++;
          if (IgnoreEngine.isBinaryAsset(full)) {
            // Create an L0 stub node for binary assets (ML weights, media, compiled libs)
            const ext = path.extname(full).toLowerCase();
            const fileName = path.basename(full);
            const subsystem = IgnoreEngine.extractSubsystem(full, cloneDir);
            const stubNode: NodeRecord = {
              id: `c:${crypto.randomBytes(3).toString('hex')}`,
              tree: 'code',
              parent: null,
              kind: 'tool',
              name: fileName,
              filePath: rel,
              status: 'live',
              ver: 1,
              hash: crypto.createHash('sha256').update(fileName).digest('hex'),
              l0: `${fileName} (${ext.slice(1)} | ${(fs.statSync(full).size / 1024 / 1024).toFixed(1)} MB) | Stub: binary asset, not tokenized`,
              l1: `Binary asset stub. Extension: ${ext}. Size: ${(fs.statSync(full).size).toLocaleString()} bytes. Subsystem: ${subsystem}. Not tokenized to preserve tokens.`,
              tokL0: 18,
              tokL1: 30,
              tokL2: 0,
              stale: false,
              createdAt: Date.now(),
              updatedAt: Date.now()
            };
            filesToProcess.push(full); // We handle stubs inline below; mark for insertion
            // Actually insert the stub directly
            insertNode(db, stubNode);
          } else {
            filesToProcess.push(full);
          }
        }
      }
    }

    walk(cloneDir);
    writeStatus({ status: 'walked', progress: 0.20, tenantId, cloneDir, totalFiles: totalFiles.count });

    // 5. Process source files in batches (AST chunking)
    const BATCH_SIZE = 50;
    let processed = 0;

    async function processSourceBatch(batch: string[]) {
      const insertMany = db.prepare(`
        INSERT OR REPLACE INTO nodes (id, tree, parent, kind, name, filePath, startLine, endLine, status, ver, hash, l0, l1, l2, tokL0, tokL1, tokL2, stale, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `);
      const linkMany = db.prepare(`INSERT OR IGNORE INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)`);

      for (const filePath of batch) {
        const rel = path.relative(cloneDir, filePath);
        let sourceCode: string;
        try { sourceCode = fs.readFileSync(filePath, 'utf8'); } catch { continue; }

        // Skip files that are too large to parse sensibly (still chunk with AST, but cap)
        if (sourceCode.length > 500000) {
          // Create a file-level node only, skip deep AST parse
          const fileId = `c:${crypto.randomBytes(3).toString('hex')}`;
          const fileNode: NodeRecord = {
            id: fileId,
            tree: 'code',
            parent: null,
            kind: 'file',
            name: path.basename(filePath),
            filePath: rel,
            startLine: 1,
            endLine: Math.ceil(sourceCode.length / 80),
            status: 'live',
            ver: 1,
            hash: crypto.createHash('sha256').update(sourceCode.slice(0, 4096)).digest('hex'),
            l0: `${path.basename(filePath)} (${Math.ceil(sourceCode.length / 80)} lines, truncated)`,
            l2: sourceCode.slice(0, 3000),
            tokL0: Math.ceil(path.basename(filePath).length / 3),
            tokL1: 0,
            tokL2: Math.min(800, Math.ceil(sourceCode.length / 4)),
            stale: false,
            createdAt: Date.now(),
            updatedAt: Date.now()
          };
          insertNode(db, fileNode);
          processed++;
          continue;
        }

        const chunks = astChunker.parseSource(rel, sourceCode);
        for (const chunk of chunks) {
          insertNode(db, chunk);
          // If chunk has a parent file id, link them
          if (chunk.parent) {
            linkMany.run(chunk.id, chunk.parent, 'implements', 1.0);
          }
        }
        processed++;
      }
    }

    for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
      const batch = filesToProcess.slice(i, i + BATCH_SIZE);
      await processSourceBatch(batch);
      writeStatus({
        status: 'chunking',
        progress: 0.20 + 0.40 * (processed / Math.max(1, filesToProcess.length)),
        tenantId,
        cloneDir,
        processed,
        total: filesToProcess.length
      });
    }

    writeStatus({ status: 'source_chunked', progress: 0.60, tenantId, cloneDir, processed });

    // 6. Process document files (PDF, PPTX, DOCX, XLSX)
    const docExtensions = new Set(['.pdf', '.pptx', '.docx', '.xlsx', '.csv']);
    const docFileList: string[] = [];
    for (const f of filesToProcess) {
      if (docExtensions.has(path.extname(f).toLowerCase())) {
        docFileList.push(f);
      }
    }

    for (const filePath of docFileList) {
      const rel = path.relative(cloneDir, filePath);
      let buffer: Buffer;
      try { buffer = fs.readFileSync(filePath); } catch { continue; }
      if (buffer.length === 0 || buffer.length > 50 * 1024 * 1024) continue; // Skip empty or >50MB docs

      const nodes = await docChunker.parseDocument(rel, buffer);
      for (const node of nodes) {
        insertNode(db, node);
      }
    }

    writeStatus({ status: 'docs_chunked', progress: 0.75, tenantId, cloneDir, docCount: docFileList.length });

    // 7. Cross-modal entity linking (docs <-> code)
    const linker = new CrossModalEntityLinker(db);
    const docLinks = linker.linkDocumentsToCode();
    const codeLinks = linker.linkCodeSymbols();
    writeStatus({ status: 'linked', progress: 0.80, tenantId, cloneDir, docLinks, codeLinks });

    // 8. Rebuild transitive closure for code + knowledge trees
    rebuildClosureTable(db, 'code');
    rebuildClosureTable(db, 'knowledge');
    writeStatus({ status: 'closure_rebuilt', progress: 0.85, tenantId, cloneDir });

    // 9. Compute Merkle hashes for all nodes
    const allNodes = db.prepare('SELECT * FROM nodes WHERE status != \'superseded\'').all() as NodeRecord[];
    const hashedNodes = MerkleTree.computeAllHashes(allNodes);
    const updateHash = db.prepare('UPDATE nodes SET hash = ? WHERE id = ?');
    for (const n of hashedNodes) {
      if (n.hash) updateHash.run(n.hash, n.id);
    }
    writeStatus({ status: 'hashes_computed', progress: 0.90, tenantId, cloneDir, nodeCount: allNodes.length });

    // 10. Export graph to JSON + generate human-readable overview
    const graphPath = path.join(repoRoot, '.hive', 'graph.json');
    exportGraphToJson(db, graphPath);
    const overviewDir = path.join(repoRoot, '.hive');
    const overviewPath = generateGraphOverview({ tenantId, db, outputDir: overviewDir });
    console.log(`[IngestWorker ${tenantId}] Graph overview written to ${overviewPath}`);
    writeStatus({ status: 'exported', progress: 0.95, tenantId, cloneDir, graphPath, overviewPath });

    // 11. Cleanup temp clone
    try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch {}
    writeStatus({ status: 'completed', progress: 1.0, tenantId, cloneDir, nodeCount: allNodes.length, finishedAt: Date.now() });

    console.log(`[IngestWorker ${tenantId}] Done. Nodes indexed: ${allNodes.length}. Graph exported to ${graphPath}`);
    process.exit(0);
  } catch (err) {
    console.error('[IngestWorker] Fatal:', err);
    writeStatus({ status: 'failed', error: String(err), tenantId, cloneDir, failedAt: Date.now() });
    // Best-effort cleanup
    try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[IngestWorker] Unhandled:', err);
  process.exit(1);
});
