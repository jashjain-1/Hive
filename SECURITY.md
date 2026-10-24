# Security Policy & Bug Bounty

Hivemind is a hosted MCP server that indexes repositories and serves context to AI agents.
It accepts untrusted input (repo URLs), runs `git` and a parser over untrusted content, and
returns that content into an LLM's context window. Treat it accordingly.

---

## Reporting a vulnerability

**Do not open a public issue for a security bug.**

Use GitHub's private vulnerability reporting on this repository: **Security → Report a
vulnerability**. If that is unavailable, email the maintainer listed in `package.json`.

Include:

- the affected endpoint or tool (for example `POST /index-repo`, `mcp:write`, `git clone`);
- a minimal reproduction — request/response or script, not a screenshot;
- impact: what an attacker gains (SSRF target reachable, tenant escape, RCE, secret disclosed);
- any preconditions (tenant id, token, hosting assumption).

### What to expect

| Stage | Target |
|---|---|
| Acknowledgement | 3 business days |
| Triage + severity decision | 10 business days |
| Critical / High fix | 30 days |
| Medium / Low fix | 90 days |
| Public credit | after the fix ships, at your option |

If a report is valid but we cannot fix it in the window, we will tell you rather than leave
you waiting, and we will coordinate disclosure with you.

---

## Scope

**In scope** — the deployed hosted server and its build:

- `GET /sse`, `POST /mcp`, `GET /mcp`, `POST /messages` — MCP transport and tool dispatch
- `POST /index-repo` — URL validation, DNS/SSRF handling, spawn of the ingest worker
- `packages/mcp/src/ingest-worker.ts` — `git clone`, file walking, chunking
- `packages/core/src/security/secrets-redactor.ts` — redaction bypasses with a concrete payload
- `GET /graph-overview`, `GET /chat-start`, `GET /index-status` — cross-tenant disclosure
- `packages/mcp/src/security/repo-url.ts` — allowlist or scheme bypass
- The Docker image and `render.yaml` — container escape, privilege, build-time injection

**Out of scope (report anyway if severe, but no reward):**

- The absence of authentication/authorization. It is a known, documented limitation of the
  alpha (see *Known limitations*). Reports that only restate it are duplicates.
- Missing rate limits alone, or volumetric/brute-force DoS against the host.
- Scanner output without a working proof of concept.
- Self-XSS, clickjacking on the dashboard, missing `HttpOnly` on a cookie we do not set.
- Issues in Render, GitHub, or Cloudflare infrastructure rather than this code.
- Dependency version warnings without a reachable exploit path in this codebase.
- Prompt-injection payloads that require the *victim* to paste attacker content manually.

**Rules of engagement**

- Use a repository **you own** for indexing tests. Never point the server at a third party.
- Use the tenant `bounty-<your-handle>`; do not read, modify, or delete other tenants.
- No lateral movement, no persistence, no data exfiltration beyond the minimum PoC.
- Do not run automated load tests against the production deployment.
- Give us a reasonable window before publishing. We will not pursue legal action for
  research that follows these rules (safe harbour).

---

## Reward bands

Bounties are discretionary and sized against impact and exploitability. Indicative bands
for the alpha programme (awarded as cash or service credit):

| Severity | Examples | Band |
|---|---|---|
| Critical | RCE on the host, tenant-wide secret disclosure, auth bypass that grants another tenant's data | $300–500 |
| High | SSRF reaching cloud metadata or internal services past the allowlist, stored prompt injection that reliably triggers a tool call, redaction bypass leaking live credentials | $100–250 |
| Medium | Cross-tenant reads of non-secret graph data, cache poisoning, parser crash on crafted input | $50–100 |
| Low | Hardening gaps with clear but limited impact, information disclosure of paths or versions | Credit + swag |

A report that demonstrates a *bypass of an existing control* is worth more than one that
finds a control is absent.

---

## Known limitations (do not report as new)

These are real and tracked; fixing them is roadmap work, not a surprise finding.

1. **No authentication or per-tenant authorization.** `tenantId` is a slug chosen by the
   caller, not a credential. Any caller who knows or guesses a tenant id can read and mutate
   that tenant. Do not store anything sensitive in a public deployment.
2. **Approval records are not enforced.** `POST /rbac/v1/propose|approve` records intent for
   the dashboard; the MCP tools do not consult it. It is a visibility surface, not a gate.
3. **Indexed content is untrusted and unmarked.** Tool responses return repository text
   verbatim. An agent that pastes it can be influenced by instructions embedded in a repo.
4. **Free-tier storage is ephemeral.** Tenant SQLite files and the model cache do not survive
   a container restart on Render's free plan.
5. **DNS is resolved twice.** Validation resolves the host, then `git` resolves it again; a
   rebinding attacker can win the race. Mitigation requires a proxy or pinned IP, which the
   free tier does not offer.

---

## Security posture of this build

Implemented and tested in the current tree:

- `POST /index-repo` accepts **https only**, from an explicit host allowlist, with no embedded
  credentials and no shell metacharacters (including percent-encoded ones). The host is
  resolved and rejected if it maps to a private, loopback, link-local, CGNAT or reserved
  address. Policy lives in `packages/mcp/src/security/repo-url.ts` and has unit tests.
- The ingest worker calls `spawn('git', ['clone', ...])` with an argument array — no shell,
  no string interpolation. The GitHub token travels in a minimal child environment, never in
  the URL or argv, and is deleted after the clone starts.
- CORS is an explicit allowlist (no wildcard) with credentials disabled.
- Rate limits: 120 requests/min per client, 5 indexing jobs/min, 15 new sessions/min, and a
  hard cap of 200 concurrent MCP sessions.
- Responses are passed through a best-effort secret redactor (provider keys, JWTs, private
  keys, connection strings, credentials-in-URL, private-IP URLs). **Redaction is a
  convenience, not a boundary.**
- The container runs as a non-root user.

Still missing before this can host untrusted multi-tenant data: authentication, audit
logging, enforced approvals, per-tenant quotas and an egress-restricted indexing sandbox.
