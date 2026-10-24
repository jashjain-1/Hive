# Using Hivemind from an MCP client

This is the short, practical guide to the tool workflow. Hosting and client configs are in
[HOSTING.md](HOSTING.md).

## The model

Hivemind builds a hierarchical graph of a repository:

- **Code** is split below file level (functions, classes, methods) by Tree-sitter.
- **Documents** (Markdown, PDF, DOCX, PPTX, XLSX, CSV, text) become section/sheet/page nodes.
- **Memory** notes, decisions, tasks, and signals live in the same SQLite database.
- Every node has `L0` (one-line gist), `L1` (summary), `L2` (authored content), and
  optionally `L3` (raw blob).

You do not read whole files. You ask for a budgeted pack, then expand only what matters.

## First run

1. Check the server is alive and see what is indexed:

   ```json
   { "tool": "status", "arguments": {} }
   ```

   A new tenant returns `nodes: 0` and an empty default workspace.

2. Index the repository:

   ```json
   { "tool": "index", "arguments": { "target": "." } }
   ```

   With stdio this is the `--repo` directory. On a hosted gateway use an `https` Git URL.
   One pass is enough; re-run after large changes.

3. Search before packing when you are unsure of names:

   ```json
   { "tool": "find", "arguments": { "query": "verifyJwt", "budget": 400 } }
   ```

## The core loop

### 1. `pack` — the main entrypoint

```json
{ "tool": "pack", "arguments": { "task": "Fix expired JWT handling in the auth flow", "budget": 1200 } }
```

Output starts with `HIVE_PACK`, the budget actually used, the item count, and a measured
ROI line:

```text
HIVE_PACK pk_...
Task: Fix expired JWT handling in the auth flow
Budget: 1200 tok | Used: 1043 tok | Slack remaining: 157 tok
Items: 12 | Deferred: 31
[ROI TELEMETRY: Loaded 1043 tok vs 18,420 baseline | Saved 17,377 tok (94.3% reduction)]
```

Each item is an `L0`/`L1`/`L2` chunk with a one-line reason. The 10% slack reserve is
intentional: it leaves room for the agent's own reasoning and follow-up reads.

Budget guidance:

| Budget | Use |
|---|---|
| 400–600 | Narrow bug fix in one module |
| 800–1200 | Normal feature work (default 1200) |
| 1600–3000 | Cross-module refactor or architecture question |
| 3000+ | Only when the task genuinely spans many subsystems |

Bigger is not better. A focused 800-token pack usually beats a 4000-token dump.

### 2. `peek` / `expand` — read precisely

```json
{ "tool": "peek", "arguments": { "node": "c:1a2b...", "depth": 1, "level": "0" } }
{ "tool": "expand", "arguments": { "node": "c:1a2b...", "level": "2" } }
```

- `peek` lists a subtree as TSV at `L0` or `L1`. Cheap orientation.
- `expand` loads one node at `L1`, `L2`, or `L3`.
- Both end with a `NEXT_HOPS` footer pointing at related code or docs.

Prefer `expand` on a node named in the pack over re-packing with a bigger budget.

### 3. `explain` — audit a decision

```json
{ "tool": "explain", "arguments": { "node": "c:1a2b..." } }
```

Explains why the node was included or deferred by the latest pack, with composite,
lexical, vector, graph, and level factors. Use it when a pack looks wrong.

### 4. `next` — follow the association graph

```json
{ "tool": "next", "arguments": { "node": "verifyJwt", "task": "JWT expiry" } }
```

Returns ranked next hops (`implements`, `specifies`, `calls`, `tests`, `mentions`) and
short cognitive trails. Useful after a `peek` when the next file is not obvious.

### 5. `impact` — what does my change touch?

```json
{ "tool": "impact", "arguments": {} }
{ "tool": "impact", "arguments": { "target": "src/auth.ts" } }
```

With no target it reads the working-tree diff; with a target it analyzes that file or
symbol. Returns modified nodes and the downstream call/import blast radius. Run it before
editing callers, and again before declaring a change complete.

## Steering the pack

### Pins

