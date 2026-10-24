/**
 * Tool catalog — the single source of truth for what the 12 MCP tools do.
 *
 * Used for three things:
 *   1. the server `instructions` string, which is how an MCP client tells its model
 *      when to reach for each tool;
 *   2. `GET /tools.json`, consumed by the dashboard's tool list;
 *   3. onboarding text for humans who want to call the tools by hand.
 *
 * Keep `when` short and imperative. A model reads this once; it should read like a
 * decision rule, not a manual.
 */

export interface ToolDoc {
  name: string;
  group: 'read' | 'context' | 'navigate' | 'mutate';
  summary: string;
  when: string;
  args: string;
  example: string;
  returns: string;
}

export const TOOL_CATALOG: ToolDoc[] = [
  {
    name: 'peek',
    group: 'read',
    summary: 'One node at L0 (or L1) plus its highest-weight outgoing hops.',
    when: 'You already have a node id from find/pack and need a cheap look before expanding.',
    args: 'node (id), depth (default 1), level ("0" | "1")',
    example: '{ "node": "c:9aa31", "level": "0" }',
    returns: 'TSV line + NEXT_HOPS with priorities and token counts.',
  },
  {
    name: 'expand',
    group: 'read',
    summary: 'Fetch a node at L1, L2, or L3 (L3 is a pointer to external blob storage).',
    when: 'You need the body of a symbol or document you have already identified.',
    args: 'node (id), level ("1" | "2" | "3")',
    example: '{ "node": "c:9aa31", "level": "2" }',
    returns: 'Node content at the requested level, plus next hops.',
  },
  {
    name: 'find',
    group: 'read',
    summary: 'Lexical (BM25) search over names and summaries.',
    when: 'You have a symbol name or a keyword and no node id yet.',
    args: 'query (string), budget (default 400 tokens)',
    example: '{ "query": "verifyToken jwt", "budget": 400 }',
    returns: 'Ranked node ids with one-line summaries.',
  },
  {
    name: 'pack',
    group: 'context',
    summary: 'Compile a task-aware context bundle inside a token budget.',
    when: 'Starting a task. This is the default first call when you know the objective.',
    args: 'task (string), budget (default 4000), explain (default true)',
    example: '{ "task": "fix expired JWT handling", "budget": 4000 }',
    returns: 'Selected nodes at chosen levels with per-node reasons, and deferrals.',
  },
  {
    name: 'explain',
    group: 'context',
    summary: 'Why a node was included or deferred, with its score components.',
    when: 'A pack result looks wrong, or you need to justify an inclusion.',
    args: 'node (id), task (optional)',
    example: '{ "node": "c:9aa31", "task": "fix jwt auth" }',
    returns: 'BM25, graph bonus, composite, and connected node ids.',
  },
  {
    name: 'impact',
    group: 'navigate',
    summary: 'Blast radius for the working-tree diff, or for a specific path.',
    when: 'Before editing, or when reviewing a change. Call it with no args for the current diff.',
    args: 'target (optional file or symbol path)',
    example: '{ "target": "src/auth/jwt.ts" }',
    returns: 'Changed files, affected nodes, downstream callers with depth.',
  },
  {
    name: 'next',
    group: 'navigate',
    summary: 'Associative next hops for a node, biased by the active task.',
    when: 'You finished reading one node and need to know where a human would look next.',
    args: 'node (id), task (optional)',
    example: '{ "node": "c:9aa31", "task": "add refresh tokens" }',
    returns: 'Top three ranked hops with relation and priority.',
  },
  {
    name: 'pin',
    group: 'mutate',
    summary: 'Force a path, glob, or symbol into (or out of) every pack.',
    when: 'A file must always be in context, or is noise that keeps getting selected.',
    args: 'target (path | glob | symbol), action ("include" | "exclude" | "clear")',
    example: '{ "target": "docs/adr/*.md", "action": "exclude" }',
    returns: 'Updated include/exclude lists.',
  },
  {
    name: 'write',
    group: 'mutate',
    summary: 'Create a memory node (note, fact, decision, tombstone) under a parent.',
    when: 'You learned something worth keeping across sessions, or a decision needs recording.',
    args: 'parent (id), kind ("note" | "fact" | "decision" | "tombstone"), name, content',
    example: '{ "parent": "m:root01", "kind": "decision", "name": "JWT rotation", "content": "Rotate on refresh." }',
    returns: 'New node id and tenant confirmation.',
  },
  {
    name: 'task',
    group: 'mutate',
    summary: 'Claim, report, or hand off a task on the shared board.',
    when: 'Multiple agents work the same repo and must not collide.',
    args: 'verb ("claim" | "report" | "handoff"), id, payload (optional)',
    example: '{ "verb": "claim", "id": "T-14", "payload": "auth refactor" }',
    returns: 'Current status for that task id.',
  },
  {
    name: 'signal',
    group: 'mutate',
    summary: 'Post a short message to a channel blackboard.',
    when: 'Coordination that does not belong in the graph: "migrating schema at 14:00".',
    args: 'channel (string), message (max 280 chars)',
    example: '{ "channel": "deploy", "message": "freezing migrations until 15:00" }',
    returns: 'The message plus the last three on that channel.',
  },
  {
    name: 'branch',
    group: 'mutate',
    summary: 'Fork, diff, merge, or discard a graph overlay.',
    when: 'Exploring an alternative without polluting the main graph.',
    args: 'verb ("fork" | "diff" | "merge" | "discard"), id (optional)',
    example: '{ "verb": "fork" }',
    returns: 'Branch id and the list of tracked branches.',
  },
];

/** Compact instructions block handed to the MCP client at initialize time. */
export function buildServerInstructions(): string {
  const lines = TOOL_CATALOG.map(
    (t) => `- ${t.name}(${t.args}) — ${t.summary} Use when: ${t.when}`
  );
  return [
    'Hivemind serves a token-budgeted context graph for this repository.',
    '',
    'Workflow: call pack with the task first. Use find when you only have a name, peek to',
    'cheaply inspect an id, expand only when you need the body. Call impact before editing.',
    'pin persists a preference; write records a durable note; task and signal coordinate.',
    '',
    'Rules: do not paste whole files that pack already selected; prefer expand level 2 over',
    'level 3; if a node is missing, say so instead of guessing an id.',
    '',
    'Tools:',
    ...lines,
  ].join('\n');
}
