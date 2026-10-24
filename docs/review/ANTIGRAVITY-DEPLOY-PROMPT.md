# Antigravity prompt — deploy Hivemind as a live MCP server (no assumptions)

Paste everything below into Antigravity. Run it in a session with browser access.

---

You are deploying this repository as a public remote MCP server. Work only from evidence you
can point to: file contents you read, commands you ran with their exit status, and what you
saw in the browser. Never state a URL, service name, container state, or "it works" unless you
observed it in this session. If a fact is unknown, look it up or stop and ask — do not guess.

Use the browser (`/browser`) for every Render.com action. Do not use the Render API or invent
endpoints. Do not modify git history, force-push, or change the deploy branch.

## Phase 0 — Establish facts (no changes yet)

1. `git remote -v`, `git branch --show-current`, `git status --short`. Record the remote, branch,
   and whether the working tree has uncommitted changes. If the tree is dirty, stop and ask
   whether to commit before deploying.
2. Read and quote the exact relevant lines from: `render.yaml`, `Dockerfile`, `package.json`,
   `packages/mcp/package.json`, and the route table in `packages/mcp/src/sse-server.ts`
   (`/health`, `/ready`, `/sse`, `/mcp`, `/messages`, `/index-repo`, `/graph-overview`,
   `/chat-start`).
3. List every environment variable the server actually **reads** (`grep -n "process.env"
   packages/mcp/src/sse-server.ts`, `packages/mcp/src/ingest-worker.ts`, `packages/pack/src/*`).
   Then list every variable `render.yaml` **sets**. Report the difference explicitly.
   Known trap to confirm: `HIVE_TENANT_DIR` and `MODEL_CACHE_DIR` are set in `render.yaml` but
   the server computes its paths from `process.cwd()`. Confirm this from the code, and fix it
   either by reading those variables in code or by removing them from `render.yaml` — do not
   leave a comment claiming behaviour the code does not have.
4. Confirm the rate limiter's client-IP strategy. Behind Render, `req.ip` is the proxy unless
   `TRUSTED_PROXY=1` is set. If it is not set, per-IP limits collapse into one global bucket:
   add `TRUSTED_PROXY=1` to `render.yaml` (and say why).
5. Confirm `Dockerfile` does not copy `package-lock.json` before `npm install`. Fix it to
   `COPY package.json package-lock.json ./` + `npm ci` so the image is reproducible, then say so.

## Phase 1 — Prove it builds and runs before touching the cloud

1. `npm run build` — capture the exit code. `npx vitest run test/repo-url.test.ts` in
   `packages/mcp` — capture pass/fail counts.
2. If Docker is available: `docker build -t hivemind-mcp:local .` then
   `docker run --rm -p 3999:3000 -e PORT=3000 hivemind-mcp:local`. If Docker is not running,
   say so and skip Phase 1.2 — do not silently continue as if it passed.
3. Against the container (or `PORT=3999 node packages/mcp/dist/sse-server.js` if Docker is
   unavailable and the host can start it), prove each item and paste the raw response:
   - `GET /health` → 200 with `"status":"healthy"`
   - `GET /sse?tenantId=default` → an SSE stream whose first event is `endpoint` with a
     `/messages?sessionId=...` data line (use `curl -N -m 5`)
   - `POST /mcp?tenantId=default` with an `initialize` JSON-RPC body → a JSON-RPC result
   - `POST /index-repo` with `{"repoUrl":"file:///etc/passwd"}` → 400
   - `POST /index-repo` with `{"repoUrl":"https://evil.example/x.git"}` → 400
   - `POST /index-repo` with `{"repoUrl":"https://github.com/owner/repo;id"}` → 400
4. If any check fails, fix the cause and re-run that check. Do not deploy a red container.

## Phase 2 — Deploy on Render through the browser

1. Open `https://dashboard.render.com`. If signed out, ask the user to sign in and wait.
2. Use **New + → Blueprint** (the repo already has `render.yaml`; do not hand-create a Web
   Service, which would ignore the file). Connect the GitHub account, select this repository
   and the branch from Phase 0, and open the Blueprint preview.
3. Read the preview: service name, environment = Docker, plan = Free, region, branch,
   `healthCheckPath`. Screenshot or quote it. If the repository is not listed, stop and ask the
   user to install/grant the Render GitHub App — do not create a different repo.
4. Apply/Create. Record the service URL Render assigns. Do not assume it matches the service
   name.
5. Watch the build in the Logs tab until it finishes. If it fails, copy the first real error
   (the lines around it, not the last line) and fix the Dockerfile or source, push, and let
   auto-deploy rebuild. Report the failing step honestly if it stays red.
6. Confirm the deploy is live: the service header shows **Live**, and `GET /health` returns 200.

## Phase 3 — Verify the deployed MCP endpoint (the part that is usually skipped)

Run these against the real URL from Phase 2, and paste each result:

1. `GET /health` → 200, `"status":"healthy"`.
2. `GET /ready` → 200 with `{"ready":true}` and no filesystem paths.
3. `GET /` → 200 HTML containing "Hivemind".
4. `curl -N -m 8 "<URL>/sse?tenantId=default"` → first SSE event is `endpoint`.
5. Streamable HTTP handshake against `"<URL>/mcp?tenantId=default"`:
   - `initialize` (protocolVersion `2025-06-18`), then `tools/list`.
   - Capture the `Mcp-Session-Id` response header and send it on the follow-up request.
   - Count the tools. The expected count is 12 (`peek, expand, find, pack, explain, impact,
     next, write, task, signal, branch, pin`). If the count differs, say which are missing.
   - If no session id is returned and `tools/list` fails on a fresh request, report this as a
     defect (the transport is recreated per request) and fix it before declaring success.
6. `POST /index-repo` with the three bad URLs from Phase 1 and confirm 400 with the reason.
7. Cold/warm timing: wait for the free instance to sleep, request `/health` once and time it,
   then time a second request. Report both numbers. Do not claim a start time you did not measure.

## Phase 4 — Hand-off

Produce exactly this, filled with observed values:

- Live MCP URL (SSE and Streamable HTTP forms).
- Client config for Claude Desktop / Cursor / Windsurf, and the equivalent for clients that ask
  only for a URL.
- Health check, dashboard, and graph-overview links.
- A table: each Phase 3 check → pass/fail → the evidence line.
- Limitations you actually observed: ephemeral storage, cold-start behaviour, no authentication
  (any caller who knows a tenant id can read/write it), approvals not enforced, sessions
  recreated per request if still true.
- Anything you changed and why, listed by file.

Do not write "deployment successful" unless every Phase 3 item passed, and do not omit a
failed item to make the summary look clean.
