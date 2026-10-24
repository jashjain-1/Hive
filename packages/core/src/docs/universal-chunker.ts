import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import officeParser from 'officeparser';
import * as xlsx from 'xlsx';
import { NodeRecord, NodeKind } from '@hivemind/types';

export class UniversalDocChunker {
  async parseDocument(filePath: string, buffer: Buffer): Promise<NodeRecord[]> {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    const nodes: NodeRecord[] = [];
    // Stable IDs keep pack receipts reproducible across re-indexes.
    const stableId = (key: string): string =>
      `d:${crypto.createHash('sha256').update(`${filePath}\n${key}`).digest('hex').slice(0, 12)}`;
    const rootId = stableId('root');

    let rootKind: NodeKind = 'document';
    if (ext === '.pptx') rootKind = 'presentation';
    else if (ext === '.xlsx' || ext === '.csv') rootKind = 'workbook';

    // 1. Root Document Node
    nodes.push({
      id: rootId,
      tree: 'knowledge',
      parent: null,
      kind: rootKind,
      name: fileName,
      filePath,
      status: 'live',
      ver: 1,
      hash: crypto.createHash('sha256').update(buffer).digest('hex'),
      l0: `${fileName} (${rootKind})`,
      tokL0: Math.ceil(fileName.length / 3),
      tokL1: 0,
      tokL2: 0,
      stale: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    // 2. Format-Specific Chunking
    if (ext === '.pdf') {
      const data = await pdfParse(buffer);
      const pages = data.text.split(/\n\s*\n\s*\n/); // Approximate page delimiter
      pages.forEach((pageText: string, idx: number) => {
        if (!pageText.trim()) return;
        const pageNum = idx + 1;
        nodes.push({
          id: stableId(`page:${pageNum}`),
          tree: 'knowledge',
          parent: rootId,
          kind: 'page',
          name: `${fileName} - Page ${pageNum}`,
          filePath,
          status: 'live',
          ver: 1,
          hash: crypto.createHash('sha256').update(pageText).digest('hex'),
          l0: `Page ${pageNum} (${pageText.slice(0, 50).replace(/\n/g, ' ')}...)`,
          l1: pageText.slice(0, Math.min(500, Math.max(40, Math.floor(pageText.length * 0.6)))),
          l2: pageText,
          tokL0: 15,
          tokL1: Math.ceil(Math.min(500, Math.max(40, Math.floor(pageText.length * 0.6))) / 4),
          tokL2: Math.ceil(pageText.length / 4),
          stale: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      });
    } else if (ext === '.pptx') {
      const text = await officeParser.parseOfficeAsync(buffer);
      const slides = text.split(/Slide \d+:/i).filter(Boolean);
      slides.forEach((slideText: string, idx: number) => {
        const slideNum = idx + 1;
        const firstLine = slideText.trim().split('\n')[0] || `Slide ${slideNum}`;
        nodes.push({
          id: stableId(`slide:${slideNum}`),
          tree: 'knowledge',
          parent: rootId,
          kind: 'slide',
          name: `Slide ${slideNum}: ${firstLine.slice(0, 30)}`,
          filePath,
          status: 'live',
          ver: 1,
          hash: crypto.createHash('sha256').update(slideText).digest('hex'),
          l0: `Slide ${slideNum}: ${firstLine.slice(0, 40)}`,
          l1: slideText.slice(0, Math.min(500, Math.max(40, Math.floor(slideText.length * 0.6)))),
          l2: slideText,
          tokL0: 18,
          tokL1: Math.ceil(Math.min(500, Math.max(40, Math.floor(slideText.length * 0.6))) / 4),
          tokL2: Math.ceil(slideText.length / 4),
          stale: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      });
    } else if (ext === '.docx') {
      const text = await officeParser.parseOfficeAsync(buffer);
      const sections = text.split(/\n(?=(?:[A-Z][a-z]+ ){0,3}(?:Chapter|Section|Overview|Summary|Introduction|Conclusion|Appendix|Requirements|Architecture))/).filter(Boolean);
      if (sections.length === 0 && text.trim()) {
        sections.push(text);
      }
      sections.forEach((sectionText: string, idx: number) => {
        if (!sectionText.trim()) return;
        const firstLine = sectionText.trim().split('\n')[0] || `Section ${idx + 1}`;
        nodes.push({
          id: stableId(`section:${idx}`),
          tree: 'knowledge',
          parent: rootId,
          kind: 'section',
          name: `Section ${idx + 1}: ${firstLine.slice(0, 40)}`,
          filePath,
          status: 'live',
          ver: 1,
          hash: crypto.createHash('sha256').update(sectionText).digest('hex'),
          l0: `Section ${idx + 1}: ${firstLine.slice(0, 45)}`,
          l1: sectionText.slice(0, Math.min(500, Math.max(40, Math.floor(sectionText.length * 0.6)))),
          l2: sectionText,
          tokL0: 16,
          tokL1: Math.ceil(Math.min(500, Math.max(40, Math.floor(sectionText.length * 0.6))) / 4),
          tokL2: Math.ceil(sectionText.length / 4),
          stale: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      });
    } else if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
      const text = buffer.toString('utf8');
      const headings = Array.from(text.matchAll(/^(#{1,6})\s+(.+)$/gm));
      const sections: Array<{ name: string; body: string }> = [];

      if (headings.length === 0) {
        if (text.trim()) {
          sections.push({ name: fileName, body: text });
        }
      } else {
        for (let i = 0; i < headings.length; i++) {
          const heading = headings[i];
          const start = heading.index ?? 0;
          const end = i + 1 < headings.length ? headings[i + 1].index ?? text.length : text.length;
          const body = text.slice(start, end).trim();
          if (body) {
            sections.push({ name: heading[2].trim(), body });
          }
        }
      }

      sections.forEach((section, idx) => {
        nodes.push({
          id: stableId(`md-section:${idx}`),
          tree: 'knowledge',
          parent: rootId,
          kind: 'section',
          name: section.name.slice(0, 80),
          filePath,
          status: 'live',
          ver: 1,
          hash: crypto.createHash('sha256').update(section.body).digest('hex'),
          l0: `${section.name.slice(0, 70)}`,
          l1: section.body.slice(0, Math.min(500, Math.max(40, Math.floor(section.body.length * 0.6)))),
          l2: section.body,
          tokL0: Math.ceil(section.name.length / 4),
          tokL1: Math.ceil(Math.min(500, Math.max(40, Math.floor(section.body.length * 0.6))) / 4),
          tokL2: Math.ceil(section.body.length / 4),
          stale: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      });
    } else if (ext === '.xlsx' || ext === '.csv') {
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      workbook.SheetNames.forEach((sheetName: string) => {
        const sheet = workbook.Sheets[sheetName];
        const csvContent = xlsx.utils.sheet_to_csv(sheet);
        const headers = csvContent.split('\n')[0] || '';
        nodes.push({
          id: stableId(`sheet:${sheetName}`),
          tree: 'knowledge',
          parent: rootId,
          kind: 'sheet',
          name: `Sheet: ${sheetName}`,
          filePath,
          status: 'live',
          ver: 1,
          hash: crypto.createHash('sha256').update(csvContent).digest('hex'),
          l0: `Sheet: ${sheetName} | Columns: ${headers.slice(0, 50)}`,
          l1: csvContent.slice(0, 300),
          l2: csvContent.slice(0, 3000), // Cap oversized spreadsheets
          tokL0: 20,
          tokL1: Math.ceil(Math.min(csvContent.length, 300) / 4),
          tokL2: Math.min(800, Math.ceil(csvContent.length / 4)),
          stale: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      });
    }

    return nodes;
  }
}
