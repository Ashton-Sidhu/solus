import { mcpTaskAnswerRequestSchema, mcpTaskIdRequestSchema, mcpTaskListRequestSchema } from '@solus/contracts/integrations/mcp-task'
import type { McpTasks } from '../../integrations/mcp-tasks'
import type { SolusServer } from '../server'

/** MCP tasks (docs/plans/mcp-first-class.md §12.5). The access policy checks the session; the owner checks that the MCP task is that session's. */
export function registerMcpTaskHandlers(server: SolusServer, mcpTasks: McpTasks): void {
  server.register('mcpTaskList', ([input]) => mcpTasks.list(mcpTaskListRequestSchema.parse(input).sessionId))
  server.register('mcpTaskCancel', ([input]) => mcpTasks.cancel(mcpTaskIdRequestSchema.parse(input)))
  server.register('mcpTaskAnswer', ([input]) => mcpTasks.answer(mcpTaskAnswerRequestSchema.parse(input)))
}
