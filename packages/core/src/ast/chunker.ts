import Parser from 'web-tree-sitter';
import path from 'path';
import crypto from 'crypto';
import { NodeRecord, NodeKind } from '@hivemind/types';

const ParserRuntime = (
  (Parser as any)?.default?.default ??
  (Parser as any)?.default ??
  Parser
) as typeof Parser;

export class AstChunker {
  private parser!: Parser;
  private tsLang!: Parser.Language;
  private tsxLang!: Parser.Language;
  private jsLang!: Parser.Language;
  private pyLang!: Parser.Language;
  private initialized = false;

async init(
wasmDir: string = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'node_modules',
  '@opensumi',
  'tree-sitter-wasm'
)
): Promise<void> {
if (this.initialized) return;

    await ParserRuntime.init({
      locateFile: (file: string) => path.join(wasmDir, file)
    });

    this.parser = new ParserRuntime();

    this.tsLang = await ParserRuntime.Language.load(
      path.join(wasmDir, 'tree-sitter-typescript.wasm')
    );

    this.tsxLang = await ParserRuntime.Language.load(
      path.join(wasmDir, 'tree-sitter-tsx.wasm')
    );

    this.jsLang = await ParserRuntime.Language.load(
      path.join(wasmDir, 'tree-sitter-javascript.wasm')
    );

    this.pyLang = await ParserRuntime.Language.load(
      path.join(wasmDir, 'tree-sitter-python.wasm')
    );

    this.initialized = true;

}

/**

* Generate a deterministic ID from a node's logical identity.
* Content hashes are deliberately separate so edits don't automatically
* change the node ID.
  */
  private createStableId(identity: string): string {
  const digest = crypto
  .createHash('sha256')
  .update(identity)
  .digest('hex')
  .slice(0, 24);

return `c:${digest}`;

}

parseSource(filePath: string, sourceCode: string): NodeRecord[] {
if (!this.initialized) {
throw new Error('AstChunker not initialized. Call init() first.');
}

const normalizedPath = path.normalize(filePath);
const ext = path.extname(normalizedPath).toLowerCase();

if (ext === '.py') {
  this.parser.setLanguage(this.pyLang);
} else if (
  ['.js', '.jsx', '.mjs', '.cjs'].includes(ext)
) {
  this.parser.setLanguage(this.jsLang);
} else if (ext === '.tsx') {
  this.parser.setLanguage(this.tsxLang);
} else if (
  ['.ts', '.mts', '.cts'].includes(ext)
) {
  this.parser.setLanguage(this.tsLang);
} else {
  throw new Error(
    `Unsupported source file extension: ${ext || '(none)'}`
  );
}

const tree = this.parser.parse(sourceCode);

if (!tree) {
  throw new Error(`Tree-sitter could not parse ${normalizedPath}`);
}

try {
  const lines = sourceCode.split('\n');
  const nodes: NodeRecord[] = [];
  const now = Date.now();

  const fileName = path.basename(normalizedPath);
  const fileId = this.createStableId(
    `file\n${normalizedPath}`
  );

  const fileHash = crypto
    .createHash('sha256')
    .update(sourceCode)
    .digest('hex');

  const fileNode: NodeRecord = {
    id: fileId,
    tree: 'code',
    parent: null,
    kind: 'file',
    name: fileName,
    filePath: normalizedPath,
    startLine: 1,
    endLine: lines.length,
    status: 'live',
    ver: 1,
    hash: fileHash,
    l0: `${fileName} (${lines.length} lines)`,
    l2: sourceCode.length < 3000 ? sourceCode : undefined,
    tokL0: Math.ceil(fileName.length / 3),
    tokL1: 0,
    tokL2: Math.ceil(sourceCode.length / 4),
    stale: false,
    createdAt: now,
    updatedAt: now
  };

  nodes.push(fileNode);

  // Tracks repeated names within the same file and parent scope.
  const occurrenceCounts = new Map<string, number>();

  const cursor = tree.walk();

  const extractChunks = (): void => {
    const currentNode = cursor.currentNode;
    const type = cursor.nodeType;

    let kind: NodeKind | null = null;
    let name = 'anonymous';

    if (
      [
        'function_declaration',
        'method_definition',
        'arrow_function',
        'function_definition'
      ].includes(type)
    ) {
      kind = type === 'method_definition' ? 'method' : 'function';

      const nameNode = currentNode.childForFieldName('name');

      if (nameNode) {
        name = nameNode.text;
      }
    } else if (
      ['class_declaration', 'class_definition'].includes(type)
    ) {
      kind = 'class';

      const nameNode = currentNode.childForFieldName('name');

      if (nameNode) {
        name = nameNode.text;
      }
    } else if (type === 'interface_declaration') {
      kind = 'interface';

      const nameNode = currentNode.childForFieldName('name');

      if (nameNode) {
        name = nameNode.text;
      }
    }

    if (kind) {
      const startLine = currentNode.startPosition.row + 1;
      const endLine = currentNode.endPosition.row + 1;

      const chunkText = lines
        .slice(startLine - 1, endLine)
        .join('\n');

      const scopeKey = `${kind}\n${name}`;
      const occurrence = occurrenceCounts.get(scopeKey) ?? 0;

      occurrenceCounts.set(scopeKey, occurrence + 1);

      /*
       * IDs use file path, node kind, name, and occurrence number.
       * They don't depend on the source content or line numbers.
       */
      const nodeId = this.createStableId(
        `symbol\n${normalizedPath}\n${kind}\n${name}\n${occurrence}`
      );

      const chunkHash = crypto
        .createHash('sha256')
        .update(`${kind}\n${chunkText}`)
        .digest('hex');

      nodes.push({
        id: nodeId,
        tree: 'code',
        parent: fileId,
        kind,
        name,
        filePath: normalizedPath,
        startLine,
        endLine,
        status: 'live',
        ver: 1,
        hash: chunkHash,
        l0: `${kind} ${name} [lines ${startLine}-${endLine}]`,
        l2: chunkText,
        tokL0: Math.ceil((name.length + 15) / 3),
        tokL1: 0,
        tokL2: Math.ceil(chunkText.length / 4),
        stale: false,
        createdAt: now,
        updatedAt: now
      });
    }

    if (cursor.gotoFirstChild()) {
      do {
        extractChunks();
      } while (cursor.gotoNextSibling());

      cursor.gotoParent();
    }
  };

  extractChunks();

  return nodes;
} finally {
  tree.delete();
}
}
}
