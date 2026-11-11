import type { SessionCronSummary } from '@anthropic-ai/claude-agent-sdk'
import type { NormalizedEvent } from '@solus/contracts/types'

const SCHEDULE_TASK_PREFIX = 'schedule:'

/** A pending schedule's background task id. The prefix keeps it apart from CLI task ids. */
export function isScheduleTaskId(taskId: string): boolean {
  return taskId.startsWith(SCHEDULE_TASK_PREFIX)
}

/**
 * The session schedules (CronCreate, ScheduleWakeup, /loop) the CLI holds, as
 * background work that does not hold the turn (docs/plans/session-schedules.md).
 * A schedule lives in the CLI process, so the query stays open while one is
 * pending. The Stop hook reports the list at each turn end.
 */
export class ScheduledWakes {
  private readonly pending = new Set<string>()
  private changes: NormalizedEvent[] = []

  /** The schedules the CLI reports at a turn end. An older CLI reports none: nothing changes. */
  report(crons: readonly SessionCronSummary[] | undefined): void {
    if (!crons) return
    const reported = new Set(crons.map((cron) => `${SCHEDULE_TASK_PREFIX}${cron.id}`))
    for (const taskId of reported) {
      if (this.pending.has(taskId)) continue
      this.pending.add(taskId)
      this.changes.push({ type: 'background_task_started', taskId, awaitable: true })
    }
    for (const taskId of this.pending) {
      if (reported.has(taskId)) continue
      this.pending.delete(taskId)
      this.changes.push({ type: 'background_task_settled', taskId, status: 'completed' })
    }
  }

  /** A schedule the person stopped. The CLI cannot delete one; it ends with the process. */
  drop(taskId: string): void {
    this.pending.delete(taskId)
  }

  /** The starts and settles since the last call, in order. */
  takeChanges(): NormalizedEvent[] {
    const changes = this.changes
    this.changes = []
    return changes
  }
}
