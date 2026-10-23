# Synthesis Integrator & Final Merge Protocol (AI Directive)

> **Role**: Synthesis Integrator / Release Engineer  
> **Objective**: Merge the 3 feature branches (`feat/komal-ingest-ast`, `feat/anjali-pack-ranker`, `feat/jash-mcp-protocol`) into `main` with zero regression, validated cross-package contracts, and 100% test pass rate.  
> **Execution Lead**: Jash or an Integration Agent

---

```markdown
You are an expert Release Engineer and Synthesis Integrator executing the final merge of the Hivemind Context Engine monorepo.

### 1. PRE-MERGE HEALTH & INTEGRITY AUDIT
Before merging any branch into `main`, execute the following sequential audit:

#### Step 1: Verify Git Cleanliness & Branch Status
```bash
git fetch origin
git status
```
Ensure no uncommitted dirty files or unstaged changes exist.

#### Step 2: Audit Branch 1 (Komal - Storage & AST)
```bash
git checkout feat/komal-ingest-ast
npm install
npm run build -w @hivemind/core
npm test -w @hivemind/core
```
Verify:
- Tree-sitter WASM chunker correctly parses test TypeScript and Python files.
- SQLite WAL mode is configured (`PRAGMA journal_mode = WAL`).
- `.hive/graph.json` export produces valid JSON matching the `@hivemind/types` schema.

#### Step 3: Audit Branch 2 (Anjali - Pack & Intelligence)
```bash
git checkout feat/anjali-pack-ranker
npm run build -w @hivemind/pack
npm test -w @hivemind/pack
```
Verify:
- Local embeddings (`@xenova/transformers`) compute cosine similarity without external network calls.
- Knapsack pack compiler respects budget limits and preserves 10% slack.
- Every selected and deferred chunk has a non-empty `reason` string.

#### Step 4: Audit Branch 3 (Jash - MCP Protocol & Stdio)
```bash
git checkout feat/jash-mcp-protocol
npm run build -w @hivemind/mcp
npm test -w @hivemind/mcp
```
Verify:
- `@modelcontextprotocol/sdk` Stdio server registers all 9 tools: `peek`, `expand`, `find`, `pack`, `explain`, `write`, `task`, `signal`, `branch`.
- Tool schemas compile under 700 tokens total.

---

### 2. THREE-WAY CONVERGENCE & MERGE WORKFLOW

Execute merge into `main` in dependency order:

```bash
# 1. Switch to main and update
git checkout main
git pull origin main

# 2. Merge Core Storage (Komal)
git merge --no-ff feat/komal-ingest-ast -m "feat(core): merge AST Tree-sitter chunker and SQLite WAL engine"

# 3. Merge Pack Engine (Anjali)
git merge --no-ff feat/anjali-pack-ranker -m "feat(pack): merge task-aware prioritization and knapsack compiler"

# 4. Merge MCP Protocol Gateway (Jash)
git merge --no-ff feat/jash-mcp-protocol -m "feat(mcp): merge stdio MCP server, 9 tools, and window protocol"
```

---

### 3. MONOREPO GLOBAL VALIDATION GATE

Run the unified monorepo verification commands:

```bash
# 1. Clean build across all packages
npm run clean
npm install
npm run build

# 2. Strict typecheck across all workspaces
npm run typecheck

# 3. Run all unit test suites
npm test

# 4. Run End-to-End Simulation Test
npx tsx scripts/test-e2e-simulation.ts

# 5. Verify Git Safety Hook
node scripts/ai-session-logger.js
```

---

### 4. CONFLICT RESOLUTION PROTOCOL (If Merge Conflicts Arise)
If a conflict occurs in:
1. `packages/types/src/index.ts`:
   - Treat `packages/types` as the contract authority. Never delete fields needed by another package. Prefer union types and non-breaking optional fields.
2. `package.json` (Root or Package):
   - Combine dependencies additively. Ensure workspace versions match (`workspace:*`).
3. `.hive/graph.json`:
   - Never manually resolve raw JSON conflicts. Re-run `npx tsx scripts/export-graph.ts` to regenerate the graph snapshot from the SQLite database.

---

### 5. RELEASE TAGGING & PUSH
Once all checks pass:
```bash
git tag -a v2.0.0 -m "Release: Hivemind Context Engine v2.0.0 (MCP Backend)"
git push origin main --tags
```
```
