# Hivemind — User Interaction, UI, and Skills Surface

> Neutral analysis of how a user reaches Hivemind today and how that could expand.
> To be reconciled with the user's answers to `docs/review/README-grill.md`.

---

## 1. Current interaction model

Today, a user reaches Hivemind through an MCP client that has been pointed at either:

- a **local stdio** process launched from `packages/mcp/dist/index.js`, or
- a **hosted SSE** endpoint, for example `https://<app>.onrender.com/sse?tenantId=default`, or
- a **hosted Streamable HTTP** endpoint, for example `https://<app>.onrender.com/mcp?tenantId=default`.

Once connected, the user interacts almost entirely through the agent: the user says what they want, and the
agent calls `peek`, `expand`, `find`, `pack`, `explain`, `impact`, `next`, `write`, `task`, `signal`, `branch`,
or `pin`. The user mostly sees results in chat.

There is now a lightweight hosted dashboard and a small visibility/approval surface, but those are affordances
for the browser-only persona rather than a full hosted app. The primary day-to-day interaction is still through
the connected AI client.

---

## 2. Plausible interaction surfaces

### A. In-chat, through a compatible AI client

This is the primary day-to-day surface for the developer persona. The user already has the client, and the only
config step is pointing that client at the hosted endpoint or enabling the Hivemind skill where supported.

For this surface to reach a broad set of clients, the hosted endpoint should speak the transport the target
clients actually support. That is why the current increment adds Streamable HTTP alongside SSE instead of
replacing SSE.

This surface can later be enriched with **interactive UI components returned by tools**, if the target client
supports that extension. That would let Hivemind show a repo/context browser, a context-pack review card, a
blast-radius view, or an indexing progress panel inside the conversation.

### B. A hosted web dashboard served from the same backend

This is the most universally accessible surface: open a URL in any browser. It is the secondary persona surface
and is well suited to:

- connection and health state,
- tenant/indexing status and job progress,
- search and preview,
- context-pack inspection,
- graph and next-hop visualization,
- governance for risky actions such as write/branch/pin.

The current dashboard includes forms to start indexing, propose risky actions, record approvals, and review
pending proposals. It is intentionally a visibility-and-record surface, not a hardened authz engine.

### C. A managed connector or hosted broker

This is the deepest "no-download" path and remains out of scope for this increment. It is a future product/infra
step rather than a single codebase change.

---

## 3. Skills and portability layer

There are at least two related but different ideas here:

1. **Hivemind as an MCP server.** The current implementation. A client configured to use the endpoint can call
   the 12 tools over SSE or Streamable HTTP.

2. **Hivemind as a portable skill package.** A `SKILL.md`-style artifact that tells a skills-aware agent what
   Hivemind is, when to use it, and how to call it. This is closer to "a skill that travels to the client" than
   "configure a server."

These are complementary rather than interchangeable. A portable skill can describe how to call a remote Hivemind
endpoint, and should include a short fallback note for when no remote server is available. It should not imply a
full local MCP experience exists when it does not.

For discovery and enablement, the realistic options today are uneven:

- skills registries and CLI-based installers exist for some ecosystems;
- client-specific marketplaces lower friction inside those clients;
- a repo-based skill is portable but requires the user to place files manually.

The current pragmatic path is a repo-based portable skill plus clear enable instructions. Marketplace/registry
is the nicer future path but is not assumed to exist for every client today.

---

## 4. What "plug and play, no download" likely means in practice

It probably should mean different things for different personas:

- **Developer in an IDE:** minimal config, ideally "paste endpoint / enable connection," then use it through
  the agent in the IDE.
- **Non-technical user in a browser:** open a hosted URL, search or trigger an action, read results, possibly
  approve actions.
- **Team/org user in a managed chat app:** an admin-enabled integration that teammates can use through chat with
  some visibility and approval controls.

A single surface is unlikely to satisfy all three. For this increment, the primary persona is the developer
already in an AI coding client, with the browser-only persona as the secondary visibility surface.

---

## 5. Current scope decisions

- **Transport**: add Streamable HTTP alongside SSE; keep SSE for now; do not rip it out yet.
- **TLS**: platform-terminated HTTPS for the hosted path; localhost HTTP is OK for local testing.
- **Primary persona**: a developer already in an AI coding client, with a secondary browser-only persona for the
  hosted dashboard.
- **First run**: 3 steps or fewer — open the dashboard/endpoint, see health, point the existing client at the
  hosted endpoint or enable the skill.
- **Biggest friction**: knowing whether it connected and what to ask next.
- **Interaction surface**: both — in-client for day-to-day tool use, hosted dashboard for status/approval.
- **Direct UI actions**: search/index status, start indexing, preview/review a context pack, view blast radius,
  see connection/health.
- **Risky mutations**: visible and approvable by default for `write`, `branch`, `pin`.
- **Consumption model**: both MCP server and portable skill; the skill should describe the remote endpoint and
  include a short fallback note when no remote server is available.
- **Discovery**: repo-based portable skill plus enable instructions today; registry/marketplace later.
- **Free tier**: comfortable with ephemeral, as long as it is documented and the upgrade path is clear.

## 5b. Current scope exclusions

- No promise of universal client support. If a client only works via stdio or has no usable remote-MCP path, it
  is out of scope for the "no-download" claim.
- No managed brokered connector/marketplace today. That is a future product/infra step.
- The completely non-technical user with zero client access is secondary, not primary.

---

## 6. Open scope questions

- Whether to add MCP Apps-style interactive UI hooks on the highest-value tools.
- Whether to publish a concrete portable skill artifact and where it should live.
- Which client surfaces to target first for interactive hooks.

These are tracked so the implementation and docs can be updated consistently after the next grill round.
