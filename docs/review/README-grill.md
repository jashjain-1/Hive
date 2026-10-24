# Hivemind Implementation Review — Q&A Grill

> Purpose: pressure-test the current implementation against the interaction-surface gaps you identified
> (plug-and-play across AI interfaces, no-download use, skills, and user interaction). Answer the questions
> below in your own words; your answers drive the todo updates and doc updates that follow.

---

## Section 1 — Transport and client reach

**Q1.** Today Hivemind exposes a legacy SSE endpoint at `/sse`. Which specific AI interfaces you care about
should be able to connect to that URL today without the user installing a local binary, and which should not?
Be concrete — name the interfaces and whether they need stdio, SSE, or Streamable HTTP.

**Q2.** If you wanted a single hosted URL to work in the broadest set of modern clients, would you add
Streamable HTTP support, replace SSE with Streamable HTTP, or keep both? What do you think breaks if you
switch too aggressively?

**Q3.** Is the user allowed to connect to Hivemind over plain HTTP in your intended deployment, or should the
hosted endpoint eventually require HTTPS-only and, if so, who terminates TLS — Render, a proxy, or the server?

---

## Section 2 — No-download / plug-and-play use

**Q4.** When you say "plug and play, no download," who exactly is the user? A developer pasting a URL into an
IDE? A non-technical person opening a browser? A team member in a managed chat app? Pick the primary persona.

**Q5.** For that primary persona, what is the smallest possible first-run flow? List the steps from "I have
never seen Hivemind" to "I just used it," ideally in 3 steps or fewer.

**Q6.** Which part of the current first-run experience do you think is the biggest friction point: finding the
endpoint URL, configuring the client, knowing whether it connected, or knowing what to ask it next?

---

## Section 3 — UI and interaction

**Q7.** Do you want the user interaction to live (a) inside whatever AI chat client they already use,
(b) in a separate hosted web dashboard, or (c) both? If both, which actions belong in which surface?

**Q8.** Which Hivemind actions do you think a non-technical user should be able to trigger directly through a
UI, without an agent intermediary? Examples: search a repo, preview a context pack, view blast radius, start
an indexing job, approve a write/branch/pin.

**Q9.** Should the UI let the user see and approve risky tool calls (`write`, `branch`, `pin`) before they
happen, or is it acceptable for the agent to call them on the user's behalf after the user trusts the system?

---

## Section 4 — Skills and portability

**Q10.** Do you want Hivemind to be consumed primarily as an MCP server, as a portable agent skill package
(such as an Agent Skills `SKILL.md` artifact), or as both? If both, what should the skill package do that the
MCP server alone does not?

**Q11.** If you published a portable skill for Hivemind, where should a user discover and enable it today:
a skills registry, a client marketplace, a repo you clone, or something else?

**Q12.** Should the skill describe how to call the remote Hivemind endpoint, or should it also contain fallback
behavior when no remote server is available?

---

## Section 5 — Scope and priorities

**Q13.** If you could only complete three of the gaps we discussed — Streamable HTTP, interactive UI hooks,
hosted dashboard skeleton, portable skill asset, or visibility/approval endpoints — which three would you pick
and in what order?

**Q14.** For the hosted free tier, are you comfortable with ephemeral tenant storage and an on-demand model
warm-up, or do you want the implementation to assume a persistent disk/external store before it is considered
complete?

**Q15.** Is there any client, platform, or persona you absolutely do not want Hivemind to target right now?
List it so we can explicitly exclude it from scope.

---

*Answers are captured in `docs/review/answers-2026-10-23.md`.*

---

## Answers

- **Q1**: SSE reaches Claude Desktop, Cursor, Windsurf, Antigravity when pointed at the hosted URL; stdio-only clients are out of scope for the no-download claim.
- **Q2**: add Streamable HTTP alongside SSE and keep both; do not replace SSE yet.
- **Q3**: hosted endpoint should be HTTPS-only with TLS terminated by the platform (Render); localhost HTTP OK for dev.
- **Q4**: primary persona is a developer already in an AI coding client; browser-only persona is secondary.
- **Q5**: 3 steps — open the dashboard/endpoint and see it's live, point the existing client at the hosted endpoint or enable the skill, then ask Hivemind something.
- **Q6**: biggest friction is knowing whether it connected and knowing what to ask next.
- **Q7**: both — in-client for day-to-day tool use, hosted dashboard for status/approval.
- **Q8**: view connection/health, view indexing status, search/preview, preview/review a context pack, view blast radius, start indexing where appropriate.
- **Q9**: risky mutations should be visible and approvable by default for `write`, `branch`, `pin`.
- **Q10**: both MCP server and portable skill; the skill describes the remote endpoint and includes a fallback note.
- **Q11**: repo-based portable skill + enable instructions today; registry/marketplace later.
- **Q12**: the skill should describe the remote endpoint and include a short fallback note; it should not pretend there is a full local fallback.
- **Q13**: Streamable HTTP, then visibility/approval endpoints, then hosted dashboard, then portable skill, then interactive UI hooks.
- **Q14**: comfortable with ephemeral if it is documented and the upgrade path is clear.
- **Q15**: explicit exclusions — no universal client promise, no managed brokered connector/marketplace today, and not targeting a completely non-technical user with zero client access as the primary story.

---


---

## Grill outcome summary

After the user answered, the following implementation calls were made:

- Keep SSE and add Streamable HTTP as a second hosted transport (`/mcp`).
- Add a lightweight hosted dashboard at `/` with health, indexing, proposal, and approval affordances.
- Add visibility/approval endpoints: `/index-status`, `/rbac/v1/propose`, `/rbac/v1/approve`, `/rbac/v1/pending`,
  `/rbac/v1/records`.
- Document the free-tier persistence caveat and the durable-storage upgrade path in the README.
- Document the portable-skill and discovery path in the README.
- Update the E2E simulation and the implementation tracker to reflect the new scope decisions.

The remaining open items are interactive-UI hooks on the highest-value tools and the concrete portable skill
artifact itself.
