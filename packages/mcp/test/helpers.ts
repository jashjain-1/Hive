import fs from 'fs';
import os from 'os';
import path from 'path';

export interface Fixture {
  root: string;
  cleanup: () => void;
}

export function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mcp-fixture-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'models'), { recursive: true });

  fs.writeFileSync(path.join(root, 'src', 'auth.ts'), [
    'export interface User { id: string; email: string }',
    '',
    'export function verifyJwt(token: string): boolean {',
    "  return token.split('.').length === 3;",
    '}',
    '',
    'export function loginUser(email: string): User {',
    "  const token = verifyJwt('a.b.c');",
    "  return { id: 'u1', email, token: String(token) };",
    '}',
    ''
  ].join('\n'));

  fs.writeFileSync(path.join(root, 'docs', 'auth.md'), [
    '# Authentication Architecture',
    '',
    'The login flow validates credentials and calls verifyJwt before creating a session.',
    '',
    '## Token Storage',
    '',
    'Sessions store user id and email in the database.',
    ''
  ].join('\n'));

  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture Repo\n\nA tiny repository used by Hivemind tests.\n');
  fs.writeFileSync(path.join(root, 'models', 'model.onnx'), 'fake-onnx-bytes');

  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}
