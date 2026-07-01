import { createLogger } from '../logger'
import { claimDueAutomations } from './automations-store'
import { triggerAutomationRun } from './automation-runner'

const log = createLogger('automations', 'automation-scheduler.ts')

// Local-only, in-process scheduler. It only fires while Solus is open — there is
// no cloud cron — but persisted `nextRunAt` instants let it catch up a single
// missed fire per automation on the next launch (the first tick picks up any
// `nextRunAt` that elapsed while the app was closed).
//
// One coarse ticker drives everything. Minute-or-coarser cadences don't need
// sub-second precision, so a 30s tick keeps wakeups cheap while bounding fire
// latency to ~30s.
const TICK_MS = 30_000

let timer: NodeJS.Timeout | null = null
let ticking = false

async function tick(): Promise<void> {
  // Guard against overlap if a tick's I/O outlasts the interval.
  if (ticking) return
  ticking = true
  try {
    const due = await claimDueAutomations()
    for (const a of due) {
      log.info(`firing scheduled automation ${a.id} ("${a.name}") trigger=${a.trigger.type}`)
      void triggerAutomationRun(a)
    }
  } catch (err: any) {
    log.error(`scheduler tick failed: ${String(err)}`)
  } finally {
    ticking = false
  }
}

/** Start the scheduler. Runs an immediate catch-up tick, then ticks on an
 *  interval. Idempotent; returns the stop function. */
export function startAutomationScheduler(): () => void {
  if (timer) return stopAutomationScheduler
  void tick()
  timer = setInterval(() => void tick(), TICK_MS)
  // Don't keep the process alive solely for the scheduler.
  timer.unref?.()
  log.info('automation scheduler started')
  return stopAutomationScheduler
}

export function stopAutomationScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  log.info('automation scheduler stopped')
}
