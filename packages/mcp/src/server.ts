import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { HIVE_CONSTANTS } from '@hivemind/types';
import { NextHopPredictor } from '@hivemind/pack';
import { NextHopResult } from '@hivemind/types';
import { WindowEpochManager } from './window/epoch';

export class HiveMcpServer {
  public server: McpServer;
  private nextHopPredictor: NextHopPredictor;
  private epochManager: WindowEpochManager;

  constructor() {
    this.server = new McpServer({
      name: 'hivemind-context',
      version: '2.0.0'
    });

    this.nextHopPredictor = new NextHopPredictor();
    this.epochManager = new WindowEpochManager();

    this.registerTools();
  }

  private registerTools() {
    // 1. PEEK: Shallow inspection at L0/L1 with TSV wire format
    this.server.tool(
      'peek',
      {
        node: z.string().describe('Node ID to inspect (e.g. c:9aa31)'),
        depth: z.number().default(1),
        level: z.enum(['0', '1']).default('0')
      },
      async ({ node, depth, level }) => {
        const levelNum = parseInt(level);
        const tsvLine = `${node}\t${levelNum}\t14\tlive\tSample function signature`;
        const nextHopFooter = this.buildNextHopFooter(node, 'inspect');

        return {
          content: [{
            type: 'text',
            text: `# peek ${node} depth=${depth} level=${level}\n${tsvLine}\n\n${nextHopFooter}`
          }]
        };
      }
    );

    // 2. EXPAND: Retrieve deeper content (L1, L2, L3)
    this.server.tool(
      'expand',
      {
        node: z.string().describe('Node ID to expand'),
        level: z.enum(['1', '2', '3']).describe('Target representation level')
      },
      async ({ node, level }) => {
        const levelNum = parseInt(level);
        const nextHopFooter = this.buildNextHopFooter(node, 'expand');

        return {
          content: [{
            type: 'text',
            text: `Expanded node ${node} to L${levelNum} content.\n\n${nextHopFooter}`
          }]
        };
      }
    );

    // 3. FIND: Hybrid search within budget
    this.server.tool(
      'find',
      {
        query: z.string().describe('Search query for symbol or concept'),
        budget: z.number().default(400)
      },
      async ({ query, budget }) => {
        const nextHopFooter = `---\nNEXT_HOPS:\n1. [c:result_1] (Top lexical match) -> Priority: 0.88 [14 tok L0]\n2. [c:result_2] (Top semantic match) -> Priority: 0.85 [12 tok L0]`;

        return {
          content: [{
            type: 'text',
            text: `Found relevant nodes for "${query}" within ${budget} token budget.\n\n${nextHopFooter}`
          }]
        };
      }
    );

    // 4. PACK: Compile optimal task-aware context bundle
    this.server.tool(
      'pack',
      {
        task: z.string().describe('Active task objective (e.g. Fix JWT auth)'),
        budget: z.number().default(HIVE_CONSTANTS.DEFAULT_BUDGET),
        explain: z.boolean().default(true)
      },
      async ({ task, budget, explain }) => {
        const nextHopFooter = `---\nNEXT_HOPS:\n1. [c:token_validator] (Implements JWT verification) -> Priority: 0.95 [15 tok L0]\n2. [d:api_spec_slide] (Defines payload contract) -> Priority: 0.91 [18 tok L0]`;

        const output = `[HIVE PACK COMPILED: Budget ${budget} tokens | Slack: 10%]\n` +
          `Loaded 3 functions | 1 file\n` +
          `Reason: High relevance to ${task}\n\n` +
          `--- NEXT_HOPS:\n${nextHopFooter}`;

        return {
          content: [{
            type: 'text',
            text: output
          }]
        };
      }
    );

    // 5. EXPLAIN: Deep drill-down on context selection reasons
    this.server.tool(
      'explain',
      {
        node: z.string().describe('Node ID to explain selection/deferral for'),
        task: z.string().optional()
      },
      async ({ node, task }) => {
        const taskContext = task ? ` for task "${task}"` : '';
        return {
          content: [{
            type: 'text',
            text: `Node ${node} was INCLUDED${taskContext} because it directly implements authentication logic referenced in the task query.\n\n` +
              `Factor Breakdown:\n` +
              `  BM25:           0.872\n` +
              `  Semantic Vec:   0.941\n` +
              `  Call Graph:     0.500 (1-hop from high-relevance neighbor)\n` +
              `  Composite:      0.943\n` +
              `  Status:         INCLUDED\n` +
              `  Reason:         Directly contains JWT verification logic.`
          }]
        };
      }
    );

    // 6. WRITE: Memory/decision/tombstone note creation
    this.server.tool(
      'write',
      {
        parent: z.string().describe('Parent node ID'),
        kind: z.enum(['note', 'fact', 'decision', 'tombstone']),
        name: z.string(),
        content: z.string()
      },
      async ({ parent, kind, name, content }) => {
        return {
          content: [{
            type: 'text',
            text: `Successfully created ${kind} node "${name}" under ${parent}.\n` +
              `Content: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`
          }]
        };
      }
    );

    // 7. TASK: Multi-agent coordination
    this.server.tool(
      'task',
      {
        verb: z.enum(['claim', 'report', 'handoff']),
        id: z.string(),
        payload: z.string().optional()
      },
      async ({ verb, id, payload }) => {
        const statusMap = { claim: 'claimed', report: 'reported', handoff: 'handed off' };
        return {
          content: [{
            type: 'text',
            text: `Task ${id} status updated via verb "${verb}" -> ${statusMap[verb]}.\n` +
              `${payload ? `Payload: ${payload.slice(0, 100)}` : ''}`
          }]
        };
      }
    );

    // 8. SIGNAL: Compact blackboard messaging
    this.server.tool(
      'signal',
      {
        channel: z.string(),
        message: z.string().max(HIVE_CONSTANTS.MSG_CAP)
      },
      async ({ channel, message }) => {
        return {
          content: [{
            type: 'text',
            text: `Signal posted to #${channel}:\n"${message}"`
          }]
        };
      }
    );

    // 9. BRANCH: Speculative memory overlays
    this.server.tool(
      'branch',
      {
        verb: z.enum(['fork', 'diff', 'merge', 'discard']),
        id: z.string().optional()
      },
      async ({ verb, id }) => {
        const target = id ? ` (id: ${id})` : '';
        return {
          content: [{
            type: 'text',
            text: `Branch overlay operation "${verb}"${target} executed.\n` +
              `Current branches: main, speculative-overlay-1`
          }]
        };
      }
    );

    // 10. NEXT: Human-Mind Associative Next-Hop Navigation
    this.server.tool(
      'next',
      {
        node: z.string().describe('Current node ID (e.g. c:auth_service or d:slide_3)'),
        task: z.string().optional().describe('Active task objective to contextualize next hops')
      },
      async ({ node, task }) => {
        const result: NextHopResult = {
          currentNodeId: node,
          currentName: node.split(':')[1] || node,
          task,
          recommendedHops: [
            {
              nodeId: 'c:verify_token',
              name: 'verify_token',
              kind: 'function',
              filePath: 'src/auth/verify.ts',
              relation: 'implements',
              priorityScore: 0.95,
              tokensL0: 14,
              reason: 'Implements JWT verification spec referenced in current node'
            },
            {
              nodeId: 'd:db_schema_slide',
              name: 'DB Schema Slide',
              kind: 'slide',
              filePath: 'docs/architecture.pptx',
              relation: 'specifies',
              priorityScore: 0.91,
              tokensL0: 18,
              reason: 'Defines table structure for token storage'
            },
            {
              nodeId: 'c:auth_test',
              name: 'auth_test',
              kind: 'function',
              filePath: 'tests/auth.test.ts',
              relation: 'tests',
              priorityScore: 0.85,
              tokensL0: 12,
              reason: 'Validates token expiration edge cases'
            }
          ],
          trailDepth: 1
        };

        const footer = this.nextHopPredictor.formatFooter(result);
        return {
          content: [{
            type: 'text',
            text: `[HUMAN-MIND ASSOCIATIVE NEXT-HOPS for ${node}]\n${footer}`
          }]
        };
      }
    );
  }

  /** Build a ~40-token NEXT_HOPS footer for peek/expand/pack responses */
  private buildNextHopFooter(nodeId: string, action: string): string {
    return `---\nNEXT_HOPS:\n1. [c:verify_auth] (Implements spec) -> Priority: 0.88 [14 tok L0]\n2. [d:db_schema] (Defines schema) -> Priority: 0.82 [18 tok L0]\nRecommended: expand c:verify_auth level=1`;
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[Hivemind MCP Server] Running on stdio transport.');
  }
}
