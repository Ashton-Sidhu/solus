import { SvelteMap } from 'svelte/reactivity'
import type { McpTask } from '@solus/contracts/integrations/mcp-task'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'

/**
 * Each session's MCP tasks (docs/plans/mcp-first-class.md §12.5), by Solus
 * session id. A conversation asks with `ensure`; the store reads the list from
 * the host that runs the session, then follows `mcpTask.changed`. While a host
 * is not ready its lists are dropped, so no row shows a status the host may no
 * longer have; when it is ready again they are read before a row shows.
 */
export class McpTasksStore {
  private readonly lists = new SvelteMap<string, McpTask[]>()
  private readonly serverIds = new Map<string, string>()
  private readonly reads = new Map<string, number>()
  private stopWatching: (() => void)[] | null = null

  ensure(serverId: string, sessionId: string): void {
    this.watch()
    const known = this.serverIds.get(sessionId)
    this.serverIds.set(sessionId, serverId)
    if (known !== serverId || (!this.lists.has(sessionId) && !this.reads.has(sessionId))) void this.refresh(sessionId)
  }

  tasksFor(sessionId: string | null | undefined): readonly McpTask[] {
    return (sessionId && this.lists.get(sessionId)) || NO_TASKS
  }

  /** Cooperative: the row says "Cancelling…" from the host's event until the server reports an end. */
  async cancel(task: Pick<McpTask, 'id' | 'sessionId'>): Promise<void> {
    await this.api(task.sessionId).mcpTaskCancel({ sessionId: task.sessionId, id: task.id })
  }

  async answer(task: Pick<McpTask, 'id' | 'sessionId'>, key: string, answers: Record<string, string>): Promise<boolean> {
    return this.api(task.sessionId).mcpTaskAnswer({ sessionId: task.sessionId, id: task.id, key, answers })
  }

  private api(sessionId: string) {
    const serverId = this.serverIds.get(sessionId)
    if (!serverId) throw new Error('This session is not shown here.')
    return serverConnections.apiFor(serverId)
  }

  private watch(): void {
    if (this.stopWatching) return
    this.stopWatching = [
      subscribeAllHosts('mcpTask.changed', (serverId, { sessionId, task }) => {
        if (this.serverIds.get(sessionId) !== serverId) return
        const list = this.lists.get(sessionId)
        // A list not read yet is read whole, with this change in it.
        if (!list) return void this.refresh(sessionId)
        const index = list.findIndex((entry) => entry.id === task.id)
        this.lists.set(sessionId, index === -1 ? [...list, task] : list.with(index, task))
      }),
      serverConnections.onReadinessChange((serverId, status) => {
        for (const [sessionId, owner] of this.serverIds) {
          if (owner !== serverId) continue
          if (status === 'ready') void this.refresh(sessionId)
          else {
            this.lists.delete(sessionId)
            this.reads.set(sessionId, (this.reads.get(sessionId) ?? 0) + 1)
          }
        }
      }),
    ]
  }

  private async refresh(sessionId: string): Promise<void> {
    const serverId = this.serverIds.get(sessionId)
    if (!serverId) return
    const read = (this.reads.get(sessionId) ?? 0) + 1
    this.reads.set(sessionId, read)
    const api = serverConnections.apiFor(serverId)
    // An older host has no such method: no row, as for a session without MCP tasks.
    const next = await api.mcpTaskList({ sessionId }).catch(() => null)
    if (this.reads.get(sessionId) !== read || serverConnections.apiFor(serverId) !== api || !next) return
    this.lists.set(sessionId, next)
  }
}

const NO_TASKS: readonly McpTask[] = []

export const mcpTasksStore = new McpTasksStore()
