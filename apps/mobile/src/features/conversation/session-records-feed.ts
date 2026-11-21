import type { BackgroundKind, BackgroundRecord, SessionRecordTopic } from '@solus/client-core/background-item'
import { upsertById } from '@solus/client-core/keep-equal'
import { MCP_TASKS } from '@solus/client-core/mcp-task-row'
import { RESOURCE_WATCHES } from '@solus/client-core/resource-watch-row'
import type { McpTask } from '@solus/contracts/integrations/mcp-task'
import type { ResourceWatch } from '@solus/contracts/integrations/resource-watch'
import type { HostConnection } from '../hosts/host-connections'
import { Listeners } from '../../lib/listeners'

/**
 * One session's background records of one kind on the phone
 * (docs/plans/mcp-first-class.md §11.5, §12.5): the host's list, then each
 * change event of the kind. The controller reads the list on each load, a
 * reset included, because the host recovers a missed event only through it.
 * An event that comes while a read is in flight may be newer than that read's
 * answer, so it starts the read again.
 */
export class SessionRecordsFeed<T extends BackgroundRecord, Topic extends SessionRecordTopic> {
  list: readonly T[] = []
  readonly changes = new Listeners()
  private read = 0
  private isReading = false
  private readonly unsubscribe: () => void

  constructor(
    protected readonly connection: HostConnection,
    private readonly sessionId: () => string,
    readonly kind: BackgroundKind<T, Topic>,
  ) {
    this.unsubscribe = connection.events.subscribe(kind.topic, (event) => {
      if (event.sessionId !== this.sessionId()) return
      if (this.isReading) return void this.refresh()
      this.list = upsertById(this.list, kind.recordOf(event))
      this.changes.notify()
    })
  }

  async refresh(): Promise<void> {
    const read = ++this.read
    this.isReading = true
    // An older host has no such method: no row.
    const list = await this.kind.list(this.connection.api, this.sessionId()).catch(() => [])
    if (read !== this.read) return
    this.isReading = false
    this.list = list
    this.changes.notify()
  }

  close(): void {
    this.read += 1
    this.unsubscribe()
  }
}

/** A thread's MCP tasks (§12.5), with the commands of their rows. */
export class McpTasksFeed extends SessionRecordsFeed<McpTask, 'mcpTask.changed'> {
  constructor(connection: HostConnection, sessionId: () => string) {
    super(connection, sessionId, MCP_TASKS)
  }

  async cancel(task: McpTask): Promise<void> {
    await this.connection.api.mcpTaskCancel({ sessionId: task.sessionId, id: task.id })
  }

  answer(task: McpTask, key: string, answers: Record<string, string>): Promise<boolean> {
    return this.connection.api.mcpTaskAnswer({ sessionId: task.sessionId, id: task.id, key, answers })
  }
}

/** A thread's resource watches (§11.5), with the command of their rows. */
export class ResourceWatchesFeed extends SessionRecordsFeed<ResourceWatch, 'integration.resourceWatchChanged'> {
  constructor(connection: HostConnection, sessionId: () => string) {
    super(connection, sessionId, RESOURCE_WATCHES)
  }

  async stop(watch: ResourceWatch): Promise<void> {
    await this.connection.api.integrationResourceWatchStop({ sessionId: watch.sessionId, id: watch.id })
  }
}
