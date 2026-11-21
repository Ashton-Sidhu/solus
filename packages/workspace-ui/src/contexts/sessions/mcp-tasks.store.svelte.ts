import type { McpTask } from '@solus/contracts/integrations/mcp-task'
import { MCP_TASKS } from '@solus/client-core/mcp-task-row'
import { SessionHostRecords } from './session-host-records.svelte'

/** Each session's MCP tasks (docs/plans/mcp-first-class.md §12.5), and the commands of their rows. */
export class McpTasksStore extends SessionHostRecords<McpTask, 'mcpTask.changed'> {
  constructor() {
    super(MCP_TASKS)
  }

  /** Cooperative: the row says "Cancelling…" from the host's event until the server reports an end. */
  async cancel(task: Pick<McpTask, 'id' | 'sessionId'>): Promise<void> {
    await this.hostApiOf(task.sessionId).mcpTaskCancel({ sessionId: task.sessionId, id: task.id })
  }

  async answer(task: Pick<McpTask, 'id' | 'sessionId'>, key: string, answers: Record<string, string>): Promise<boolean> {
    return this.hostApiOf(task.sessionId).mcpTaskAnswer({ sessionId: task.sessionId, id: task.id, key, answers })
  }
}

export const mcpTasksStore = new McpTasksStore()
