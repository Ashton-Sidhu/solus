import { mcpAppRequestSchema, mcpAppToolRequestSchema, mcpAppCallRequestSchema, mcpAppResourceRequestSchema } from '@solus/contracts/mcp-apps'
import type { IntegrationApps } from '../../integrations/mcp-apps'
import type { SolusServer } from '../server'

export function registerMcpAppHandlers(server: SolusServer, apps: IntegrationApps): void {
  server.register('mcpAppRead', ([input], ctx) => apps.read(mcpAppRequestSchema.parse(input), ctx))
  server.register('mcpAppToolInfo', ([input], ctx) => apps.toolInfo(mcpAppToolRequestSchema.parse(input), ctx))
  server.register('mcpAppCallTool', ([input], ctx) => apps.callTool(mcpAppCallRequestSchema.parse(input), ctx))
  server.register('mcpAppReadResource', ([input], ctx) => apps.readResource(mcpAppResourceRequestSchema.parse(input), ctx))
}
