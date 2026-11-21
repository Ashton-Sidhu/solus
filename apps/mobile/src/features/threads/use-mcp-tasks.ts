import { useCallback } from 'react'
import type { McpTask } from '@solus/contracts/integrations/mcp-task'
import { MCP_TASKS } from '@solus/client-core/mcp-task-row'
import { useSessionHostRecords } from './use-session-host-records'

export interface McpTasksView {
  /** The live MCP tasks, and those that ended since the newest turn started. */
  readonly tasks: readonly McpTask[]
  readonly cancel: (task: McpTask) => Promise<void>
  readonly answer: (task: McpTask, key: string, answers: Record<string, string>) => Promise<boolean>
}

/** A thread's MCP tasks (docs/plans/mcp-first-class.md §12.5), and the commands of their rows. */
export function useMcpTasks(hostId: string, sessionId: string, turnActive: boolean): McpTasksView {
  const { records: tasks, hostApi } = useSessionHostRecords(hostId, sessionId, turnActive, MCP_TASKS)
  const cancel = useCallback(async (task: McpTask) => {
    await hostApi().mcpTaskCancel({ sessionId: task.sessionId, id: task.id })
  }, [hostApi])
  const answer = useCallback(async (task: McpTask, key: string, answers: Record<string, string>) => {
    return hostApi().mcpTaskAnswer({ sessionId: task.sessionId, id: task.id, key, answers })
  }, [hostApi])
  return { tasks, cancel, answer }
}
