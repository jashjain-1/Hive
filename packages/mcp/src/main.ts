#!/usr/bin/env node

import path from 'path';
import { HiveMcpServer } from './server';

interface CliOptions {
  repoRoot: string;
  dbPath?: string;
  tenantId: string;
  embeddings: 'auto' | 'off';
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    repoRoot: process.env.HIVE_REPO_ROOT ?? process.cwd(),
    dbPath: process.env.HIVE_DB_PATH,
    tenantId: process.env.HIVE_TENANT_ID ?? 'default',
    embeddings: process.env.HIVE_EMBEDDINGS === 'off' ? 'off' : 'auto'
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === '--repo' || arg === '-r') options.repoRoot = next();
    else if (arg === '--db') options.dbPath = next();
    else if (arg === '--tenant') options.tenantId = next();
    else if (arg === '--no-embeddings') options.embeddings = 'off';
    else if (arg === '--help' || arg === '-h') {
      console.error([
        'Hivemind MCP (stdio)',
        '',
        'Usage: hive-mcp [options]',
        '',
        '  -r, --repo <path>     Repository to index (default: cwd or HIVE_REPO_ROOT)',
        '      --db <path>       SQLite path (default: <repo>/.hive/tenants/<tenant>.db)',
        '      --tenant <id>     Tenant id (default: default)',
        '      --no-embeddings   Disable local ONNX embeddings and use lexical fallback',
        '  -h, --help            Show this help',
        '',
        'Environment: HIVE_REPO_ROOT, HIVE_DB_PATH, HIVE_TENANT_ID, HIVE_EMBEDDINGS=off'
      ].join('\n'));
      process.exit(0);
    }
  }

  options.repoRoot = path.resolve(options.repoRoot);
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const server = new HiveMcpServer({
    repoRoot: options.repoRoot,
    dbPath: options.dbPath,
    tenantId: options.tenantId,
    embeddings: options.embeddings,
    allowLocalIndex: true
  });

  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.start();
}

main().catch(error => {
  console.error('[Hivemind MCP] Fatal startup error:', error);
  process.exit(1);
});
