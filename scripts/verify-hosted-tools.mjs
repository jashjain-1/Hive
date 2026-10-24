#!/usr/bin/env node
/**
 * Verify a hosted Hivemind MCP server through the same interface a client uses.
 *
 * Usage:
 *   node scripts/verify-hosted-tools.mjs
 *   BASE_URL=https://my-service.onrender.com API_KEY=... \
 *     REPO_URL=https://github.com/vercel/ms node scripts/verify-hosted-tools.mjs
 *
 * It speaks raw JSON-RPC over Streamable HTTP (no SDK, no session state), so a
 * pass here means the deployed link really answers every tool.
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:3999').replace(/\/$/, '');
const API_KEY = process.env.API_KEY ?? '';
const TENANT = process.env.TENANT ?? 'verify';
const REPO_URL = process.env.REPO_URL ?? 'https://github.com/vercel/ms';
const SKIP_INDEX = process.env.SKIP_INDEX === '1';

let requestId = 0;
let passed = 0;
const failures = [];

function headers() {
  const out = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };
  if (API_KEY) out.authorization = `Bearer ${API_KEY}`;
  return out;
}

function endpoint(path) {
  return `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}tenantId=${encodeURIComponent(TENANT)}`;
}

function parseBody(text, contentType) {
  if (contentType.includes('text/event-stream')) {
    const line = text
      .split('\n')
      .map(entry => entry.trim())
      .filter(entry => entry.startsWith('data:'))
      .pop();
    if (!line) throw new Error('empty event stream');
    return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
}

async function rpc(method, params) {
  const response = await fetch(endpoint('/mcp'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const body = parseBody(text, response.headers.get('content-type') ?? '');
  if (body.error) throw new Error(`${method} -> ${JSON.stringify(body.error)}`);
  return body.result;
}

async function callTool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args });
  const text = (result.content ?? [])
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
  if (result.isError) throw new Error(`${name} returned an error: ${text.slice(0, 500)}`);
  return text;
}

async function rest(path, expect = 'text') {
  const response = await fetch(endpoint(path), { headers: headers() });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
  return expect === 'json' ? JSON.parse(text) : text;
}

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

function includes(value, needle, label) {
  assert(String(value).includes(needle), `${label ?? 'output'} missing ${JSON.stringify(needle)}`);
}

async function main() {
  console.log(`[verify] ${BASE_URL} tenant=${TENANT} auth=${API_KEY ? 'bearer' : 'none'}\n`);

  const health = await rest('/health', 'json');
  assert(health.status === 'healthy', `health is ${health.status}`);

  let tools = [];
  await test('tools/list exposes the full 14-tool catalog', async () => {
    const result = await rpc('tools/list', {});
    tools = result.tools.map(tool => tool.name).sort();
    const expected = [
      'branch', 'expand', 'explain', 'find', 'impact', 'index',
      'next', 'pack', 'peek', 'pin', 'signal', 'status', 'task', 'write'
    ];
    assert(JSON.stringify(tools) === JSON.stringify(expected), `got: ${tools.join(', ')}`);
  });

  if (!SKIP_INDEX) {
    await test(`index clones and indexes ${REPO_URL}`, async () => {
      const text = await callTool('index', { target: REPO_URL });
      includes(text, 'Indexed', 'index output');
      includes(text, 'Nodes:', 'index output');
    });
  }

  let nodeId = '';
  let filePath = '';
  let packText = '';

  await test('status reports populated counts', async () => {
    const status = JSON.parse(await callTool('status'));
    assert(status.nodes > 0, `nodes=${status.nodes}; run index first`);
    assert(status.indexedFiles > 0, 'indexedFiles is 0');
    nodeId = nodeId || '';
  });

  await test('find locates a symbol and returns tsV rows', async () => {
    const text = await callTool('find', { query: 'format', budget: 400 });
    includes(text, 'FIND', 'find output');
    const match = text.match(/^((?:c|d|m):[^\t\n]+)\t([^\t\n]*)\t([^\t\n]*)\t([^\t\n]*)/m);
    assert(match, `no node row in find output:\n${text.slice(0, 400)}`);
    nodeId = match[1];
    filePath = match[4] || '';
  });

  await test('peek returns a subtree at L0', async () => {
    const text = await callTool('peek', { node: nodeId, depth: 1, level: '0' });
    includes(text, nodeId, 'peek output');
    includes(text, 'peek', 'peek output');
  });

  await test('expand returns authored content at L2', async () => {
    const text = await callTool('expand', { node: nodeId, level: '2' });
    assert(text.length > 20, 'expand returned no content');
    assert(!text.includes('Node not found'), 'expand could not resolve the node');
  });

  await test('pack compiles a budgeted HIVE_PACK', async () => {
    packText = await callTool('pack', {
      task: 'format milliseconds into a human readable string',
      budget: 800,
      explain: true
    });
    includes(packText, 'HIVE_PACK', 'pack output');
    includes(packText, 'ROI TELEMETRY', 'pack output');
  });

  await test('explain audits the latest pack decision', async () => {
    const text = await callTool('explain', { node: nodeId });
    includes(text, 'Scores:', 'explain output');
  });

  await test('next returns associative NEXT_HOPS', async () => {
    const text = await callTool('next', { node: nodeId, task: 'format milliseconds' });
    includes(text, 'NEXT_HOPS', 'next output');
  });

  await test('impact analyzes a file blast radius', async () => {
    const text = await callTool('impact', filePath ? { target: filePath } : {});
    includes(text, 'IMPACT', 'impact output');
  });

  await test('pin persists include then clear', async () => {
    const pinned = await callTool('pin', { target: filePath || '**/index.ts', action: 'include' });
    includes(pinned, 'force_include', 'pin output');
    const cleared = await callTool('pin', { target: filePath || '**/index.ts', action: 'clear' });
    includes(cleared, 'force_include', 'clear output');
  });

  let memoryId = '';
  await test('write creates a durable decision node', async () => {
    const text = await callTool('write', {
      parent: 'root',
      kind: 'decision',
      name: 'Verification decision',
      content: 'This decision was written through the hosted MCP link.'
    });
    includes(text, 'Created decision node', 'write output');
    const match = text.match(/((?:m|c|d):[A-Za-z0-9:_-]+)/);
    assert(match, `could not parse node id from: ${text}`);
    memoryId = match[1];
  });

  await test('peek reads the written memory node', async () => {
    const text = await callTool('peek', { node: memoryId, depth: 0, level: '0' });
    includes(text, 'Verification decision', 'peek(memory)');
  });

  await test('task claim/report/handoff round-trips', async () => {
    const claim = await callTool('task', { verb: 'claim', id: 'VERIFY-1', payload: 'verifier' });
    includes(claim, 'claimed', 'task claim');
    const report = await callTool('task', { verb: 'report', id: 'VERIFY-1', payload: 'checked' });
    includes(report, 'reported', 'task report');
    const handoff = await callTool('task', { verb: 'handoff', id: 'VERIFY-1', payload: 'done' });
    includes(handoff, 'handed_off', 'task handoff');
  });

  await test('signal posts to a channel and echoes recent messages', async () => {
    const text = await callTool('signal', { channel: 'verification', message: 'all tools reachable over the link' });
    includes(text, 'Signal posted', 'signal output');
    includes(text, 'all tools reachable', 'signal output');
  });

  await test('branch fork/diff/merge works', async () => {
    const fork = await callTool('branch', { verb: 'fork', id: 'verify-branch' });
    includes(fork, 'Forked', 'branch fork');
    const diff = await callTool('branch', { verb: 'diff', id: 'verify-branch' });
    includes(diff, 'verify-branch', 'branch diff');
    const merge = await callTool('branch', { verb: 'merge', id: 'verify-branch' });
    includes(merge, 'Merged', 'branch merge');
  });

  await test('GET /graph.json returns the graph payload', async () => {
    const payload = await rest('/graph.json', 'json');
    assert(Array.isArray(payload.nodes) && payload.nodes.length > 0, 'graph has no nodes');
    assert(Array.isArray(payload.links), 'graph has no links array');
  });

  await test('GET /graph-overview returns GRAPH_OVERVIEW.md', async () => {
    const markdown = await rest('/graph-overview');
    includes(markdown, 'Hivemind Context Graph', 'graph overview');
    includes(markdown, 'Graph Statistics', 'graph overview');
  });

  await test('GET /chat-start returns the compact session card', async () => {
    const card = await rest('/chat-start');
    includes(card, 'Hivemind Context Graph', 'chat-start card');
    includes(card, 'Indexed:', 'chat-start card');
  });

  await test('GET /index-status returns the tenant status', async () => {
    const status = await rest('/index-status', 'json');
    assert(status.nodes > 0, 'index-status has no nodes');
  });

  await test('GET /graph serves the interactive UI', async () => {
    const html = await rest('/graph');
    includes(html, '<canvas', 'graph page');
    includes(html, 'hiveApiKey', 'graph page');
  });

  const total = passed + failures.length;
  console.log(`\n[verify] ${passed}/${total} checks passed`);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\n--- ${failure.name} ---`);
      console.error(failure.error instanceof Error ? failure.error.stack : failure.error);
    }
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('[verify] fatal:', error);
  process.exitCode = 1;
});
