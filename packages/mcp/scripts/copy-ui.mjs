// tsc does not copy non-TypeScript assets, so the graph page is copied next to the
// compiled server. Kept dependency-free and path-relative to the package directory.
import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve('src', 'ui');
const outDir = path.resolve('dist', 'ui');

if (!fs.existsSync(srcDir)) {
  console.error(`[copy-ui] missing source directory: ${srcDir}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const copied = [];
for (const name of fs.readdirSync(srcDir)) {
  if (!name.endsWith('.html')) continue;
  fs.copyFileSync(path.join(srcDir, name), path.join(outDir, name));
  copied.push(name);
}

if (!copied.length) {
  console.error('[copy-ui] no .html assets found in src/ui');
  process.exit(1);
}

console.log(`[copy-ui] copied ${copied.join(', ')} -> dist/ui`);
