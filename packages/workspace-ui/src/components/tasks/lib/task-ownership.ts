import { sharesStore } from '../../../contexts/sharing/shares.store.svelte'
import type { TasksStore } from '../../../contexts/tasks/tasks.store.svelte'

/**
 * Only a task's owner may delete it; the host refuses anyone else, so every
 * Delete asks this first rather than hiding a row the host will bring back. A
 * host that keeps no share list is the reader's own.
 */
export async function ownsTask(tasks: TasksStore, taskId: string): Promise<boolean> {
  const serverId = await tasks.get(taskId).ownerHost()
  if (!serverId) return false
  const list = await sharesStore.load(serverId, { kind: 'task', id: taskId })
  return !list || list.callerRole === 'owner'
}
