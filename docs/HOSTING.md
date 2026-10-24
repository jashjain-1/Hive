# Hosting Hivemind as an MCP server

Hivemind is one MCP server with two transports:

| Transport | Endpoint | Use it when |
|---|---|---|
| **Streamable HTTP** | `POST /mcp?tenantId=<id>` | Remote clients (Claude connectors, Cursor, VS Code, custom agents). Stateless and reconnect-safe. |
| **Legacy SSE** | `GET /sse?tenantId=<id>` + `POST /messages` | Older MCP clients that only speak SSE. |
| **stdio** | `node packages/mcp/dist/main.js` | Local, offline, single-developer use. No HTTP server involved. |

The tool surface is identical on all three. Pick one transport per client, not both.

---

## 1. Local stdio (fastest path)

### Prerequisites

- Node.js 20 or newer (`node -v`)
- Git on `PATH` (`git --version`)
- A repository you want the agent to understand

### Build and run

```bash
npm ci
npm run build

# Smoke-test the server before wiring a client:
node packages/mcp/dist/main.js --repo /absolute/path/to/your/repo
```

The process prints one line to stderr and then waits for JSON-RPC on stdin. That is
normal. Press `Ctrl+C` to stop it.

Options:

```text
-r, --repo <path>     Repository to index (default: cwd or HIVE_REPO_ROOT)
    --db <path>       SQLite path (default: <repo>/.hive/tenants/<tenant>.db)
    --tenant <id>     Tenant namespace (default: default)
    --no-embeddings   Lexical-only mode; no ONNX model download
-h, --help            Show help
```

Verify the tools without an editor:

```bash
npm run inspector
# opens the MCP Inspector against the stdio server with --repo .
```

### Claude Desktop (local stdio)

Config file locations:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "node",
      "args": [
        "/absolute/path/to/Hive/packages/mcp/dist/main.js",
        "--repo",
        "/absolute/path/to/your/project"
      ],
      "env": {
        "HIVE_EMBEDDINGS": "off"
      }
    }
  }
}
```

Use an absolute `node` path if Claude cannot find Node (`C:\\Program Files\\nodejs\\node.exe`
on Windows, `/usr/local/bin/node` or `which node` elsewhere). Restart Claude Desktop
completely after editing the file. The server appears under the tools/connectors menu.

> Use `dist/main.js`, **not** `dist/index.js`. `index.js` is the library entrypoint; it
> does not start a transport.

### Cursor (local stdio)

Project config `.cursor/mcp.json` (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "hivemind": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${workspaceFolder}/packages/mcp/dist/main.js",
        "--repo",
        "${workspaceFolder}"
      ],
      "env": {
        "HIVE_EMBEDDINGS": "off"
      }
    }
  }
}
```

This assumes Cursor opened the Hive repository itself. If you want Hivemind for a
different project, point both paths at that project and use the installed Hive path for
`main.js`.

### VS Code (local stdio)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "hivemind": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${workspaceFolder}/packages/mcp/dist/main.js",
        "--repo",
        "${workspaceFolder}"
      ]
    }
  }
}
```

---

## 2. Hosted Streamable HTTP

### 2.1 Run the container locally

```bash
docker build -t hivemind-mcp .

docker run --rm -p 3000:3000 \
  -e HIVE_API_KEY=change-me \
  -e HIVE_EMBEDDINGS=off \
  -v hivemind-data:/app/.hive \
  hivemind-mcp
```

Check it:

```bash
curl http://localhost:3000/health
curl -H "Authorization: Bearer change-me" http://localhost:3000/
```

The root document lists the active endpoints and whether auth is required. `/health`
and `/` are public; everything else requires the bearer token when `HIVE_API_KEY` is set.

`-v hivemind-data:/app/.hive` keeps SQLite databases and cloned repositories across
container restarts. Without a volume, hosted state is ephemeral.

### 2.2 Render (one-click blueprint)

`render.yaml` defines a Docker web service with a `/health` check, conservative
free-tier limits, and a generated `HIVE_API_KEY`.

1. Push this repository to GitHub. The blueprint deploys the `main` branch.
2. In Render: **New > Blueprint**, select the repository, apply.
3. Wait for the first build. `GET https://<service>.onrender.com/health` should return
   `{"status":"healthy", ...}`.
4. Open the service's **Environment** tab and copy `HIVE_API_KEY`. If Render does not
   reveal the generated value, replace it with your own random string and redeploy.
5. Your MCP endpoint is:

   ```text
   https://<service>.onrender.com/mcp?tenantId=default
   ```

Free-plan caveats:

