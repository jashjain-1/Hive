import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { HiveContextService } from '../src/context-service';
import { createFixture, Fixture } from './helpers';

describe('HiveContextService integration', () => {
  let fixture: Fixture;
  let service: HiveContextService;

  beforeAll(async () => {
    fixture = createFixture();
    service = new HiveContextService({
      repoRoot: fixture.root,
      dbPath: path.join(fixture.root, '.hive', 'test.db'),
      tenantId: 'test',
      embeddings: 'off'
    });
    await service.index('.');
  }, 30_000);

  afterAll(() => {
    service.close();
    fixture.cleanup();
  });

  it('indexes code, markdown, binary stubs, and graph links', () => {
    const status = service.getStatus() as {
      nodes: number;
      nodesByTree: Record<string, number>;
      indexedFiles: number;
      links: number;
    };

    expect(status.indexedFiles).toBeGreaterThanOrEqual(4);
    expect(status.nodes).toBeGreaterThanOrEqual(8);
    expect(status.nodesByTree.code).toBeGreaterThan(0);
    expect(status.nodesByTree.knowledge).toBeGreaterThan(0);
    expect(status.links).toBeGreaterThan(0);
  });

  it('finds normalized camelCase symbols that FTS5 would otherwise miss', () => {
    const hits = service.search('Fix JWT verification', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].node.name).toBe('verifyJwt');
    expect(service.find('Fix JWT verification', 300)).toContain('verifyJwt');
  });

  it('compiles a pack within the 10% slack budget and returns real content', async () => {
    const result = await service.pack('Fix JWT verification', 500, true);
    expect(result.pack.usedTokens).toBeLessThanOrEqual(450);
    expect(result.pack.items.length).toBeGreaterThan(0);
    expect(result.pack.items.every(item => item.reason.length > 0)).toBe(true);
    expect(result.text).toContain('HIVE_PACK');
    expect(result.text).toContain('verifyJwt');
    expect(result.text).toContain('token.split');
  });

  it('explains the latest pack decision for an included node', async () => {
    const result = await service.pack('Fix JWT verification', 500, true);
    const verifyNode = result.pack.items.find(item => item.name === 'verifyJwt');
    expect(verifyNode).toBeDefined();

    const explanation = service.explain(verifyNode!.nodeId);
    expect(explanation).toContain('INCLUDED');
    expect(explanation).toContain('Scores:');
  });

  it('honors force-include pins on unrelated tasks', async () => {
    service.pin('**/auth.ts', 'include');
    const result = await service.pack('totally unrelated release checklist', 500, false);
    expect(result.pack.items.some(item => item.filePath === 'src/auth.ts')).toBe(true);
    service.pin('**/auth.ts', 'clear');
  });

  it('returns next hops and expands real code content', () => {
    const hit = service.search('verifyJwt', 1)[0];
    expect(hit).toBeDefined();

    expect(service.next(hit.node.id)).toContain('NEXT_HOPS');
    expect(service.expand(hit.node.id, 2)).toContain('token.split');
    expect(service.peek(hit.node.id, 1, 0)).toContain(hit.node.id);
  });

  it('writes a decision node and exposes it through peek', () => {
    const message = service.write('root', 'decision', 'Use HMAC verification', 'Verify JWT signatures with the shared HMAC secret.');
    expect(message).toContain('Created decision node');

    const idMatch = message.match(/node (m:[a-z0-9:]+)/);
    expect(idMatch).not.toBeNull();
    expect(service.peek(idMatch![1], 0, 0)).toContain('Use HMAC verification');
  });

  it('posts and reads coordination signals', () => {
    const output = service.signal('backend', 'Auth refactor is ready for review.');
    expect(output).toContain('Auth refactor is ready for review.');
  });
});
