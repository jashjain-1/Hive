# Security Policy

Hivemind is an MCP server that clones repositories, parses untrusted content, and returns that content to AI agents. This document describes the security model of the current build, the controls that are implemented, and the boundaries operators must enforce.

---

## Reporting a vulnerability

Do not open a public issue for a security report.

Use GitHub private vulnerability reporting on this repository: **Security > Report a vulnerability**. If private reporting is unavailable, contact the maintainer listed in `package.json`.

Include:

- the affected endpoint or tool, for example `POST /index-repo`, `pack`, or `git clone`;
- a minimal reproduction as a request, response, or script;
- the impact, such as tenant escape, remote code execution, secret disclosure, or SSRF;
- preconditions, including tenant ID, authentication mode, and hosting assumptions.

### Response targets

| Stage | Target |
|---|---|
| Acknowledgement | 3 business days |
| Triage and severity decision | 10 business days |
| Critical or high fix | 30 days |
| Medium or low fix | 90 days |
| Public credit | After the fix ships, at the reporter's option |

If a valid report cannot be fixed within the window, the maintainers will say so and coordinate disclosure rather than leave the reporter waiting.

No paid bug bounty programme is offered at this time.

---

## Scope

In scope:

- MCP transports: `POST /mcp`, `GET /sse`, `POST /messages`.
- Tool dispatch and response handling in `packages/mcp`.
- `POST /index-repo` and the `index` tool, including URL validation and Git invocation.
- Indexing, chunking, and link generation in `packages/core`.
- Response redaction in `packages/core/src/security/secrets-redactor.ts`.
- Graph and status surfaces: `/graph`, `/graph.json`, `/graph/node`, `/graph/context-pack`, `/graph-overview`, `/chat-start`, `/index-status`.
- The Docker image and `render.yaml`.

Out of scope:

- Scanner output without a working proof of concept.
- Missing rate limits alone, or volumetric denial of service against the host.
- Issues in Render, GitHub, or the network provider rather than this code.
- Dependency version warnings without a reachable exploit path.
- Reports that only restate a limitation documented below.

### Rules of engagement

- Index only repositories you own or are authorised to test.
- Use the tenant `security-<handle>` and do not read, modify, or delete other tenants.
- Do not run automated load tests against a production deployment.
- Allow a reasonable remediation window before publication.
- Good-faith research that follows these rules will not be pursued legally.

---

## Authentication and authorization

When `HIVE_API_KEY` is set, protected endpoints require a bearer token. The comparison uses `crypto.timingSafeEqual` after a length check.

Accepted forms:

```http
Authorization: Bearer <HIVE_API_KEY>
```

or, when `HIVE_ALLOW_QUERY_KEY=true`:

```text
/mcp?tenantId=project&apiKey=<HIVE_API_KEY>
```

The query form exists for connector platforms that cannot send fixed headers. It places the key in access logs and proxy history. Prefer the header form whenever the client supports it.

If `HIVE_API_KEY` is empty, the deployment is open. Do not expose an open deployment to the public internet.

**Authorization boundary.** The API key authenticates a caller to the entire deployment. A tenant ID selects a namespace; it is not a per-user or per-tenant credential. Any authenticated caller can choose any tenant ID. Use one deployment per trust boundary when tenants must be isolated from each other.

---

## Threat model

| Threat | Current mitigation | Residual risk |
|---|---|---|
| Unauthenticated access | Optional bearer key with timing-safe comparison | Open mode is possible by configuration |
| Cross-tenant reads | Separate SQLite database and workspace per tenant | Shared API key means any authenticated caller can select another tenant |
| Malicious repository URL | HTTPS only, host allowlist, no embedded credentials, character filtering | DNS is not pinned; the private-IP helpers are not wired into the clone path |
| Shell injection during clone | `execFile` with an argument array, no shell | Git itself remains a parser of remote data |
| Credential leakage in responses | Pattern-based redaction before transmission | Redaction is best effort, not a security boundary |
| Secret leakage from Git tokens | Token passed through the child environment, never persisted | Host and process inspection remain operator responsibilities |
| Prompt injection from indexed content | Content is returned as tool output | Agents can still follow instructions embedded in repository text |
| Request flooding | Per-IP rate limit, default 120 requests per minute | Distributed abuse, long indexing jobs, and storage exhaustion are not fully mitigated |
| Container compromise | Non-root runtime user | Host and orchestrator hardening are deployment responsibilities |

---

## Implemented controls

### Transport and gateway