- **Ephemeral disk.** Databases and cloned repos disappear on restart or redeploy. For
  durable memory, use a paid instance with a persistent disk mounted at `/var/hive-data`
  and set `HIVE_DATA_ROOT=/var/hive-data` (state lands in
  `/var/hive-data/.hive/...`). Point `HIVE_DATA_ROOT` at the disk's parent/mount
  directory, not at a directory named `.hive`.
- **Cold starts.** A sleeping free instance can take ~50 seconds to answer the first
  request. Clients may time out once; retry.
- **Memory.** `HIVE_EMBEDDINGS=off` is set in the blueprint. Enable embeddings on a paid
  plan with enough RAM for the ONNX model, or leave them off; lexical + graph ranking
  still works.
- **Single instance.** SQLite and the in-memory tenant cache are per process. Do not
  scale to multiple replicas sharing one disk.

### 2.3 Any other Docker host

Set `PORT`, `HIVE_API_KEY`, and a persistent volume. Put TLS in front (Render, Fly,
Railway, Caddy, nginx, or a load balancer). If your proxy buffers responses, disable
buffering for `/sse` and `/mcp` so event streams flush immediately.

```bash
docker run -d --name hivemind \
  -p 3000:3000 \
  -e PORT=3000 \
  -e HIVE_API_KEY="$(openssl rand -hex 24)" \
  -e HIVE_EMBEDDINGS=off \
  -e HIVE_MAX_FILES=3000 \
  -v /srv/hivemind/.hive:/app/.hive \
  hivemind-mcp
```

Use one instance per trust boundary. The tenant id isolates databases, not users.

---

## 3. Point a remote client at the gateway

### Claude Desktop / Claude web (custom connector)

Remote connectors are brokered through Anthropic's cloud, so the URL must be publicly
reachable over HTTPS (not `localhost` for a remote connector).

1. **Customize > Connectors > Add custom connector**.
2. Name it `Hivemind`, URL `https://<service>.onrender.com/mcp?tenantId=default`.
3. Authentication: **No sign in**.
4. Under **Request headers**, add `Authorization` = `Bearer <HIVE_API_KEY>`.
5. Save, then enable the connector in a conversation.

Claude Desktop can also run the server locally through the stdio config in section 1;
that path does not need a public URL.

### Cursor (remote)

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "hivemind": {
      "url": "https://<service>.onrender.com/mcp?tenantId=default",
      "headers": {
        "Authorization": "Bearer <HIVE_API_KEY>"
      }
    }
  }
}
```

Cursor tries Streamable HTTP first and can fall back to SSE. The `/mcp` endpoint is
stateless, so restarts do not strand the client with an expired session.

### VS Code (remote)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "hivemind": {
      "type": "http",
      "url": "https://<service>.onrender.com/mcp?tenantId=default",
      "headers": {
        "Authorization": "Bearer <HIVE_API_KEY>"
      }
    }
  }
}
```

### Legacy SSE clients

If a client only accepts an SSE URL, use
`https://<service>.onrender.com/sse?tenantId=default` and the same bearer header. SSE
sessions live in memory and expire when the process restarts; reconnect afterward.

### Tenant selection

Prefer the `X-Hive-Tenant` header over `?tenantId=` so tenant ids stay out of access
logs:

```http
X-Hive-Tenant: my-team
Authorization: Bearer <HIVE_API_KEY>
```

---

## 4. Index a repository on a hosted server

Local path indexing is disabled on the gateway. Use a public `https` Git URL, or add a
token for a private repository.

### Through the MCP tool

Ask the agent to call:

```json
{ "tool": "index", "arguments": { "target": "https://github.com/owner/repo" } }
```

This clones into the tenant workspace, indexes, exports `.hive/graph.json`, and returns
counts. Large repositories can take minutes; the tool call stays open.

### Through REST

```bash
curl -X POST https://<service>.onrender.com/index-repo \
  -H "Authorization: Bearer <HIVE_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"repoUrl":"https://github.com/owner/repo","tenantId":"default"}'
```

Private repository:

```bash
curl -X POST https://<service>.onrender.com/index-repo \
  -H "Authorization: Bearer <HIVE_API_KEY>" \
  -H "X-GitHub-Token: ghp_..." \
  -H "Content-Type: application/json" \
  -d '{"repoUrl":"https://github.com/owner/private-repo","tenantId":"default"}'
```

`X-GitHub-Token` is used only for that clone and is never persisted or logged. For a
single-tenant deployment you can instead set the server-side `GITHUB_TOKEN` environment
variable, which also covers the MCP `index` tool.

