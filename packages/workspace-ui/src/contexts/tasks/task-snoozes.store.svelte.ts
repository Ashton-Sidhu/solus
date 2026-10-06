import { SvelteMap } from 'svelte/reactivity'
import type { TaskSnooze } from '@solus/contracts/task-types'
import { serverConnections } from '@solus/client-core/server-connections'

/** One of the reader's snoozes, and the host that holds it. */
interface HeldSnooze extends TaskSnooze {
  serverId: string
}

/**
 * The reader's own task snoozes (docs/task-snooze.md). Each host holds the
 * snoozes of the person this client signs in as, and tells only that person's
 * connections when they change, so this store never holds anyone else's. A
 * task with no entry is not snoozed for this reader.
 */
export class TaskSnoozesStore {
  private snoozesByTaskId = new SvelteMap<string, HeldSnooze>()
  private watchedServerIds = new Set<string>()
  /** Bumped by each read, so an older answer never overwrites a newer one. */
  private readGenerations = new Map<string, number>()
  private isStarted = false

  /** Read every host now, and again on each reconnect and each change. */
  start(): void {
    if (this.isStarted) return
    this.isStarted = true
    for (const serverId of serverConnections.connectedServerIds()) this.watchHost(serverId)
    serverConnections.onConnectionCreated((connection) => this.watchHost(connection.serverId))
    serverConnections.onPhaseChange((serverId, phase) => {
      if (phase === 'connected') void this.reload(serverId)
    })
  }

  private watchHost(serverId: string): void {
    if (this.watchedServerIds.has(serverId)) return
    this.watchedServerIds.add(serverId)
    serverConnections.eventsFor(serverId).subscribe('tasks.snoozesChanged', () => void this.reload(serverId))
    void this.reload(serverId)
  }

  /** Replace one host's snoozes with what it answers. A host that fails the
   *  read keeps what it answered last time. */
  private async reload(serverId: string): Promise<void> {
    const generation = (this.readGenerations.get(serverId) ?? 0) + 1
    this.readGenerations.set(serverId, generation)
    const answer = await serverConnections.apiFor(serverId).tasksSnoozes().catch(() => null)
    if (!answer || this.readGenerations.get(serverId) !== generation) return
    const answered = new Set(answer.map((snooze) => snooze.taskId))
    for (const [taskId, snooze] of this.snoozesByTaskId) {
      if (snooze.serverId === serverId && !answered.has(taskId)) this.snoozesByTaskId.delete(taskId)
    }
    for (const snooze of answer) this.snoozesByTaskId.set(snooze.taskId, { ...snooze, serverId })
  }

  /** The reader's snooze of one task, or undefined. */
  get(taskId: string): TaskSnooze | undefined {
    return this.snoozesByTaskId.get(taskId)
  }

  /** Snooze a task for the reader until a wake time; null wakes it now. */
  async snooze(serverId: string, taskId: string, until: number | null, note = ''): Promise<void> {
    // A read that started before this write must not bring the old state back.
    this.readGenerations.set(serverId, (this.readGenerations.get(serverId) ?? 0) + 1)
    const snooze = await serverConnections.apiFor(serverId).tasksSnooze(taskId, until, note)
    if (snooze) this.snoozesByTaskId.set(taskId, { ...snooze, serverId })
    else this.snoozesByTaskId.delete(taskId)
  }
}

export const taskSnoozesStore = new TaskSnoozesStore()
