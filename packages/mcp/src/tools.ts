import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SecretsRedactor } from '@hivemind/core';
import { HIVE_CONSTANTS } from '@hivemind/types';
import { HiveContextService } from './context-service';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text: SecretsRedactor.redact(text) }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: SecretsRedactor.redact(`Error: ${message}`) }],
    isError: true
  };
}

async function run(operation: () => Promise<string> | string): Promise<ToolResult> {
  try {
    return ok(await operation());
  } catch (error) {
    return fail(error);
  }
}

export function registerHiveTools(server: McpServer, service: HiveContextService): void {
  server.tool(
    'index',
    'Index a local repository path or a public https Git repository URL into the Hivemind graph. Run this before find, pack, or next.',
    {
      target: z.string().describe('Absolute/relative local path, or an https:// Git repository URL')
    },
    async ({ target }) => run(async () => {
      const summary = await service.index(target);
      return [
        `Indexed ${summary.repoRoot}`,
        `Files: ${summary.filesIndexed} indexed, ${summary.filesSkipped} skipped`,
        `Nodes: ${summary.nodesInserted} | Links: ${summary.linksCreated} | Time: ${summary.durationMs} ms`,
        summary.errors.length > 0
          ? `Warnings (${summary.errors.length}):\n${summary.errors.slice(0, 10).map(error => `- ${error}`).join('\n')}`
          : 'No indexing warnings.'
      ].join('\n');
    })
  );

  server.tool(
    'status',
    'Show the active repository, database, node/link counts, embedding mode, and last indexing result.',
    {},
    async () => run(() => JSON.stringify(service.getStatus(), null, 2))
  );

  server.tool(
    'peek',
    'Inspect a node and its descendants at L0/L1 using a token-lean TSV layout.',
    {
      node: z.string().describe('Node id, exact name, or path fragment'),
      depth: z.number().min(0).max(3).default(1),
      level: z.enum(['0', '1']).default('0')
    },
    async ({ node, depth, level }) => run(() => service.peek(node, depth, Number(level) as 0 | 1))
  );

  server.tool(
    'expand',
    'Retrieve a node at L1 summary, L2 authored content, or L3 (falls back to L2 when no blob exists).',
    {
      node: z.string().describe('Node id, exact name, or path fragment'),
      level: z.enum(['1', '2', '3']).describe('Representation level to load')
    },
    async ({ node, level }) => run(() => service.expand(node, Number(level) as 1 | 2 | 3))
  );

  server.tool(
    'find',
    'Lexical (FTS5 + camelCase-normalized) search over indexed symbols and files within a token budget.',
    {
      query: z.string().describe('Symbol, file name, or concept to search for'),
      budget: z.number().min(50).max(HIVE_CONSTANTS.RESP_CAP).default(400)
    },
    async ({ query, budget }) => run(() => service.find(query, budget))
  );

  server.tool(
    'pack',
    'Compile the optimal task-aware context bundle within a token budget, with 10% slack and proof details.',
    {
      task: z.string().describe('Active task objective, e.g. "Fix JWT expiry validation"'),
      budget: z.number().min(100).max(8000).default(HIVE_CONSTANTS.DEFAULT_BUDGET),
      explain: z.boolean().default(true)
    },
    async ({ task, budget, explain }) => run(async () => {
      const result = await service.pack(task, budget, explain);
      return result.text;
    })
  );

  server.tool(
    'explain',
    'Explain why a node was included or deferred by the latest pack, including factor scores.',
    {
      node: z.string().describe('Node id or name'),
      task: z.string().optional().describe('Optional task context to echo in the explanation')
    },
    async ({ node, task }) => run(() => service.explain(node, task))
  );

  server.tool(
    'next',
    'Recommend the top associative next hops and cognitive trails from a node.',
    {
      node: z.string().describe('Current node id or name'),
      task: z.string().optional().describe('Active task objective')
    },
    async ({ node, task }) => run(() => service.next(node, task))
  );

  server.tool(
    'impact',
    'Map changed files to AST nodes and compute the downstream call/import blast radius.',
    {
      target: z.string().optional().describe('Optional file or symbol to analyze instead of the current git diff')
    },
    async ({ target }) => run(() => service.impact(target))
  );

  server.tool(
    'pin',
    'Persist a force-include, force-exclude, or cleared override for a path, glob, or symbol.',
    {
      target: z.string().describe('File path, glob pattern, or symbol name'),
      action: z.enum(['include', 'exclude', 'clear']).describe('Pin action')
    },
    async ({ target, action }) => run(() => service.pin(target, action))
  );

  server.tool(
    'write',
    'Create a note, fact, decision, or tombstone in the persistent memory tree.',
    {
      parent: z.string().describe('Parent node id, or "root" for a tree root'),
      kind: z.enum(['note', 'fact', 'decision', 'tombstone']),
      name: z.string().min(1),
      content: z.string().min(1)
    },
    async ({ parent, kind, name, content }) => run(() => service.write(parent, kind, name, content))
  );

  server.tool(
    'task',
    'Claim, report, or hand off a coordination task id.',
    {
      verb: z.enum(['claim', 'report', 'handoff']),
      id: z.string().min(1),
      payload: z.string().optional()
    },
    async ({ verb, id, payload }) => run(() => service.coordinateTask(verb, id, payload))
  );

  server.tool(
    'signal',
    'Post a compact message to a shared coordination channel.',
    {
      channel: z.string().min(1),
      message: z.string().min(1).max(HIVE_CONSTANTS.MSG_CAP * 4)
    },
    async ({ channel, message }) => run(() => service.signal(channel, message))
  );

  server.tool(
    'branch',
    'Fork, diff, merge, or discard a lightweight memory overlay branch.',
    {
      verb: z.enum(['fork', 'diff', 'merge', 'discard']),
      id: z.string().optional()
    },
    async ({ verb, id }) => run(() => service.branch(verb, id))
  );
}
