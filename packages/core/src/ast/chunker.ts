import Parser from 'web-tree-sitter';
import path from 'path';
import crypto from 'crypto';
import { NodeRecord, NodeKind } from '@hivemind/types';

export class AstChunker {
  private parser!: Parser;
  private tsLang!: Parser.Language;
  private pyLang!: Parser.Language;
  private initialized = false;

  async init(wasmDir: string) {
    if (this.initialized) return;
    await Parser.init({
      locateFile: (file: string) => path.join(wasmDir, file)
    });
    this.parser = new Parser();
    this.tsLang = await Parser.Language.load(path.join(wasmDir, 'tree-sitter-typescript.wasm'));
    this.pyLang = await Parser.Language.load(path.join(wasmDir, 'tree-sitter-python.wasm'));
    this.initialized = true;
  }

  parseSource(filePath: string, sourceCode: string): NodeRecord[] {
    if (!this.initialized) throw new Error('AstChunker not initialized. Call init() first.');

    const ext = path.extname(filePath);
    const isPython = ext === '.py';
    this.parser.setLanguage(isPython ? this.pyLang : this.tsLang);

    const tree = this.parser.parse(sourceCode);
    const lines = sourceCode.split('\n');
    const nodes: NodeRecord[] = [];

    // Root File Node
    const fileHash = crypto.createHash('sha256').update(sourceCode).digest('hex');
    const fileId = `c:${crypto.randomBytes(3).toString('hex')}`;
    const fileNode: NodeRecord = {
      id: fileId,
      tree: 'code',
      parent: null,
      kind: 'file',
      name: path.basename(filePath),
      filePath,
      startLine: 1,
      endLine: lines.length,
      status: 'live',
      ver: 1,
      hash: fileHash,
      l0: `${path.basename(filePath)} (${lines.length} lines)`,
      l2: sourceCode.length < 3000 ? sourceCode : undefined,
      tokL0: Math.ceil(path.basename(filePath).length / 3),
      tokL1: 0,
      tokL2: Math.ceil(sourceCode.length / 4),
      stale: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    nodes.push(fileNode);

    // Recursive AST Walker
    const extractChunks = () => {
      const type = cursor.nodeType;
      let kind: NodeKind | null = null;
      let name = 'anonymous';

      if (['function_declaration', 'method_definition', 'arrow_function', 'function_definition'].includes(type)) {
        kind = type === 'method_definition' ? 'method' : 'function';
        const nameNode = cursor.currentNode.childForFieldName('name');
        if (nameNode) name = nameNode.text;
      } else if (['class_declaration', 'class_definition'].includes(type)) {
        kind = 'class';
        const nameNode = cursor.currentNode.childForFieldName('name');
        if (nameNode) name = nameNode.text;
      } else if (type === 'interface_declaration') {
        kind = 'interface';
        const nameNode = cursor.currentNode.childForFieldName('name');
        if (nameNode) name = nameNode.text;
      }

      if (kind) {
        const startLine = cursor.currentNode.startPosition.row + 1;
        const endLine = cursor.currentNode.endPosition.row + 1;
        const chunkText = lines.slice(startLine - 1, endLine).join('\n');
        const chunkHash = crypto.createHash('sha256').update(`${kind}\n${chunkText}`).digest('hex');

        nodes.push({
          id: `c:${crypto.randomBytes(3).toString('hex')}`,
          tree: 'code',
          parent: fileId,
          kind,
          name,
          filePath,
          startLine,
          endLine,
          status: 'live',
          ver: 1,
          hash: chunkHash,
          l0: `${kind} ${name}() [lines ${startLine}-${endLine}]`,
          l2: chunkText,
          tokL0: Math.ceil((name.length + 15) / 3),
          tokL1: 0,
          tokL2: Math.ceil(chunkText.length / 4),
          stale: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }

      if (cursor.gotoFirstChild()) {
        do {
          extractChunks();
        } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };

    const cursor = tree.walk();
    extractChunks();

    // Memory Hygiene: Clean up AST memory immediately
    tree.delete();
    return nodes;
  }
}
