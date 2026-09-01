import { Cron } from 'croner'
import type { AutomationTrigger } from '../../shared/types'

// Pure scheduling math for automation triggers. Kept separate from the store and
// scheduler so next-run computation is easy to reason about and test in isolation.
// All instants are ISO-8601 UTC strings (Date#toISOString), which compare
// chronologically with plain string `<=` — the scheduler relies on that.

/**
 * The next fire strictly after `from`, or undefined if the trigger has no
 * recurring future fire (manual, or a one-time trigger whose instant is past).
 * Used to compute the *subsequent* fire after one occurs.
 */
export function nextRunFrom(trigger: AutomationTrigger, from: Date): string | undefined {
  switch (trigger.type) {
    case 'manual':
      return undefined
    case 'once': {
      const at = Date.parse(trigger.runAt)
      return Number.isFinite(at) && at > from.getTime() ? new Date(at).toISOString() : undefined
    }
    case 'interval': {
      const ms = Math.max(1, Math.floor(trigger.everyMinutes)) * 60_000
      return new Date(from.getTime() + ms).toISOString()
    }
    case 'cron': {
      try {
        const next = new Cron(trigger.expr, trigger.timezone ? { timezone: trigger.timezone } : {}).nextRun(from)
        return next ? next.toISOString() : undefined
      } catch {
        return undefined
      }
    }
  }
}

/** Validate a trigger before persisting. Returns an error message, or null if ok. */
export function validateTrigger(trigger: AutomationTrigger): string | null {
  switch (trigger.type) {
    case 'manual':
      return null
    case 'once':
      return Number.isFinite(Date.parse(trigger.runAt)) ? null : 'once trigger requires a valid ISO runAt.'
    case 'interval':
      return Number.isFinite(trigger.everyMinutes) && trigger.everyMinutes >= 1
        ? null
        : 'interval trigger requires everyMinutes >= 1.'
    case 'cron':
      try {
        new Cron(trigger.expr, trigger.timezone ? { timezone: trigger.timezone } : {})
        return null
      } catch {
        return `Invalid cron expression: "${trigger.expr}".`
      }
    default:
      return 'Unknown trigger type.'
  }
}
