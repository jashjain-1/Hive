import Database from 'better-sqlite3';
import { NodeRecord } from '@hivemind/types';

export class CrossModalEntityLinker {
  constructor(private db: Database.Database) {}

  linkDocumentsToCode(): number {
    // 1. Fetch code symbol identifiers (classes, functions, interfaces, methods)
    const symbols = this.db.prepare(`
      SELECT id, name, kind FROM nodes
      WHERE tree = 'code' AND kind IN ('function', 'class', 'interface', 'method')
    `).all() as Array<{ id: string; name: string; kind: string }>;

    // 2. Fetch document nodes with content
    const docChunks = this.db.prepare(`
      SELECT id, name, l2, l0 FROM nodes
      WHERE tree = 'knowledge' AND l2 IS NOT NULL
    `).all() as Array<{ id: string; name: string; l2: string; l0: string }>;

    const insertLink = this.db.prepare(`
      INSERT OR IGNORE INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)
    `);

    let createdLinks = 0;
    const tx = this.db.transaction(() => {
      for (const doc of docChunks) {
        for (const sym of symbols) {
          if (sym.name.length > 3 &&
              (doc.l2.includes(sym.name) || doc.name.includes(sym.name))) {
            // Forward link: doc mentions code
            insertLink.run(doc.id, sym.id, 'mentions', 1.0);
            // Reverse link: code is documented by the doc
            insertLink.run(sym.id, doc.id, 'documents', 0.9);
            createdLinks += 2;
          }
        }
      }
    });

    tx();
    return createdLinks;
  }

  /** Build links from code: track calls/imports between nodes */
  linkCodeSymbols(): number {
    const codeNodes = this.db.prepare(`
      SELECT id, l2, name, kind FROM nodes
      WHERE tree = 'code' AND l2 IS NOT NULL AND kind IN ('function', 'class', 'method')
    `).all() as Array<{ id: string; l2: string; name: string; kind: string }>;

    const insertLink = this.db.prepare(`
      INSERT OR IGNORE INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)
    `);

    let createdLinks = 0;
    const tx = this.db.transaction(() => {
      for (const src of codeNodes) {
        for (const dst of codeNodes) {
          if (src.id === dst.id) continue;
          // Detect 'calls' relation: src function body references dst name
          if (src.l2.includes(dst.name) && dst.kind === 'function') {
            insertLink.run(src.id, dst.id, 'calls', 1.0);
            createdLinks++;
          }
          // Detect 'implements' relation: class mentions interface name
          if (src.kind === 'class' && dst.kind === 'interface' && src.l2.includes(dst.name)) {
            insertLink.run(src.id, dst.id, 'implements', 1.0);
            createdLinks++;
          }
        }
      }
    });

    tx();
    return createdLinks;
  }
}