- Helmet security headers on all HTTP responses.
- CORS origin configurable through `HIVE_CORS_ORIGIN`, defaulting to `*` for connector compatibility.
- Per-IP rate limiting through `express-rate-limit`, default 120 requests per minute.
- Request body limit of 10 MB.
- JSON parse and oversized-body errors return generic client errors.
- `/health` and `/graph` are public; `/graph` is a static shell with no tenant data.
- `/graph.json`, `/graph/node`, `/graph/context-pack`, `/graph-overview`, `/chat-start`, `/index-status`, `/index-repo`, `/mcp`, and `/sse` require the key when configured.

### Repository ingestion

- Only `https://` URLs are accepted.
- Hosts must match `HIVE_ALLOWED_HOSTS`, defaulting to `github.com`, `gitlab.com`, and `bitbucket.org`.
- URLs with embedded usernames or passwords are rejected.
- Shell metacharacters, including percent-encoded variants, are rejected.
- Non-default ports are rejected.
- `git clone --depth 1 --single-branch` runs through `execFile` with an argument array.
- The clone timeout is controlled by `HIVE_GIT_TIMEOUT_MS`.
- `X-GitHub-Token` is read for a single request and passed through Git's environment, not the URL or command line.

`packages/mcp/src/security/repo-url.ts` exports `isPrivateIpv4` and `isPrivateIpv6` for DNS validation. The current caller performs scheme, host, credential, port, and character validation, but does not resolve DNS or pin an IP before cloning. Treat the host allowlist as the primary SSRF boundary.

### Storage isolation

Each tenant receives:

```text
.hive/
  tenants/<tenant>.db
  workspaces/<tenant>/
  repos/<hash>/
  overviews/<tenant>/
```

Tenant IDs are sanitized to letters, digits, underscores, and hyphens, truncated to 64 characters. Cross-tenant joins are not exposed through the API. SQLite runs in WAL mode.

### Response redaction

Every tool response and every graph excerpt passes through `SecretsRedactor.redact()` before leaving the process. Patterns cover:

- AWS access keys;
- GitHub tokens;
- OpenAI, Anthropic, and Google API keys;
- JSON Web Tokens;
- database connection URLs;
- private keys;
- credentials embedded in URLs.

Redaction reduces accidental disclosure. It cannot prove that a payload is free of secrets, so do not index repositories that contain live credentials.

### Container

- Multi-stage build on `node:20-alpine`.
- Runtime runs as the unprivileged `node` user.
- The data directory and model cache are created and owned before privileges are dropped.
- `git` is installed in the runtime image because hosted indexing requires it.
- The server listens on `PORT`, default 3000.

---

## Deployment checklist

Before exposing a deployment:

1. Set `HIVE_API_KEY` to a long random value.
2. Terminate TLS at the platform or proxy.
3. Keep `HIVE_ALLOW_QUERY_KEY=false` unless a connector requires the URL form.
4. Restrict `HIVE_CORS_ORIGIN` when only known browser origins need access.
5. Keep `HIVE_ALLOWED_HOSTS` to the Git hosts you actually use.
6. Mount persistent storage and set `HIVE_DATA_ROOT` if tenant state must survive restarts.
7. Run one instance per SQLite data directory.
8. Set `HIVE_MAX_FILES`, `HIVE_MAX_FILE_BYTES`, and `HIVE_MAX_TENANTS` to values your plan can support.
9. Put the service behind a reverse proxy that enforces request size and connection limits if it is publicly reachable.
10. Monitor disk usage, process memory, and response times. No audit log is emitted by the application.

---

## Known limitations

These are real properties of the current build. Reports that only restate them are duplicates.

1. **The API key is deployment-wide.** Tenant IDs are not authorization. Use separate deployments for separate trust boundaries.
2. **Open mode exists.** Leaving `HIVE_API_KEY` empty disables authentication.
3. **Query keys leak.** `HIVE_ALLOW_QUERY_KEY=true` exposes the key in access logs.
4. **No OAuth authorization server.** Claude and ChatGPT connections rely on the header or URL-key modes.
5. **Indexed content is untrusted.** Prompt injection through repository text, documents, and symbol names is possible. Tool output must be treated as data.
6. **DNS is not pinned.** The clone path validates the URL and host allowlist but does not resolve and verify the destination IP.
7. **No audit logging.** Application logs cover startup, transport errors, and HTTP failures, not per-tool access records.
8. **No per-tenant quotas.** Rate limiting is per IP, and indexing consumes shared CPU, memory, and disk.
9. **Free-tier storage is ephemeral.** Render's free plan loses SQLite databases and clones on restart.
10. **Redaction is pattern-based.** Novel secret formats and transformed credentials can pass through.
11. **Indexing is synchronous.** A large clone occupies the request until indexing completes; client and platform timeouts apply.
12. **Pins live in the indexed workspace.** Re-indexing a Git URL recreates the workspace and clears stored pins.

---

## Supported versions

Security fixes target the current `main` branch and the Docker image built from it. Older forks and modified deployments are supported on a best-effort basis.
