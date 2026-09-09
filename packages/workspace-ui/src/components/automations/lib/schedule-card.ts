import type { Automation } from '@solus/contracts/types'

/** An immediate manual check must not make a paused future one-time check
 * look complete. Compare the run to its scheduled instant. */
export function hasRunOnce(automation: Automation): boolean {
  return automation.trigger.type === 'once' && !automation.nextRunAt &&
    !!automation.lastRunAt && Date.parse(automation.lastRunAt) >= Date.parse(automation.trigger.runAt)
}

/** Schedule state is separate from the last check's outcome. Stopping does not
 * claim the check succeeded or interrupt a turn already sent to the session. */
export function scheduleCardState(automation: Automation): string {
  if (automation.archiveRequested) return 'Stopping after current check'
  if (automation.archivedAt) return hasRunOnce(automation) ? 'Schedule complete' : 'Stopped'
  if (automation.trigger.type === 'manual' && !automation.enabled) return 'Stopped'
  if (automation.lastRunStatus === 'running') return 'Check queued or running'
  if (hasRunOnce(automation)) {
    return automation.lastRunStatus === 'failed' ? 'Check failed' : 'Schedule complete'
  }
  if (!automation.enabled) return 'Paused'
  if (!automation.nextRunAt) return 'Manual'
  const next = new Date(automation.nextRunAt).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  return `${automation.lastRunStatus === 'failed' ? 'Last check failed · ' : ''}Next check: ${next}`
}
