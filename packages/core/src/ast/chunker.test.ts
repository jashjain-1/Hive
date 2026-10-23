import { describe, it, expect, beforeAll } from 'vitest';
import { AstChunker } from './chunker';

describe('AstChunker', () => {
let chunker: AstChunker;

beforeAll(async () => {
chunker = new AstChunker();
await chunker.init();
});

it('parses Python functions', () => {
const nodes = chunker.parseSource(
'hello.py',
'def greet():\n    print("Hello")'
);

expect(nodes.some(n => n.kind === 'file')).toBe(true);
expect(
  nodes.some(n => n.kind === 'function' && n.name === 'greet')
).toBe(true);

});

it('parses JavaScript functions', () => {
const nodes = chunker.parseSource(
'hello.js',
'function greet() { return 1; }'
);

expect(
  nodes.some(n => n.kind === 'function' && n.name === 'greet')
).toBe(true);

});

it('parses TypeScript functions', () => {
const nodes = chunker.parseSource(
'hello.ts',
'function greet(name: string): string { return name; }'
);

expect(
  nodes.some(n => n.kind === 'function' && n.name === 'greet')
).toBe(true);

});

it('parses TSX functions', () => {
const nodes = chunker.parseSource(
'hello.tsx',
'function App() { return <div>Hello</div>; }'
);

expect(
  nodes.some(n => n.kind === 'function' && n.name === 'App')
).toBe(true);

});

it('generates stable IDs for unchanged source', () => {
const source = 'function greet() { return 1; }';

const first = chunker.parseSource('stable.js', source);
const second = chunker.parseSource('stable.js', source);

expect(first.map(n => n.id)).toEqual(second.map(n => n.id));

});

it('generates different IDs for different file paths', () => {
const source = 'function greet() { return 1; }';

const first = chunker.parseSource('first.js', source);
const second = chunker.parseSource('second.js', source);

expect(first[0].id).not.toBe(second[0].id);

});

it('rejects unsupported file extensions', () => {
expect(() => chunker.parseSource('hello.txt', 'hello')).toThrow(
'Unsupported source file extension'
);
});
});
