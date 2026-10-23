import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
initializeDatabase,
ftsSearch,
insertNode,
casUpdateNode
} from './db';

let db: Database.Database;

beforeEach(() => {
db = initializeDatabase(':memory:');
});

afterEach(() => {
db.close();
});

describe('Database Core', () => {
it('creates the required database tables', () => {
const tables = db
.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
.all() as { name: string }[];

const names = tables.map((table) => table.name);

expect(names).toContain('nodes');
expect(names).toContain('closure');
expect(names).toContain('links');
expect(names).toContain('nodes_fts');

});

it('enables foreign key constraints', () => {
const result = db.pragma('foreign_keys') as { foreign_keys: number }[];

expect(result[0].foreign_keys).toBe(1);

});

it('returns an empty array when FTS finds no matches', () => {
expect(ftsSearch(db, 'nonexistent')).toEqual([]);
});

it('inserts a new node with version 1', () => {
const now = Date.now();

const node = insertNode(db, {
  id: 'c:test-node',
  tree: 'code',
  parent: null,
  kind: 'function',
  name: 'testFunction',
  status: 'live',
  hash: 'hash-123',
  l0: 'Test function',
  tokL0: 3,
  tokL1: 0,
  tokL2: 0,
  stale: false,
  createdAt: now,
  updatedAt: now
});

expect(node.id).toBe('c:test-node');
expect(node.ver).toBe(1);

const stored = db
  .prepare('SELECT id, ver FROM nodes WHERE id = ?')
  .get('c:test-node') as { id: string; ver: number };

expect(stored.ver).toBe(1);

});

it('updates a node when the expected version matches', () => {
const now = Date.now();

insertNode(db, {
  id: 'c:cas-node',
  tree: 'code',
  parent: null,
  kind: 'function',
  name: 'casFunction',
  status: 'live',
  hash: 'hash-before',
  l0: 'Original summary',
  tokL0: 2,
  tokL1: 0,
  tokL2: 0,
  stale: false,
  createdAt: now,
  updatedAt: now
});

expect(
  casUpdateNode(db, 'c:cas-node', 1, {
    l1: 'Updated summary'
  })
).toBe(true);

const stored = db
  .prepare('SELECT l1, ver FROM nodes WHERE id = ?')
  .get('c:cas-node') as { l1: string | null; ver: number };

expect(stored.l1).toBe('Updated summary');
expect(stored.ver).toBe(2);

});

it('rejects an update when the expected version is incorrect', () => {
const now = Date.now();

insertNode(db, {
  id: 'c:stale-cas-node',
  tree: 'code',
  parent: null,
  kind: 'function',
  name: 'staleCasFunction',
  status: 'live',
  hash: 'hash-before',
  l0: 'Original summary',
  tokL0: 2,
  tokL1: 0,
  tokL2: 0,
  stale: false,
  createdAt: now,
  updatedAt: now
});

expect(
  casUpdateNode(db, 'c:stale-cas-node', 99, {
    l1: 'This should not be saved'
  })
).toBe(false);

const stored = db
  .prepare('SELECT l1, ver FROM nodes WHERE id = ?')
  .get('c:stale-cas-node') as { l1: string | null; ver: number };

expect(stored.l1).toBeNull();
expect(stored.ver).toBe(1);

});

it('rejects duplicate node IDs without modifying the original node', () => {
const now = Date.now();

const node = {
  id: 'c:duplicate-test',
  tree: 'code' as const,
  parent: null,
  kind: 'function' as const,
  name: 'originalFunction',
  status: 'live' as const,
  hash: 'original-hash',
  l0: 'Original summary',
  tokL0: 2,
  tokL1: 0,
  tokL2: 0,
  stale: false,
  createdAt: now,
  updatedAt: now
};

insertNode(db, node);

expect(() =>
  insertNode(db, {
    ...node,
    name: 'modifiedFunction',
    hash: 'modified-hash'
  })
).toThrow();

const stored = db
  .prepare('SELECT name, hash FROM nodes WHERE id = ?')
  .get('c:duplicate-test') as { name: string; hash: string };

expect(stored.name).toBe('originalFunction');
expect(stored.hash).toBe('original-hash');

});

it('rejects a second update using an outdated version', () => {
const now = Date.now();

insertNode(db, {
  id: 'c:cas-version-test',
  tree: 'code',
  parent: null,
  kind: 'function',
  name: 'versionTest',
  status: 'live',
  hash: 'hash-v1',
  l0: 'Original summary',
  tokL0: 2,
  tokL1: 0,
  tokL2: 0,
  stale: false,
  createdAt: now,
  updatedAt: now
});

expect(
  casUpdateNode(db, 'c:cas-version-test', 1, {
    l1: 'First update'
  })
).toBe(true);

// The successful update increments the version from 1 to 2.
expect(
  casUpdateNode(db, 'c:cas-version-test', 1, {
    l1: 'Outdated update'
  })
).toBe(false);

const stored = db
  .prepare('SELECT l1, ver FROM nodes WHERE id = ?')
  .get('c:cas-version-test') as { l1: string | null; ver: number };

expect(stored.l1).toBe('First update');
expect(stored.ver).toBe(2);

});
});
