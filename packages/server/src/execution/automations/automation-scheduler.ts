import { createLogger } from '../../logger'
import { getHostConfig } from '../../host/settings'
import { claimDueAutomations, deleteExpiredArchivedAutomations, nextAutomationDueAt, onAutomationsChanged } from '../../data/automations/automations-store'
import { automationUpdatesPaused, hasActiveRun, setAutomationRunSettledListener, triggerAutomationRun } from './automation-runner'

const log = createLogger('automations', 'automation-scheduler.ts')

// Local-only, in-process scheduler. It only fires while Solus is open — there is
// no cloud cron — but persisted `nextRunAt` instants let it catch up a single
// missed fire per automation on the next launch (the first tick picks up any
// `nextRunAt` that elapsed while the app was closed).
//
// One timer is set for the earliest `nextRunAt`. With no scheduled automation,
// no timer is set. Each change to an automation and each end of a run sets the
// timer again. A wait is never longer than MAX_WAIT_MS: on macOS the clock
// under Node timers stops while the machine sleeps, so a long timer fires late
// after a sleep. Each wake reads the real time and claims what is due.
const MAX_WAIT_MS = 5 * 60_000
const CLEANUP_EVERY_MS = 3_600_000

let started = false
let timer: NodeJS.Timeout | null = null
let stopListening: (() => void) | null = null
let ticking = false
let lastCleanupAt = 0
let lastRetentionDays: number | undefined

/** Delete expired archives, at most once an hour or when the retention changes. */
function cleanUpArchives(): void {
  const retentionDays = getHostConfig().config.archivedAutomationRetentionDays
  const now = Date.now()
  if (now - lastCleanupAt < CLEANUP_EVERY_MS && retentionDays === lastRetentionDays) return
  lastCleanupAt = now
  lastRetentionDays = retentionDays
  deleteExpiredArchivedAutomations(retentionDays, new Date(now), hasActiveRun)
}

/** Set the one timer for the next due automation. `retryLater` waits the full
 *  MAX_WAIT_MS, so a tick that failed does not start again at once. */
function arm(retryLater = false): void {
  if (timer) clearTimeout(timer)
  timer = null
  // A tick in progress sets the timer when it ends.
  if (!started || ticking) return
  try {
    // An automation with a run in progress is claimed when its run ends, not by this timer.
    const dueAt = nextAutomationDueAt(hasActiveRun)
    if (dueAt === null) return
    const wait = retryLater || automationUpdatesPaused() ? MAX_WAIT_MS : Math.min(Math.max(dueAt - Date.now(), 0), MAX_WAIT_MS)
    timer = setTimeout(wake, wait)
    // Don't keep the process alive solely for the scheduler.
    timer.unref?.()
  } catch (err: any) {
    log.error('automation_scheduler_arm_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

function wake(): void {
  timer = null
  void tick()
}

async function tick(): Promise<void> {
  if (ticking) return
  if (automationUpdatesPaused()) return arm()
  ticking = true
  let failed = false
  try {
    cleanUpArchives()
    // Skip automations still running a previous fire: they keep their past-due
    // nextRunAt and get claimed when the run ends, instead of stacking
    // overlapping runs on the same working directory.
    const due = await claimDueAutomations(new Date(), hasActiveRun)
    for (const a of due) {
      log.info('automation_scheduled_fire', { automationId: a.id, automationName: a.name, triggerType: a.trigger.type })
      triggerAutomationRun(a).catch((err) => {
        log.error('automation_scheduled_fire_failed', { automationId: a.id, error: err instanceof Error ? err.message : String(err) })
        // No run started, so no run end sets the timer for this automation's next fire.
        arm()
      })
    }
  } catch (err: any) {
    failed = true
    log.error('automation_scheduler_tick_failed', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    ticking = false
  }
  arm(failed)
}

/** Start the scheduler. Runs an immediate catch-up tick, then sets one timer
 *  for the next due automation. Idempotent; returns the stop function. */
export function startAutomationScheduler(): () => void {
  if (started) return stopAutomationScheduler
  started = true
  stopListening = onAutomationsChanged(() => arm())
  // A run ended: a due automation skipped while it ran fires now, and its archive can expire.
  setAutomationRunSettledListener(() => void tick())
  void tick()
  log.info('automation_scheduler_started')
  return stopAutomationScheduler
}

export function stopAutomationScheduler(): void {
  if (!started) return
  started = false
  stopListening?.()
  stopListening = null
  setAutomationRunSettledListener(null)
  if (timer) clearTimeout(timer)
  timer = null
  log.info('automation_scheduler_stopped')
}