```json
{ "tool": "pin", "arguments": { "target": "src/generated/client.ts", "action": "exclude" } }
{ "tool": "pin", "arguments": { "target": "docs/architecture.md", "action": "include" } }
{ "tool": "pin", "arguments": { "target": "docs/architecture.md", "action": "clear" } }
```

Pins accept a path, glob, or symbol. `exclude` keeps noisy or vendored code out even when
it matches lexically; `include` forces context into every pack. Pins persist in
`.hive/overrides.json` for the workspace.

### Task phrasing

The task string drives lexical + semantic ranking and intent weights. Name the symptom
and the subsystem:

- Good: `Fix expired JWT handling in the auth middleware`
- Weak: `fix bug`
- Good: `Add pagination to the users list API and its tests`
- Weak: `users`

## Persistent memory and coordination

### Notes, facts, decisions

```json
{ "tool": "write", "arguments": {
  "parent": "root",
  "kind": "decision",
  "name": "Auth token rotation",
  "content": "Rotate refresh tokens every 30 days; access tokens stay at 15 minutes."
} }
```

`kind` is `note`, `fact`, `decision`, or `tombstone`. Memory nodes participate in search
and packs like code nodes, so a later `pack("why do refresh tokens rotate")` can surface
the decision.

Use `tombstone` to mark obsolete knowledge instead of leaving stale facts active.

### Tasks and signals

```json
{ "tool": "task", "arguments": { "verb": "claim", "id": "AUTH-42", "payload": "investigating expiry" } }
{ "tool": "task", "arguments": { "verb": "report", "id": "AUTH-42", "payload": "root cause found" } }
{ "tool": "signal", "arguments": { "channel": "auth", "message": "avoid touching token cache; migration in progress" } }
```

Tasks are last-writer-wins rows. Signals are append-only channel messages capped at 100
tokens per message. Both are scoped to the tenant database.

### Branches

```json
{ "tool": "branch", "arguments": { "verb": "fork", "id": "experiment-1" } }
{ "tool": "branch", "arguments": { "verb": "diff", "id": "experiment-1" } }
{ "tool": "branch", "arguments": { "verb": "merge", "id": "experiment-1" } }
```

Branches are lightweight memory overlays: fork, inspect, then merge or discard. They do
not copy the graph.

## Multi-agent patterns

- **One tenant per project**, not per agent. Agents sharing a project should share the
  tenant so memory and signals are visible to everyone.
- Claim a task before editing, report when done, and post a signal when you change a
  shared contract.
- Use `impact` after another agent's change to see what moved.
- Give each agent a modest pack budget; let `next`/`expand` pull the rest on demand.

## What good output looks like (illustrative)

```text
HIVE_PACK pk_7f3...
Task: Fix expired JWT handling in the auth flow
Budget: 1200 tok | Used: 1043 tok | Slack remaining: 157 tok
Items: 12 | Deferred: 31
[ROI TELEMETRY: Loaded 1043 tok vs 18,420 baseline | Saved 17,377 tok (94.3% reduction)]

## c:9f... verifyJwt [L2, 240 tok]
reason: Direct lexical match (0.91) | Called by loginUser | Cluster: auth
...
NEXT_HOPS:
1. [c:...] loginUser (calls verifyJwt) -> Priority 0.92 [18 tok L0]
```

Follow the `NEXT_HOPS` footer instead of guessing file paths.

## Failure modes to avoid

- **Packing before indexing.** `status` shows zero nodes; run `index` first.
- **Huge budgets.** They dilute attention and invite low-relevance chunks. Start at 800.
- **Ignoring `deferred`.** It tells you what was deliberately left out and why; if the
  needed symbol is there, raise the budget slightly or pin it.
- **Indexing generated/vendor directories.** Add them to `.gitignore` or pin them
  `exclude`. The walker already skips `.git`, `node_modules`, `.venv`, `__pycache__`, and
  heavy binaries, but project-specific output dirs need a pin.
- **Treating `tenantId` as auth.** It is a namespace. Use `HIVE_API_KEY` and separate
  deployments for real isolation.
