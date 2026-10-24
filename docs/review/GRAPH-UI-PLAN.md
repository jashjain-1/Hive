# Interactive graph UI — implementation plan

Goal: an Obsidian-style graph that shows the Hivemind context graph with per-node scores,
hover details and a click-through panel, reachable from **every** major AI coding client by
pasting the same URL — no install, no download.

---

## 1. The constraint that shapes the design

No single mechanism renders UI in every host:

| Client | MCP Apps (inline iframe) | Works with a plain URL |
|---|---|---|
| Claude Desktop / claude.ai | Yes | Yes |
| VS Code + Copilot | Yes (experimental) | Yes |
| ChatGPT | Yes (MCP Apps standard) | Yes |
| Goose | Yes | Yes |
| Cursor | Not confirmed | Yes |
| Claude Code (CLI) | No | Yes (opens in browser) |
| JetBrains / Neovim / Zed / Windsurf | No | Yes |

So the product is **one UI, two delivery paths**:

1. **Universal path** — the server hosts the graph page itself at `/graph?tenant=...`. The MCP
   tool always returns that URL in its text response, so every client can surface a clickable
   link. This is the "same link, plug and play" guarantee.
2. **In-chat path** — the same page is registered as an MCP Apps resource
   (`ui://hivemind/graph`) and rendered in an iframe by hosts that support the extension. Same
   HTML, same data contract, different transport for the data (MCP bridge vs `fetch`).

One build artifact, one URL, no per-client work. The inline experience upgrades automatically
where the host supports it.

---

## 2. Architecture

```
SQLite (nodes, links) ──► buildGraphPayload() ──┬──► GET /graph.json      (standalone fetch)
                                                └──► show_graph tool result (MCP Apps structuredContent)

graph.html (single file, renderer bundled) ──┬──► GET /graph?tenant=...   (browser tab)
                                             └──► resources/read ui://hivemind/graph (iframe)
```

The page boots in one of two modes:

- **bridge mode** — inside an MCP Apps host: `ui/initialize` handshake over `postMessage`,
  data arrives via `ui/notifications/tool-result`, actions go through `tools/call`.
- **http mode** — standalone: `fetch('/graph.json?tenant=...')`, actions POST to the same
  endpoints the tools use.

Detection is a handshake with a timeout, not user-agent sniffing:

```js
async function connect() {
  const bridge = tryBridge();               // sends ui/initialize, waits 400ms
  const ctx = await Promise.race([bridge, sleep(400).then(() => null)]);
  return ctx ? { mode: 'bridge', ctx } : { mode: 'http' };
}
```

---

## 3. Data contract

`GET /graph.json?tenant=<id>&task=<optional>`

```json
{
  "tenant": "default",
  "generatedAt": 1761390000000,
  "task": "fix jwt auth",
  "stats": { "nodes": 1842, "links": 5210, "subsystems": 12 },
  "nodes": [
    {
      "id": "c:9aa31",
      "name": "verifyToken",
      "kind": "function",
      "subsystem": "auth",
      "file": "src/auth/jwt.ts",
      "lines": [40, 78],
      "status": "live",
      "tokens": { "l0": 18, "l1": 120, "l2": 640 },
      "degree": { "in": 3, "out": 7 },
      "score": {
        "kind": "pack",
        "bm25": 0.42,
        "vector": 0.31,
        "graph": 0.10,
        "composite": 0.83,
        "level": 1,
        "reason": "BM25=0.42 | vector=0.31 | calls verifyToken from 3 sites"
      },
      "pinned": false
    }
  ],
  "links": [{ "src": "c:9aa31", "dst": "c:1120f", "rel": "calls", "w": 0.9 }]
}
```

Rules that keep the numbers honest:

- `score.kind` is `"pack"` only when a `task` is supplied and the score is the real pack score.
  Without a task, emit `"kind": "structural"` with `composite = 0.6·normDegree + 0.3·recency +
  0.1·pinned`. Never label a structural number as a relevance score.
- Send L0/L1/L2 lazily. The initial payload carries L0 only; the detail panel fetches
  `/graph/node?id=...` on click. Keeps the first paint small on large repos.
- Cap `nodes` at 5,000 with a `truncated: true` flag and cluster the rest by subsystem. The
  renderer can request the next slice by subsystem.

`GET /graph/node?tenant=<id>&id=<nodeId>` returns the full record: L0/L1/L2, hash, links in
and out, blast radius from `GitImpactAnalyzer`, and the exact `explain` text.

---

## 4. Rendering

**Library:** sigma.js (WebGL) + graphology. It is the only mainstream option that stays smooth
past ~5k nodes, which real repositories exceed. Cytoscape is the fallback if we need richer
layout algorithms; D3-force is not viable above ~1k nodes.

**Obsidian-like look:**

- dark canvas `#1e1e1e`, no axes, no background grid;
- node colour from a stable hash of `subsystem` (12–16 curated hues, not random);
- node radius `4 + 2·log(1 + degree)`, so hubs read instantly;
- labels only above a zoom threshold, with collision culling;
- edges as thin curves, opacity `0.25 * w`; `calls` solid, `tests` dashed, `mentions` faint;
- selected node gets a 2px ring plus its 1-hop neighbourhood brightened and the rest dimmed to 20%.

