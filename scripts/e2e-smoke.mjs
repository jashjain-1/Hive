#!/usr/bin/env node
/**
 * Real end-to-end smoke test for the stitched Hivemind stack.
 *
 * Exercises the built packages (not mocks):
 *   1. Local indexing of a git repository
 *   2. find / pack / explain / next / impact / pin / write / signal / task / branch
 *   3. ROI telemetry and secret redaction
 *   4. stdio MCP transport
 *   5. Hosted gateway: Streamable HTTP, legacy SSE, bearer auth, health
 *
 * Usage: npm run test:e2e   (run `npm run build` first)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { HiveContextService, closeHostedServices } = require('../packages/mcp/dist/index.js');
const { startSseServer } = require('../packages/mcp/dist/sse-server.js');
const { WindowEpochManager } = require('../packages/mcp/dist/window/epoch.js');
const { SecretsRedactor } = require('../packages/core/dist/index.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`[FAIL] ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(value, needle, label) {
  if (!String(value).includes(needle)) {
    throw new Error(`${label ?? 'value'} did not include ${JSON.stringify(needle)}`);
  }
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-e2e-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });

  fs.writeFileSync(path.join(root, 'src', 'auth.ts'), [
    'export interface User { id: string; email: string }',
    '',
    'export function verifyJwt(token: string): boolean {',
    "  return token.split('.').length === 3;",
    '}',
    '',
    'export function loginUser(email: string): User {',
    "  const valid = verifyJwt('a.b.c');",
    "  return { id: 'u1', email: valid ? email : 'invalid' };",
    '}',
    ''
  ].join('\n'));

  fs.writeFileSync(path.join(root, 'src', 'report.ts'), [
    'export function renderReport(rows: string[]): string {',
    "  return rows.join('\\n');",
    '}',
    ''
  ].join('\n'));

  fs.writeFileSync(path.join(root, 'docs', 'auth.md'), [
    '# Authentication Architecture',
    '',
    'The login flow validates credentials and calls verifyJwt before creating a session.',
    '',
    '## Token Storage',
    '',
    'Sessions store user id and email in the database.',
    ''
  ].join('\n'));

  fs.writeFileSync(path.join(root, 'README.md'), '# E2E Fixture\n\nSmall repository used by the Hivemind smoke test.\n');

  const git = (...args) => execFileSync(
    'git',
    ['-c', 'user.name=Hive Smoke', '-c', 'user.email=smoke@example.com', ...args],
    { cwd: root, stdio: 'ignore' }
  );
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');

  return root;
}

function removeDir(dir) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) {
        console.warn(`[warn] could not remove ${dir}: ${error.message}`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
}

const fixture = createFixture();
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-e2e-data-'));
let service;

try {
  console.log('[Hivemind E2E] Real integration run\n');

  service = new HiveContextService({
    repoRoot: fixture,
    dbPath: path.join(dataRoot, 'local.db'),
    tenantId: 'e2e',
    embeddings: 'off'
  });

  let nodeId = '';

  await test('local repository indexing builds code + document nodes', async () => {
    const summary = await service.index(fixture);
    assert(summary.filesIndexed >= 4, `expected >=4 files, got ${summary.filesIndexed}`);
    assert(summary.nodesInserted > 5, `expected >5 nodes, got ${summary.nodesInserted}`);
    assert(fs.existsSync(path.join(fixture, '.hive', 'graph.json')), 'graph.json was not exported');

    const status = service.getStatus();
    assert(status.nodes > 5, 'status.nodes too small');
    assert(status.indexedFiles >= 4, 'status.indexedFiles too small');
  });

  await test('hybrid find resolves camelCase symbols and prose', () => {
    const hits = service.search('verifyJwt', 10);
    assert(hits.length > 0, 'no hits for verifyJwt');
    assert(hits.some(hit => hit.node.name.includes('verifyJwt')), 'verifyJwt symbol missing');
    nodeId = hits.find(hit => hit.node.name.includes('verifyJwt')).node.id;

    const result = service.find('jwt verification', 400);
    assertIncludes(result, 'FIND', 'find output');
    assertIncludes(result, 'verifyJwt', 'find output');
    assertIncludes(result, 'NEXT_HOPS', 'find output');
  });

  await test('pack compiles within budget and reports measured ROI', async () => {
    const { pack, text } = await service.pack('Fix JWT verification', 600, true);
    assert(pack.usedTokens <= Math.ceil(600 * 0.9), `used ${pack.usedTokens} > effective budget`);
    assert(pack.items.length > 0, 'pack selected nothing');
    assert(pack.roi, 'pack has no ROI metrics');
    assert(pack.roi.tokensBaselineWholeFiles >= pack.roi.tokensLoaded, 'baseline below loaded tokens');
    assertIncludes(text, 'HIVE_PACK', 'pack output');
    assertIncludes(text, 'verifyJwt', 'pack output');
    assertIncludes(text, 'ROI TELEMETRY', 'pack output');
  });

  await test('explain and next read the latest pack receipt/graph', () => {
    assert(nodeId, 'no node id from find');
    const explanation = service.explain(nodeId, 'Fix JWT verification');
    assertIncludes(explanation, 'verifyJwt', 'explain output');

    const next = service.next(nodeId, 'Fix JWT verification');
    assertIncludes(next, 'NEXT_HOPS', 'next output');
  });

  await test('impact maps a working-tree change to indexed nodes', () => {
    fs.appendFileSync(path.join(fixture, 'src', 'auth.ts'), '\n// smoke: rotated token handling\n');
    const impact = service.impact();
    assertIncludes(impact, 'IMPACT', 'impact output');
    assertIncludes(impact, 'auth.ts', 'impact output');
  });

  await test('pins, memory writes, signals, tasks, and branches persist', () => {
    const pinned = service.pin('src/auth.ts', 'include');
    assertIncludes(pinned, 'force_include', 'pin output');
    assertIncludes(pinned, 'src/auth.ts', 'pin output');
    const cleared = service.pin('src/auth.ts', 'clear');
    assertIncludes(cleared, 'force_include', 'clear output');

    const written = service.write(
      'root',
      'note',
      'rotation key',
      'Rotate with AKIAIOSFODNN7EXAMPLE and ghp_123456789012345678901234567890123456'
    );
    assertIncludes(written, 'Created note node', 'write output');

    const expanded = service.expand('rotation key', 2);
    assertIncludes(expanded, '[REDACTED_AWS_KEY]', 'redacted memory');
    assertIncludes(expanded, '[REDACTED_GITHUB_TOKEN]', 'redacted memory');
    assert(!expanded.includes('AKIAIOSFODNN7EXAMPLE'), 'raw AWS key leaked');

    const signaled = service.signal('ops', 'deploy blocked: AKIAIOSFODNN7EXAMPLE');
    assertIncludes(signaled, 'Signal posted', 'signal output');
    assert(!signaled.includes('AKIAIOSFODNN7EXAMPLE'), 'raw AWS key leaked in signal');

    assertIncludes(service.coordinateTask('claim', 'T-1', 'smoke'), 'claimed', 'task output');
    assertIncludes(service.branch('fork', 'smoke-branch'), 'smoke-branch', 'branch fork');
    assertIncludes(service.branch('diff', 'smoke-branch'), 'smoke-branch', 'branch diff');
    assertIncludes(service.branch('merge', 'smoke-branch'), 'Merged', 'branch merge');
  });

  await test('status aggregates mesh graph and ROI telemetry', () => {
    const status = service.getStatus();
    assert(status.links >= 0, 'links count missing');
    assert(status.roi.packsMeasured >= 1, 'ROI did not measure a pack');
    assert(status.roi.tokensSaved > 0, `ROI saved ${status.roi.tokensSaved} tokens`);
  });

  await test('window epoch protocol freezes/demotes predictably', () => {
    const windows = new WindowEpochManager();
    const window = windows.createWindow('agent', 'task', 'P0', 'P1', 'P2');
    windows.appendChunk(window, { nodeId: 'c:1', level: 2, tokens: 80, content: 'code' });
    windows.appendChunk(window, { nodeId: 'c:2', level: 1, tokens: 40, content: 'summary' });
    assert(windows.shouldTriggerEpoch(window, 100), 'epoch should trigger above 60%');
    const compacted = windows.compactWindow(window);
    assert(compacted.epoch === 1, 'epoch did not advance');
    assert(compacted.p3Chunks[0].level === 1, 'L2 was not demoted to L1');
    assert(compacted.p3Chunks[1].level === 0, 'L1 was not demoted to L0');
    assert(compacted.p4Scratchpad === '', 'scratchpad not cleared');
  });

  await test('stdio MCP transport serves the same tools', async () => {
    const client = new Client({ name: 'hive-e2e-stdio', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(ROOT, 'packages', 'mcp', 'dist', 'main.js'),
        '--repo', fixture,
        '--db', path.join(dataRoot, 'stdio.db'),
        '--no-embeddings'
      ],
      stderr: 'pipe'
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert(tools.tools.length >= 14, `stdio exposed ${tools.tools.length} tools`);
      const indexed = await client.callTool({ name: 'index', arguments: { target: fixture } });
      assertIncludes(indexed.content[0].text, 'Indexed', 'stdio index');
      const status = await client.callTool({ name: 'status', arguments: {} });
      const parsed = JSON.parse(status.content[0].text);
      assert(parsed.nodes > 0, 'stdio sees an empty index');
      const find = await client.callTool({ name: 'find', arguments: { query: 'verifyJwt', budget: 200 } });
      assertIncludes(find.content[0].text, 'verifyJwt', 'stdio find');
    } finally {
      await client.close();
    }
  });

  await test('hosted gateway enforces auth and serves Streamable HTTP + SSE', async () => {
    const hostedRoot = path.join(dataRoot, 'hosted');
    const server = startSseServer({
      port: 0,
      dataRoot: hostedRoot,
      embeddings: 'off',
      apiKey: 'smoke-key'
    });
    await once(server, 'listening');
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: 'Bearer smoke-key' };
    const clients = [];

    try {
      const health = await fetch(`${base}/health`);
      assert(health.status === 200, `health returned ${health.status}`);
      const healthBody = await health.json();
      assert(healthBody.status === 'healthy', 'health body not healthy');

      const unauthorized = await fetch(`${base}/mcp?tenantId=hosted`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      });
      assert(unauthorized.status === 401, `unauthorized /mcp returned ${unauthorized.status}`);

      const badIndex = await fetch(`${base}/index-repo`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'hosted' })
      });
      assert(badIndex.status === 400, `missing repoUrl returned ${badIndex.status}`);

      const httpClient = new Client({ name: 'hive-e2e-http', version: '1.0.0' });
      clients.push(httpClient);
      await httpClient.connect(new StreamableHTTPClientTransport(
        new URL(`${base}/mcp?tenantId=ignored-query`),
        { requestInit: { headers: { ...headers, 'X-Hive-Tenant': 'hosted' } } }
      ));
      const tools = await httpClient.listTools();
      assert(tools.tools.length >= 14, `hosted /mcp exposed ${tools.tools.length} tools`);
      const hostedStatus = JSON.parse(
        (await httpClient.callTool({ name: 'status', arguments: {} })).content[0].text
      );
      assert(hostedStatus.tenantId === 'hosted', 'X-Hive-Tenant header was ignored');

      const sseClient = new Client({ name: 'hive-e2e-sse', version: '1.0.0' });
      clients.push(sseClient);
      await sseClient.connect(new SSEClientTransport(
        new URL(`${base}/sse?tenantId=sse`),
        { requestInit: { headers } }
      ));
      const sseStatus = JSON.parse(
        (await sseClient.callTool({ name: 'status', arguments: {} })).content[0].text
      );
      assert(sseStatus.tenantId === 'sse', 'SSE tenant isolation failed');
    } finally {
      for (const client of clients) {
        await client.close().catch(() => undefined);
      }
      await new Promise(resolve => server.close(resolve));
      closeHostedServices();
    }
  });

  await test('secret redaction primitives cover the documented providers', () => {
    const scrubbed = SecretsRedactor.redact(
      'AKIAIOSFODNN7EXAMPLE ghp_123456789012345678901234567890123456 sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL'
    );
    assertIncludes(scrubbed, '[REDACTED_AWS_KEY]', 'redactor');
    assertIncludes(scrubbed, '[REDACTED_GITHUB_TOKEN]', 'redactor');
    assertIncludes(scrubbed, '[REDACTED_OPENAI_KEY]', 'redactor');
  });
} finally {
  if (service) service.close();
  closeHostedServices();
  removeDir(fixture);
  removeDir(dataRoot);
}

console.log(`\n[Hivemind E2E] ${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`);
    console.error(failure.error instanceof Error ? failure.error.stack : failure.error);
  }
  process.exitCode = 1;
}
