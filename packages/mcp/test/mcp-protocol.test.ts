import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HiveMcpServer } from '../src/server';
import { createFixture, Fixture } from './helpers';

describe('Hivemind MCP protocol', () => {
  let fixture: Fixture;
  let hive: HiveMcpServer;
  let client: Client;

  beforeAll(async () => {
    fixture = createFixture();
    hive = new HiveMcpServer({
      repoRoot: fixture.root,
      dbPath: path.join(fixture.root, '.hive', 'mcp.db'),
      tenantId: 'protocol-test',
      embeddings: 'off'
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'hivemind-test-client', version: '1.0.0' });

    await Promise.all([
      hive.server.connect(serverTransport),
      client.connect(clientTransport)
    ]);
  }, 30_000);

  afterAll(async () => {
    await client.close();
    hive.close();
    fixture.cleanup();
  });

  it('exposes the full real tool catalog', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name).sort();
    expect(names).toEqual([
      'branch', 'expand', 'explain', 'find', 'impact', 'index',
      'next', 'pack', 'peek', 'pin', 'signal', 'status', 'task', 'write'
    ]);
  });

  it('indexes a repo through the index tool and answers find/pack/status', async () => {
    const index = await client.callTool({ name: 'index', arguments: { target: '.' } });
    expect(index.isError).not.toBe(true);
    expect(index.content[0].text).toContain('Indexed');

    const find = await client.callTool({ name: 'find', arguments: { query: 'verifyJwt', budget: 200 } });
    expect(find.isError).not.toBe(true);
    expect(find.content[0].text).toContain('verifyJwt');

    const pack = await client.callTool({ name: 'pack', arguments: { task: 'Fix JWT verification', budget: 500 } });
    expect(pack.isError).not.toBe(true);
    expect(pack.content[0].text).toContain('HIVE_PACK');
    expect(pack.content[0].text).toContain('verifyJwt');

    const status = await client.callTool({ name: 'status', arguments: {} });
    const parsed = JSON.parse(status.content[0].text) as { nodes: number; indexedFiles: number };
    expect(parsed.nodes).toBeGreaterThan(0);
    expect(parsed.indexedFiles).toBeGreaterThan(0);
  });

  it('returns a typed error instead of crashing for a missing node', async () => {
    const result = await client.callTool({ name: 'peek', arguments: { node: 'does-not-exist' } });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Node not found');
  });
});