**Hover (150 ms delay, near-cursor card):**

```
verifyToken                    function · auth
src/auth/jwt.ts:40–78          live · 7 out / 3 in
score  0.83  ██████████░  bm25 .42  vec .31  graph .10
tokens 18 / 120 / 640          L1 would load
```

The score bars are the feature: a user can see *why* a node is in the pack, which is the thing
the CLI can only say in words.

**Click (right panel, 320 px, resizable):**

1. header: name, kind, subsystem, status, pin toggle;
2. score breakdown with the same bars, plus `reason` verbatim from `explain`;
3. L0 / L1 / L2 tabs with the actual text and token counts;
4. links: outgoing grouped by relation, incoming collapsed;
5. actions: **Ask agent about this** (`ui/update-model-context` in bridge mode, copy-prompt in
   http mode), **Impact** (calls `impact` for the file), **Pin/Exclude** (calls `pin`).

**Performance budget:** first paint < 300 ms for 2k nodes; payload < 2 MB at 2k nodes with L0
only; 60 fps pan/zoom; layout in a worker.

---

## 5. Serving it with no downloads

- One HTML file, renderer inlined at build time (`vite-plugin-singlefile` or esbuild
  `--bundle --format=iife`). No CDN, so no CSP allowlist needed and no host-specific blocking.
- `Content-Security-Policy` on the standalone route: `default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:; connect-src 'self'`.
- MCP Apps resource: `mimeType: text/html;profile=mcp-app`, `_meta.ui.resourceUri` on the tool.
  Declare `_meta.ui.csp.connectDomains` only if the page calls back over HTTP; in bridge mode
  it does not, so the resource can run with no network access at all.
- Size (measured 2026-10-24 from the published packages): `sigma.min.js` 392 KB +
  `graphology.umd.min.js` 74 KB = 466 KB raw; the two concatenated and gzipped at `-9` are
  **114 KB**. Add the forceatlas2 layout module and our own code and expect roughly 130–150 KB
  gzipped. That is comfortable for an inlined single file; large graphs load data incrementally
  rather than inflating the resource itself.

---

## 6. Registration on the current SDK

The repo pins `@modelcontextprotocol/sdk@1.23`. The wire contract is small enough to implement
without jumping to `@modelcontextprotocol/server@2` + `@modelcontextprotocol/ext-apps@2`:

```ts
// tool: always returns a URL so non-MCP-Apps hosts stay usable
server.tool(
  'show_graph',
  { tenant: z.string().optional(), task: z.string().optional() },
  async ({ tenant, task }) => {
    const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
    const url = `${base}/graph?tenant=${encodeURIComponent(tenant ?? 'default')}` +
                (task ? `&task=${encodeURIComponent(task)}` : '');
    return {
      content: [{ type: 'text', text: `Graph: ${url}` }],
      structuredContent: buildGraphPayload(tenant ?? 'default', task),
      _meta: { ui: { resourceUri: 'ui://hivemind/graph' } },
    };
  }
);

// resource: same HTML the standalone route serves
server.resource(
  'hivemind-graph',
  'ui://hivemind/graph',
  { mimeType: 'text/html;profile=mcp-app' },
  async () => ({ contents: [{
    uri: 'ui://hivemind/graph',
    mimeType: 'text/html;profile=mcp-app',
    text: readGraphHtml(),
  }] })
);
```

When the SDK is upgraded, swap these two calls for `registerAppTool` / `registerAppResource`
from `@modelcontextprotocol/ext-apps/server`; the metadata shape does not change.

---

## 7. Security

The graph exposes file paths, symbol names and source text. Today `/graph-overview` is already
public, so `/graph` inherits an existing gap rather than creating a new class — but it makes the
leak browsable.

- Gate `/graph` and `/graph.json` behind the same tenant credential as the MCP tools (C-1 in the
  pentest report). A signed, expiring query token (`?t=<hmac(tenant|exp)>`) lets a user paste the
  link into a chat without a cookie.
- Redact node L0/L1 text through `SecretsRedactor` on the way out, same as the tools.
- Rate-limit `/graph.json` per IP; it is a full-graph read.
- Do not put the GitHub token in the page or the URL.

---

## 8. Build order

| Phase | Deliverable | Why first |
|---|---|---|
| 1 | `/graph.json` + `/graph` standalone page with hover + click panel | Works in every client today, no protocol work |
| 2 | `show_graph` tool returning the URL + `structuredContent` | Makes the graph one click from any agent |
| 3 | MCP Apps resource + bridge mode | Inline rendering where supported, same bundle |
| 4 | Actions (pin, impact, ask-agent) with `ui/update-model-context` | Closes the loop: selection becomes context |
| 5 | LOD clustering, lazy node fetch, signed URLs | Large repos + multi-tenant |

Phase 1 alone is a usable product; phases 2–4 are what make it feel native inside Claude,
VS Code and ChatGPT.
