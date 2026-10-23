import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { GraphJsonExport, NodeKind } from '@hivemind/types';

export function exportGraphToJson(db: Database.Database, outputPath: string): void {
  const nodes = db.prepare(`
    SELECT id, tree, parent, kind, name, filePath, startLine, endLine, hash, l0, l1, tokL0, tokL1
    FROM nodes WHERE status != 'superseded'
  `).all() as Array<{
    id: string; tree: string; parent: string | null; kind: string; name: string;
    filePath: string | null; startLine: number | null; endLine: number | null;
    hash: string; l0: string; l1: string | null; tokL0: number; tokL1: number;
  }>;

  const links = db.prepare('SELECT src, dst, rel, w FROM links').all() as Array<{ src: string; dst: string; rel: string; w: number }>;

  const fileKinds = ['file', 'document', 'presentation', 'workbook'];
  const chunkKinds = ['function', 'class', 'interface', 'method', 'note', 'fact', 'decision', 'slide', 'page', 'section', 'sheet', 'table', 'summary', 'task', 'tool', 'concept', 'tombstone'];

  const exportData: GraphJsonExport = {
    version: '2.0',
    exportedAt: Date.now(),
    stats: {
      totalNodes: nodes.length,
      totalFiles: nodes.filter(n => fileKinds.includes(n.kind)).length,
      totalChunks: nodes.filter(n => chunkKinds.includes(n.kind)).length,
      totalLinks: links.length
    },
    nodes: nodes.map(n => ({
      id: n.id,
      tree: n.tree as any,
      parent: n.parent,
      kind: n.kind as NodeKind,
      name: n.name,
      filePath: n.filePath ?? undefined,
      startLine: n.startLine ?? undefined,
      endLine: n.endLine ?? undefined,
      hash: n.hash,
      l0: n.l0,
      l1: n.l1 ?? undefined,
      tokL0: n.tokL0,
      tokL1: n.tokL1
    })),
    links: links.map(l => ({
      src: l.src,
      dst: l.dst,
      rel: l.rel as any,
      w: l.w
    }))
  };

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2), 'utf8');
}

export function importGraphFromJson(db: Database.Database, inputPath: string): { importedNodes: number; importedLinks: number } {
  const raw = fs.readFileSync(inputPath, 'utf8');
  const data: GraphJsonExport = JSON.parse(raw);

  if (data.version !== '2.0') {
    throw new Error(`Unsupported graph version: ${data.version}. Expected 2.0.`);
  }

  const insertNode = db.prepare(`
    INSERT OR REPLACE INTO nodes (id, tree, parent, kind, name, filePath, startLine, endLine, status, ver, hash, l0, tokL0, tokL1, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', 1, ?, ?, ?, ?, ?, ?)
  `);

  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)
  `);

  const now = Date.now();
  let importedNodes = 0;
  let importedLinks = 0;

  const tx = db.transaction(() => {
    for (const n of data.nodes) {
      const result = insertNode.run(
        n.id, n.tree, n.parent, n.kind, n.name,
        n.filePath ?? null,
        n.startLine ?? null,
        n.endLine ?? null,
        n.hash,
        n.l0,
        n.tokL0,
        n.tokL1 ?? 0,
        now,
        now
      );
      if (result.changes > 0) importedNodes++;
    }
    for (const l of data.links) {
      insertLink.run(l.src, l.dst, l.rel, l.w);
      importedLinks++;
    }
  });

  tx();
  return { importedNodes, importedLinks };
}
