import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HiveContextService, HiveServiceOptions } from './context-service';
import { registerHiveTools } from './tools';

export interface HiveServerOptions extends HiveServiceOptions {
  serverName?: string;
}

export function createHiveMcpServer(
  service: HiveContextService,
  serverName = 'hivemind-context'
): McpServer {
  const server = new McpServer({
    name: serverName,
    version: '2.0.0'
  });

  registerHiveTools(server, service);
  return server;
}

export class HiveMcpServer {
  public readonly server: McpServer;
  public readonly service: HiveContextService;

  constructor(options: HiveServerOptions) {
    this.service = new HiveContextService(options);
    this.server = createHiveMcpServer(
      this.service,
      options.serverName ?? `hivemind-context-${this.service.tenantId}`
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(
      `[Hivemind MCP] stdio ready | repo=${this.service.repoRoot} | db=${this.service.dbPath}`
    );
  }

  close(): void {
    this.service.close();
  }
}
