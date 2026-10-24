import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const htmlPath = 'packages/mcp/dist/ui/graph.html';

const suites = [
  ['packages/core', 'function'],
  ['packages/mcp', 'function'],
  ['packages/pack', 'class'],
  ['docs', 'markdown'],
  ['scripts', 'function'],
];

const nodes = [];
for (let i = 0; i < 240; i++) {
  const [subsystem, kind] = suites[i % suites.length];
  nodes.push({
    id: `c:${i.toString(16)}`,
    name: ['verifyToken', 'packContext', 'GraphView', 'DesignNotes', 'ingestRepo'][i % 5] + i,
    kind,
    subsystem,
    file: `${subsystem}/src/file${i}.ts`,
    lines: [1 + i, 20 + i],
    status: 'live',
    tokens: { l0: 12 + (i % 8), l1: 90 + (i % 60), l2: 400 + (i % 300) },
    degree: { in: i % 7, out: i % 5 },
    score: {
      kind: 'pack',
      bm25: Math.min(1, 0.2 + (i % 10) / 12),
      vector: null,
      graph: Math.min(0.15, (i % 7) / 60),
      composite: Math.min(1, 0.35 + ((i * 37) % 60) / 100),
      level: i % 3,
      reason: `BM25=${(0.2 + (i % 10) / 12).toFixed(2)} | graph=0.05 | synthetic node`,
    },
  });
}

const links = [];
for (let i = 1; i < nodes.length; i++) {
  links.push({ src: nodes[i].id, dst: nodes[Math.floor(i / 3)].id, rel: ['calls', 'imports', 'documents'][i % 3], w: 0.4 + (i % 5) / 10 });
}

const payload = {
  tenant: 'preview',
  generatedAt: Date.now(),
  task: 'preview',
  truncated: false,
  stats: {
    nodes: nodes.length,
    links: links.length,
    subsystems: suites.length,
    tokens: nodes.reduce((s, n) => s + n.tokens.l0 + n.tokens.l1 + n.tokens.l2, 0),
  },
  nodes,
  links,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/graph') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(htmlPath, 'utf8'));
    return;
  }
  if (url.pathname === '/graph.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  if (url.pathname === '/graph/node') {
    const id = url.searchParams.get('id');
    const node = nodes.find((n) => n.id === id);
    if (!node) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: node.id,
      name: node.name,
      kind: node.kind,
      subsystem: node.subsystem,
      file: node.file,
      lines: node.lines,
      status: node.status,
      hash: 'abc123',
      l0: `${node.name} — one line summary`,
      l1: `Summary for ${node.name}. Handles the auth path and returns claims.`,
      l2: `export function ${node.name}() {\n  // synthetic body\n}`,
      tokens: node.tokens,
      outgoing: nodes.slice(1, 4).map((n) => ({ id: n.id, name: n.name, rel: 'calls', w: 0.8, kind: n.kind })),
      incoming: nodes.slice(4, 6).map((n) => ({ id: n.id, name: n.name, rel: 'imports', w: 0.6, kind: n.kind })),
    }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(4123, '127.0.0.1', () => console.log('preview on http://127.0.0.1:4123/graph?tenantId=preview'));
