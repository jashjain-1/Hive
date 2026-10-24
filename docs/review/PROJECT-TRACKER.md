# Hivemind Implementation Tracker

> Neutral, live summary of where the codebase stands and what is left to do.
> Originated from the earlier 8-item implementation list and expanded after the interaction/skills review.

---

## 1. Current implementation state

These are the pieces already in the repo and verified via build + E2E simulation:

- **`packages/core`** — SQLite WAL engine, FTS5, CAS versioning, closure table, Merkle hashes, graph export,
  AST chunker skeleton, universal doc chunker skeleton, cross-modal linker skeleton, ignore engine, secrets
  redactor, git impact analyzer.
- **`packages/pack`** — BM25/graph scoring helpers, knapsack/pack logic, next-hop predictor, explain engine,
  overrides manager, ROI ledger.
- **`packages/mcp`** — 12-tool MCP server, stdio `HiveMcpServer`, SSE gateway with per-tenant SQLite isolation,
  secrets redaction on every response, `/health`, `/sse`, `/messages`, `/index-repo` background ingestion spawn,
  `impact` and `pin` wired to real core/pack helpers, plus Streamable HTTP `/mcp`, a hosted dashboard at `/`,
  `/index-status`, `/rbac/v1/propose`, `/rbac/v1/approve`, `/rbac/v1/pending`, `/rbac/v1/records`.
- **`packages/types`** — shared contracts for nodes, packs, links, impacts, constants.
- **Hosting artifacts** — Dockerfile (multi-stage, model pre-warm attempt), `render.yaml`, README with remote
  SSE/Streamable HTTP quickstart, hosted dashboard section, portable-skill section, and a free-tier persistence
  caveat plus upgrade path.
- **Review artifacts** — `docs/review/README-grill.md`, `docs/review/HIVE-interactions-and-skills.md`,
  `docs/review/answers-2026-10-23.md`, `docs/review/PROJECT-TRACKER.md`.

Verification that has passed:

- `npm run build` across workspaces.
- `node scripts/test-e2e-simulation.ts` reporting all simulated invariants passing.

---

## 2. Current scope decisions from the grill

These are the answers that shaped the implementation and docs:

- **Transport:** add Streamable HTTP alongside SSE; keep SSE for now; do not rip it out yet.
- **TLS:** platform-terminated HTTPS for the hosted path; localhost HTTP is OK for local testing.
- **Primary persona:** a developer already in an AI coding client, with a secondary browser-only persona for the
  hosted dashboard.
- **First run:** 3 steps or fewer — open the dashboard/endpoint, see health, point the existing client at the
  hosted endpoint or enable the skill.
- **Biggest friction:** knowing whether it connected and what to ask next.
- **Interaction surface:** both — in-client for day-to-day tool use, hosted dashboard for status/approval.
- **Direct UI actions:** search/index status, start indexing, preview/review a context pack, view blast radius,
  see connection/health.
- **Risky mutations:** visible and approvable by default for `write`, `branch`, `pin`.
- **Consumption model:** both MCP server and portable skill; the skill should describe the remote endpoint and
  include a short fallback note when no remote server is available.
- **Discovery:** repo-based portable skill plus enable instructions today; registry/marketplace later.
- **Free tier:** comfortable with ephemeral, as long as it is documented and the upgrade path is clear.
- **Explicit exclusions:** no promise of universal client support, no managed brokered connector/marketplace today,
  and not targeting a completely non-technical user with zero client access as the primary story.

---

## 3. Review-driven follow-up list

These are prioritized against the user's grill answers in `docs/review/answers-2026-10-23.md`.

1. ✅ Add Streamable HTTP support alongside SSE so the hosted endpoint reaches more modern clients.
   - Owner: Jash.
   - Status: done in `packages/mcp/src/sse-server.ts` (dual-transport `/sse` + `/mcp`).
   - Blocked-on note: SDK import path must match the installed SDK export shape.
2. ✅ Add a small set of visibility/observability endpoints: `/index-status`, `/rbac/v1/propose`,
   `/rbac/v1/approve`, `/rbac/v1/pending`, `/rbac/v1/records`.
   - Owner: Jash.
   - Status: done in `packages/mcp/src/sse-server.ts`.
3. ⬜ Add interactive-UI hooks on the highest-value tools (for example context-pack review, blast radius, indexing
   progress) so a compatible client can render them; treat this as progressive enhancement.
   - Owner: TBD (likely Jash + Anjali).
   - Status: open.
   - Prerequisite: confirm which target clients support returned interactive UI components.
4. ✅ Sketch a hosted web dashboard skeleton served from the same origin for the browser-only persona.
   - Owner: Jash.
   - Status: done in `packages/mcp/src/sse-server.ts` (`/` dashboard routes).
5. ⬜ Produce a portable skill asset (`SKILL.md` + minimal packaging) that describes Hivemind and how to call the
   remote endpoint, with explicit fallback guidance when no remote server is available.
   - Owner: TBD.
   - Status: open.
   - Prerequisite: pick the canonical skill location and the first target client(s).
6. ✅ Decide and document the free-tier persistence story explicitly in the README and the implementation notes.
   - Owner: Jash.
   - Status: done in README §10.5 and `docs/review/HIVE-interactions-and-skills.md` §5.
7. ✅ Decide which persona is primary and which clients/platforms are explicitly in or out of scope.
   - Owner: Jash.
   - Status: done in `docs/review/answers-2026-10-23.md`.

---

## 3b. Current priority order (answers-driven)

From the grill answers:

1. Streamable HTTP
2. Visibility/approval endpoints
3. Hosted dashboard skeleton
4. Portable skill asset
5. Interactive UI hooks on the highest-value tools

So the top remaining work after this increment is:
- Portable skill asset (`SKILL.md` + minimal packaging + enable instructions).
- Interactive UI hooks on the highest-value tools, once target client support is confirmed.

---

## 4. Verification checklist

Before declaring an increment complete, the tracker should record:

- [x] Typecheck passes for the changed packages.
- [x] `npm run build` passes.
- [x] `node scripts/test-e2e-simulation.ts` still passes.
- [x] Changed Markdown docs are updated to match the new behavior and scope decisions.
- [x] Any new endpoints, transports, or UI hooks are covered by at least one concrete usage description in the
      docs, even if not yet end-to-end tested in a live client.

---

## 5. How to use this tracker

- Update the state section when a package or artifact changes materially.
- Move follow-up items into the state section when they are implemented.
- Keep the verification checklist honest: a passing build is necessary but not sufficient for the interaction
  and skills gaps.
