import { useCallback, useEffect, useState } from 'react'
import type { McpTask } from '@solus/contracts/integrations/mcp-task'
import { shownBackgroundRecords } from '@solus/client-core/background-item'
import { MCP_TASKS } from '@solus/client-core/mcp-task-row'
import { useApp, useListened } from '../../app/app-context'

export interface McpTasksView {
  /** The live MCP tasks, and those that ended since the newest turn started. */
  readonly tasks: readonly McpTask[]
  readonly cancel: (task: McpTask) => Promise<void>
  readonly answer: (task: McpTask, key: string, answers: Record<string, string>) => Promise<boolean>
}

/**
 * A thread's MCP tasks (docs/plans/mcp-first-class.md §12.5), as desktop's
 * `mcpTasksStore` reads them: the list when the host is ready, then each
 * `mcpTask.changed`. A host that is not ready shows none, so no row keeps a
 * status the host may no longer have. Mobile keeps no turn start times, so an
 * ended row shows until the next turn starts here (`turnActive`).
 */
export function useMcpTasks(hostId: string, sessionId: string, turnActive: boolean): McpTasksView {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const [tasks, setTasks] = useState<readonly McpTask[]>([])
  const [since, setSince] = useState(() => Date.now())
  useEffect(() => {
    if (turnActive) setSince(Date.now())
  }, [turnActive])
  useEffect(() => {
    const connection = app.connections.connection(hostId)
    setTasks([])
    if (readiness !== 'ready' || !connection) return
    let current = true
    // An older host has no such method: no row.
    void connection.api.mcpTaskList({ sessionId }).then((list) => { if (current) setTasks(list) }, () => undefined)
    const stop = connection.events.subscribe('mcpTask.changed', (event) => {
      if (event.sessionId !== sessionId) return
      setTasks((list) => {
        const index = list.findIndex((entry) => entry.id === event.task.id)
        return index === -1 ? [...list, event.task] : list.with(index, event.task)
      })
    })
    return () => {
      current = false
      stop()
    }
  }, [app, hostId, readiness, sessionId])
  const cancel = useCallback(async (task: McpTask) => {
    const connection = app.connections.connection(hostId)
    if (!connection) throw new Error('This host is not connected.')
    await connection.api.mcpTaskCancel({ sessionId: task.sessionId, id: task.id })
  }, [app, hostId])
  const answer = useCallback(async (task: McpTask, key: string, answers: Record<string, string>) => {
    const connection = app.connections.connection(hostId)
    if (!connection) throw new Error('This host is not connected.')
    return connection.api.mcpTaskAnswer({ sessionId: task.sessionId, id: task.id, key, answers })
  }, [app, hostId])
  return { tasks: shownBackgroundRecords(MCP_TASKS, tasks, since), cancel, answer }
}