Allowed clone hosts default to `github.com,gitlab.com,bitbucket.org`. Change
`HIVE_ALLOWED_HOSTS` (comma-separated) if you use another public Git host. The URL must
be `https://`.

---

## 5. Environment variables

| Variable | Default | Applies to | Meaning |
|---|---|---|---|
| `PORT` | `3000` | hosted | HTTP listen port. |
| `HIVE_API_KEY` | empty | hosted | If set, requires `Authorization: Bearer <key>` on `/mcp`, `/sse`, `/messages`, `/index-repo`. |
| `HIVE_DATA_ROOT` | current directory | hosted | Parent directory for `.hive/tenants`, `.hive/workspaces`, `.hive/repos`. |
| `HIVE_TENANT_ID` | `default` | stdio | Tenant namespace and default database name. |
| `HIVE_REPO_ROOT` | current directory | stdio | Default repository to index. |
| `HIVE_DB_PATH` | `<repo>/.hive/tenants/<tenant>.db` | stdio | Explicit SQLite path. |
| `HIVE_EMBEDDINGS` | `auto` | both | `off` disables local ONNX embeddings and uses lexical fallback. |
| `HIVE_MAX_FILES` | `5000` | both | Maximum files walked per index pass. |
| `HIVE_MAX_FILE_BYTES` | `2000000` | both | Files above this become metadata stubs. |
| `HIVE_MAX_TENANTS` | `50` | hosted | Maximum cached tenant databases per process. |
| `HIVE_RATE_LIMIT` | `120` | hosted | Requests per minute per IP. |
| `HIVE_CORS_ORIGIN` | `*` | hosted | CORS allow-origin. |
| `HIVE_ALLOWED_HOSTS` | `github.com,gitlab.com,bitbucket.org` | hosted | Allowed clone hosts. |
| `HIVE_GIT_TIMEOUT_MS` | `180000` | hosted | Git clone timeout. |
| `HIVE_ALLOW_QUERY_KEY` | `false` | hosted | Allow `?apiKey=` for clients that cannot send headers (leaks into logs; avoid). |
| `GITHUB_TOKEN` | empty | both | Server-side token for private clones. |

See [`.env.example`](../.env.example). Never commit `.env`.

---

## 6. Persistence

The gateway writes three things under `HIVE_DATA_ROOT`:

```text
.hive/
├── tenants/<tenant>.db      # SQLite WAL graph, receipts, memory, signals
├── workspaces/<tenant>/     # per-tenant working directory
└── repos/<hash>/            # shallow Git clones
```

Mount `.hive` on a persistent volume. On Render's free plan there is no persistent disk,
so every restart starts with an empty graph; re-index after a restart. If you need
durable hosted memory, attach a disk and set `HIVE_DATA_ROOT` to the disk's parent
directory.

SQLite is opened in WAL mode. Back up a tenant by copying its `.db` plus `-wal`/`-shm`
while the process is stopped, or use `sqlite3 .backup`.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401 Unauthorized` | `HIVE_API_KEY` is set but the client is not sending `Authorization: Bearer <key>`. |
| `404 Session not found or expired` on `/messages` | Legacy SSE session died (server restart or idle). Reconnect the SSE client. Prefer `/mcp`. |
| `429 Tenant limit reached` | Too many distinct tenant ids. Reuse an id or raise `HIVE_MAX_TENANTS`. |
| Clone fails with auth error | Private repo: send `X-GitHub-Token` on `/index-repo` or set `GITHUB_TOKEN`. |
| Clone fails with host not allowed | Add the host to `HIVE_ALLOWED_HOSTS`. Only `https://` URLs are accepted. |
| Claude connector cannot connect | Remote connectors call from Anthropic's cloud; the URL must be public HTTPS. Use stdio for a localhost-only setup. |
| Cursor says server unavailable | Check `GET /health`, the URL ends in `/mcp` (not `/sse`) for Streamable HTTP, and the header name/value are exact. |
| First request times out on Render free | Cold start. Retry; the instance is waking. |
| Embedding model download is slow / OOM | Set `HIVE_EMBEDDINGS=off`. Lexical + graph ranking remains active. |
| `docker: healthcheck` failing | The image runs as user `node`; ensure any bind-mounted `.hive` is writable by uid 1000. |
| Indexing stops at 5000 files | Raise `HIVE_MAX_FILES` or index a subdirectory. |

Verify a deployment end to end:

```bash
curl -s https://<service>.onrender.com/health
curl -s -o /dev/null -w "%{http_code}\n" https://<service>.onrender.com/mcp
# 401 is expected when auth is on and no token was sent; 405 means the endpoint is alive.
```
