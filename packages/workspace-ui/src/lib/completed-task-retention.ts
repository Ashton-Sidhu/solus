export { DEFAULT_SIDEBAR_COMPLETED_RETENTION_DAYS } from '@solus/contracts/host-config'

export const SIDEBAR_COMPLETED_RETENTION_CHECK_MS = 60 * 60 * 1000

/** Keep recent completed work in the sidebar without changing its durable task
 * status. A missing completion time cannot be expired safely, so keep it. */
export function completedTasksWithinRetention<T extends { completedAt: number }>(
  tasks: readonly T[],
  retentionDays: number,
  now: number,
): T[] {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  return tasks.filter((task) => !task.completedAt || task.completedAt > cutoff)
}
