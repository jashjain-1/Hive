/**
 * Hivemind MCP Stdio CLI Entry Point
 *
 * Starts the MCP server over stdio for local Claude Desktop / Cursor / Windsurf / Antigravity.
 * Usage: node dist/cli.js   (or hive-mcp after npm link)
 */
import { HiveMcpServer } from './server';

async function main() {
  const server = new HiveMcpServer({
    repoRoot: process.env.HIVE_REPO_ROOT ?? process.cwd(),
    dbPath: process.env.HIVE_DB_PATH,
    tenantId: process.env.HIVE_TENANT_ID ?? 'default',
    embeddings: process.env.HIVE_EMBEDDINGS === 'off' ? 'off' : 'auto',
    allowLocalIndex: true
  });
  await server.start();
}

main().catch(err => {
  console.error('[Hivemind MCP CLI] Fatal:', err);
  process.exit(1);
});
