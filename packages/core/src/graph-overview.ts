import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { NodeKind, LinkRelation } from '@hivemind/types';

const REL_LABELS: Record<string, string> = {
  calls: 'calls',
  implements: 'implements',
  tests: 'tests',
  mentions: 'mentions',
  specifies: 'specifies',
  documents: 'documents',
  imports: 'imports',
  depends_on: 'depends on',
  next_step: 'navigates to',
  supersedes: 'supersedes',
  contradicts: 'contradicts',
  blocks: 'blocks',
};

const KIND_ICONS: Record<string, string> = {
  file: '📄',
  function: '⚡',
  class: '🏛',
  interface: '📐',
  method: '🔹',
  note: '📝',
  fact: '💡',
  decision: '⚖',
  tombstone: '🗑',
  summary: '📋',
  task: '🎯',
  tool: '🔧',
  concept: '🧠',
  document: '📕',
  presentation: '📊',
  workbook: '📈',
  slide: '🪟',
  page: '📄',
  section: '📑',
  sheet: '📋',
  table: '📊',
};

interface OverviewOptions {
  tenantId: string;
  db: Database.Database;
  outputDir: string;
  task?: string;
}

export function generateGraphOverview(opts: OverviewOptions): string {
  const { db, outputDir, task } = opts;

  // Gather stats
  const totalNodes = (db.prepare(`SELECT COUNT(*) as c FROM nodes WHERE status != 'superseded'`).get() as any).c;
  const totalLinks = (db.prepare(`SELECT COUNT(*) as c FROM links`).get() as any).c;
  const liveNodes = (db.prepare(`SELECT COUNT(*) as c FROM nodes WHERE status = 'live'`).get() as any).c;
  const byKind = db.prepare(
    `SELECT kind, COUNT(*) as c FROM nodes WHERE status != 'superseded' GROUP BY kind ORDER BY c DESC`
  ).all() as Array<{ kind: string; c: number }>;
  const byTree = db.prepare(
    `SELECT tree, COUNT(*) as c FROM nodes WHERE status != 'superseded' GROUP BY tree ORDER BY c DESC`
  ).all() as Array<{ tree: string; c: number }>;

  const topFiles = db.prepare(
    `SELECT filePath, COUNT(*) as c FROM nodes WHERE filePath IS NOT NULL AND status != 'superseded' GROUP BY filePath ORDER BY c DESC LIMIT 10`
  ).all() as Array<{ filePath: string; c: number }>;

  // Top nodes by connectivity (most links)
  const topNodes = db.prepare(
    `SELECT n.id, n.name, n.kind, n.tree, n.filePath, n.l0, n.tokL0,
            (SELECT COUNT(*) FROM links l WHERE l.src = n.id OR l.dst = n.id) as connectivity
     FROM nodes n WHERE n.status != 'superseded'
     ORDER BY connectivity DESC LIMIT 15`
  ).all() as Array<{
    id: string; name: string; kind: string; tree: string; filePath: string | null;
    l0: string; tokL0: number; connectivity: number;
  }>;

  // Recent links for the visual graph section
  const recentLinks = db.prepare(
    `SELECT l.src, l.dst, l.rel, l.w, s.name as srcName, s.kind as srcKind, d.name as dstName, d.kind as dstKind
     FROM links l
     JOIN nodes s ON l.src = s.id
     JOIN nodes d ON l.dst = d.id
     WHERE s.status != 'superseded' AND d.status != 'superseded'
     ORDER BY l.w DESC LIMIT 30`
  ).all() as Array<{
    src: string; dst: string; rel: string; w: number;
    srcName: string; srcKind: string; dstName: string; dstKind: string;
  }>;

  const timestamp = new Date().toISOString();
  const taskSection = task ? `\n**Active Task:** ${task}\n` : '';

  const lines: string[] = [];

  // Header
  lines.push(`# 🐝 Hivemind Context Graph — Session Overview`);
  lines.push(``);
  lines.push(`> Auto-generated snapshot: ${timestamp}`);
  lines.push(`> Tenant: ${opts.tenantId}`);
  lines.push(`> This document is regenerated after every indexing run and significant notebook write.`);
  lines.push(`> AI agents: present this at the start of every chat session. It updates automatically.`);
  lines.push(`${taskSection}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // Stats card
  lines.push(`## 📊 Graph Statistics`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Nodes | ${totalNodes} |`);
  lines.push(`| Live Nodes | ${liveNodes} |`);
  lines.push(`| Total Links | ${totalLinks} |`);
  lines.push(`| Code Files | ${byTree.find(t => t.tree === 'code')?.c ?? 0} |`);
  lines.push(`| Knowledge Docs | ${byTree.find(t => t.tree === 'knowledge')?.c ?? 0} |`);
  lines.push(`| Memory Notes | ${byTree.find(t => t.tree === 'memory')?.c ?? 0} |`);
  lines.push(`| Decision Log | ${byTree.find(t => t.tree === 'decision')?.c ?? 0} |`);
  lines.push(`| Avg Links / Node | ${(totalLinks / Math.max(1, liveNodes)).toFixed(2)} |`);
  lines.push(``);

  // Kind breakdown
  lines.push(`## 📦 Nodes by Kind`);
  lines.push(``);
  lines.push(`| Kind | Count | Icon |`);
  lines.push(`|------|-------|------|`);
  for (const row of byKind) {
    lines.push(`| \`${row.kind}\` | ${row.c} | ${KIND_ICONS[row.kind] ?? '⬜'} |`);
  }
  lines.push(``);

  // Top files
  if (topFiles.length > 0) {
    lines.push(`## 📁 Top Files by Chunk Count`);
    lines.push(``);
    for (const f of topFiles) {
      lines.push(`- **${f.filePath}** — ${f.c} chunks`);
    }
    lines.push(``);
  }

  // Top connected nodes
  lines.push(`## 🔗 Most Connected Symbols (Blast Radius Hubs)`);
  lines.push(``);
  lines.push(`These are the symbols an agent is most likely to need. Start here.`);
  lines.push(``);
  lines.push(`| # | Node | Kind | File | Connectivity | Gist (L0) |`);
  lines.push(`|---|------|------|------|-------------|-----------|`);
  for (let i = 0; i < topNodes.length; i++) {
    const n = topNodes[i];
    const fileShort = n.filePath ? path.basename(n.filePath) : '—';
    lines.push(`| ${i + 1} | \`${n.id}\` | ${n.kind} | ${fileShort} | ${n.connectivity} links | ${n.l0.slice(0, 50)} |`);
  }
  lines.push(``);

  // Visual graph (Mermaid)
  lines.push(`## 🕸 Associative Graph (Mermaid)`);
  lines.push(``);
  lines.push(`> Top 30 weighted links. Direction: source → target (relation).`);
  lines.push(``);
  // Build mermaid block as a single string block to avoid backtick parsing issues
  const mermaidLines: string[] = [];
  mermaidLines.push('```mermaid');
  mermaidLines.push('graph LR');
  mermaidLines.push('  subgraph Code["🔷 Code Tree"]');
  const codeNodes = topNodes.filter(n => n.tree === 'code').slice(0, 10);
  for (const n of codeNodes) {
    const icon = KIND_ICONS[n.kind] ?? '⬜';
    mermaidLines.push(`    ${n.id}["${icon} ${n.name}"]:::code`);
  }
  mermaidLines.push('  end');
  mermaidLines.push(``);
  mermaidLines.push('  subgraph Knowledge["📚 Knowledge Tree"]');
  const knowledgeNodes = topNodes.filter(n => n.tree === 'knowledge').slice(0, 8);
  for (const n of knowledgeNodes) {
    const icon = KIND_ICONS[n.kind] ?? '⬜';
    mermaidLines.push(`    ${n.id}["${icon} ${n.name}"]:::knowledge`);
  }
  mermaidLines.push('  end');
  mermaidLines.push(``);
  mermaidLines.push('  subgraph Memory["💾 Memory Tree"]');
  const memoryNodes = topNodes.filter(n => n.tree === 'memory').slice(0, 5);
  for (const n of memoryNodes) {
    mermaidLines.push(`    ${n.id}["📝 ${n.name}"]:::memory`);
  }
  mermaidLines.push('  end');
  mermaidLines.push(``);

  // Render top links in mermaid
  const renderedLinks = new Set<string>();
  for (const link of recentLinks) {
    const key = `${link.src}--${link.dst}`;
    if (renderedLinks.has(key)) continue;
    renderedLinks.add(key);
    const rel = REL_LABELS[link.rel] ?? link.rel;
    lines.push(`  ${link.src} -->|${rel}| ${link.dst}`);
  }
  // Extract link rendering from mermaidLines to avoid duplication — rebuild properly
  mermaidLines.length = 0;
  mermaidLines.push('```mermaid');
  mermaidLines.push('graph LR');
  mermaidLines.push('  subgraph Code["🔷 Code Tree"]');
  for (const n of codeNodes) {
    const icon = KIND_ICONS[n.kind] ?? '⬜';
    mermaidLines.push(`    ${n.id}["${icon} ${n.name}"]:::code`);
  }
  mermaidLines.push('  end');
  mermaidLines.push(``);
  mermaidLines.push('  subgraph Knowledge["📚 Knowledge Tree"]');
  for (const n of knowledgeNodes) {
    const icon = KIND_ICONS[n.kind] ?? '⬜';
    mermaidLines.push(`    ${n.id}["${icon} ${n.name}"]:::knowledge`);
  }
  mermaidLines.push('  end');
  mermaidLines.push(``);
  mermaidLines.push('  subgraph Memory["💾 Memory Tree"]');
  for (const n of memoryNodes) {
    mermaidLines.push(`    ${n.id}["📝 ${n.name}"]:::memory`);
  }
  mermaidLines.push('  end');
  mermaidLines.push(``);
  for (const link of recentLinks) {
    const key = `${link.src}--${link.dst}`;
    if (renderedLinks.has(key)) continue;
    renderedLinks.add(key);
    const rel = REL_LABELS[link.rel] ?? link.rel;
    mermaidLines.push(`  ${link.src} -->|${rel}| ${link.dst}`);
  }
  mermaidLines.push(``);
  mermaidLines.push('  classDef code fill:#e3f2fd,stroke:#1565c0,stroke-width:1px;');
  mermaidLines.push('  classDef knowledge fill:#f3e5f5,stroke:#7b1fa2,stroke-width:1px;');
  mermaidLines.push('  classDef memory fill:#e8f5e9,stroke:#2e7d32,stroke-width:1px;');
  mermaidLines.push('  classDef impl stroke:#2e7d32,stroke-width:2px;');
  mermaidLines.push('  classDef spec stroke:#ef6c00,stroke-width:2px;');
  mermaidLines.push('  classDef call stroke:#1565c0,stroke-width:2px,stroke-dasharray: 5 5;');
  mermaidLines.push('```');
  for (const ml of mermaidLines) lines.push(ml);
  lines.push(``);

  // NEXT_HOPS for the agent
  lines.push(`## 🧭 Agent Navigation Hints`);
  lines.push(``);
  lines.push(`When an agent is asked to work on a task, these are the most likely starting points:`);
  lines.push(``);
  for (let i = 0; i < Math.min(5, topNodes.length); i++) {
    const n = topNodes[i];
    lines.push(`1. **${n.id}** (${n.name}, ${n.kind}) — ${n.l0.slice(0, 80)}`);
    if (n.filePath) lines.push(`   - File: ${n.filePath}`);
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`_Generated by Hivemind Context Engine v2.0.0_`);
  lines.push(``);

  const outputPath = path.join(outputDir, 'GRAPH_OVERVIEW.md');
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  return outputPath;
}


/**
 * Generate a compact "chat-start card" — a short text summary an agent can
 * paste at the top of a conversation. Designed to be < 300 tokens.
 */
export function generateChatStartCard(opts: OverviewOptions): string {
  const { db, task } = opts;

  const totalNodes = (db.prepare(`SELECT COUNT(*) as c FROM nodes WHERE status != 'superseded'`).get() as any).c;
  const totalLinks = (db.prepare(`SELECT COUNT(*) as c FROM links`).get() as any).c;

  const topNodes = db.prepare(
    `SELECT n.id, n.name, n.kind, n.l0, n.filePath,
            (SELECT COUNT(*) FROM links l WHERE l.src = n.id OR l.dst = n.id) as connectivity
     FROM nodes n WHERE n.status != 'superseded'
     ORDER BY connectivity DESC LIMIT 5`
  ).all() as Array<{ id: string; name: string; kind: string; l0: string; filePath: string | null; connectivity: number }>;

  let card = `## 🐝 Hivemind Context Graph\n\n`;
  card += `Indexed: **${totalNodes} nodes**, **${totalLinks} links**`;
  if (task) card += ` | Task: "${task}"`;
  card += `\n\n**Top 5 by connectivity:**\n`;
  for (const n of topNodes) {
    const file = n.filePath ? path.basename(n.filePath) : '—';
    card += `- \`${n.id}\` **${n.name}** (${n.kind}, ${n.connectivity} links) — ${n.l0.slice(0, 60)}\n`;
  }
  card += `\n**Start here:** run \`peek <nodeId>\` or \`pack "<task>"\` to load context.\n`;
  card += `**Graph:** see [GRAPH_OVERVIEW.md](./GRAPH_OVERVIEW.md) for the full visual map.\n`;

  return card;
}
