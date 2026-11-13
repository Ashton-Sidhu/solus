import type { AppDescriptor, AppScheduleDeclaration, AppScheduleTrigger, AppScheduleView } from '@solus/contracts/apps'
import type { AutomationTrigger } from '@solus/contracts/types'
import { nextRunFrom, validateTrigger } from '../data/automations/automation-schedule'
import {
  deleteSchedule,
  listDueSchedules,
  listSchedules,
  loadVersion,
  nextScheduleDueAt,
  saveSchedule,
  type AppRecord,
  type AppScheduleRecord,
} from '../data/apps/app-store'
import { createLogger } from '../logger'
import type { AppAuthority, AppLifecyclePart, Apps } from './apps'

const log = createLogger('apps', 'app-schedules.ts')

/**
 * App schedules (docs/plans/apps.md §8): each one runs a mutation of its app
 * on a timer, with no person there and no agent turn. The declarations are in
 * the active version's descriptor; the rows here hold only their state. The
 * rules are the automation scheduler's: one timer for the earliest due row, a
 * wait of at most five minutes because a sleeping machine stops Node's clock,
 * one overdue run after the host was off, and no second run of a schedule
 * while one is in progress.
 */

const MAX_WAIT_MS = 5 * 60_000

/** The trigger math is the automations' (`automation-schedule.ts`). */
function automationTrigger(trigger: AppScheduleTrigger): AutomationTrigger {
  return trigger.type === 'interval'
    ? { type: 'interval', everyMinutes: trigger.everyMinutes }
    : trigger.timezone ? { type: 'cron', expr: trigger.expr, timezone: trigger.timezone } : { type: 'cron', expr: trigger.expr }
}

/** Why a declared trigger cannot be scheduled, or null. A deploy refuses a descriptor with one. */
export function scheduleTriggerProblem(schedule: AppScheduleDeclaration): string | null {
  const trigger = automationTrigger(schedule.trigger)
  const problem = validateTrigger(trigger)
  if (problem) return `The schedule ${schedule.name}: ${problem}`
  return nextRunFrom(trigger, new Date()) === undefined ? `The schedule ${schedule.name} has a trigger that never fires.` : null
}

function nextRunAt(trigger: AppScheduleTrigger, from: number): number | null {
  const next = nextRunFrom(automationTrigger(trigger), new Date(from))
  return next === undefined ? null : Date.parse(next)
}

export class AppSchedules implements AppLifecyclePart {
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private ticking = false
  /** `<app id>/<name>` of each schedule with a run in progress. */
  private readonly running = new Set<string>()

  constructor(private readonly apps: Pick<Apps, 'callOperation' | 'record' | 'hostRecord'>, private readonly now: () => number = Date.now) {}

  start(): void {
    this.started = true
    void this.arm()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** The active version changed: its schedules get rows, and the rows of schedules it no longer declares go. A new schedule is on. */
  async activated(app: AppRecord, descriptor: AppDescriptor): Promise<void> {
    const rows = new Map((await listSchedules(app.id)).map((row) => [row.name, row]))
    for (const declared of descriptor.schedules) {
      const row = rows.get(declared.name)
      rows.delete(declared.name)
      // A schedule that is already there keeps its switch and its history; its next run follows the trigger it has now.
      await saveSchedule({
        appId: app.id, name: declared.name, enabled: row?.enabled ?? true, nextRunAt: nextRunAt(declared.trigger, this.now()),
        lastRunAt: row?.lastRunAt ?? null, lastOutcome: row?.lastOutcome ?? null, lastError: row?.lastError ?? null,
      })
    }
    for (const gone of rows.keys()) await deleteSchedule(app.id, gone)
    await this.arm()
  }

  /** The store deletes an app's rows with the app. */
  async removed(): Promise<void> {
    await this.arm()
  }

  async list(authority: AppAuthority, idOrSlug: string): Promise<AppScheduleView[]> {
    const app = await this.apps.record(authority, idOrSlug)
    const declared = await this.declarations(app)
    const rows = new Map((await listSchedules(app.id)).map((row) => [row.name, row]))
    return declared.map((schedule): AppScheduleView => {
      const row = rows.get(schedule.name)
      return {
        name: schedule.name, trigger: schedule.trigger, run: schedule.run, enabled: row?.enabled ?? false,
        nextRunAt: row?.enabled ? row.nextRunAt : null, lastRunAt: row?.lastRunAt ?? null, lastOutcome: row?.lastOutcome ?? null, lastError: row?.lastError ?? null,
      }
    })
  }

  /** Pauses a schedule, or turns it on: its next run is then one period from now. */
  async set(authority: AppAuthority, idOrSlug: string, name: string, enabled: boolean): Promise<AppScheduleView[]> {
    const app = await this.apps.record(authority, idOrSlug)
    const { declared, row } = await this.schedule(app, name)
    await saveSchedule({ ...row, enabled, nextRunAt: enabled ? nextRunAt(declared.trigger, this.now()) : row.nextRunAt })
    await this.arm()
    return this.list(authority, idOrSlug)
  }

  /** Runs a schedule's mutation now. Its timer does not move. */
  async runNow(authority: AppAuthority, idOrSlug: string, name: string): Promise<AppScheduleView[]> {
    const app = await this.apps.record(authority, idOrSlug)
    const { declared, row } = await this.schedule(app, name)
    await this.run(app.id, declared, await this.claim(row, row.nextRunAt))
    return this.list(authority, idOrSlug)
  }

  private async declarations(app: AppRecord): Promise<AppScheduleDeclaration[]> {
    const version = app.activeVersion === null ? null : await loadVersion(app.id, app.activeVersion)
    return version?.descriptor.schedules ?? []
  }

  private async schedule(app: AppRecord, name: string): Promise<{ declared: AppScheduleDeclaration; row: AppScheduleRecord }> {
    const declared = (await this.declarations(app)).find((schedule) => schedule.name === name)
    const row = (await listSchedules(app.id)).find((entry) => entry.name === name)
    if (!declared || !row) throw new Error(`This app has no schedule named ${name}.`)
    return { declared, row }
  }

  /** Sets the one timer for the next due schedule. */
  private async arm(retryLater = false): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // A tick in progress sets the timer when it ends.
    if (!this.started || this.ticking) return
    try {
      const dueAt = await nextScheduleDueAt()
      if (dueAt === null) return
      const wait = retryLater ? MAX_WAIT_MS : Math.min(Math.max(dueAt - this.now(), 0), MAX_WAIT_MS)
      this.timer = setTimeout(() => void this.tick(), wait)
      // The scheduler alone does not keep the process alive.
      this.timer.unref?.()
    } catch (error) {
      log.error('app_scheduler_arm_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Runs every schedule that is due. A wake reads the real time, so a late timer after a sleep still claims what is due. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    let failed = false
    try {
      const due = await listDueSchedules(this.now())
      for (const row of due) {
        if (this.running.has(`${row.appId}/${row.name}`)) continue
        const declared = await this.declarationOf(row)
        if (!declared) {
          await deleteSchedule(row.appId, row.name)
          continue
        }
        // The next run is set before this one starts: a host that stops in the middle does not run it twice.
        const claimed = await this.claim(row, nextRunAt(declared.trigger, this.now()))
        void this.run(row.appId, declared, claimed).catch((error) => log.error('app_schedule_run_failed', { appId: row.appId, schedule: row.name, error: error instanceof Error ? error.message : String(error) }))
      }
    } catch (error) {
      failed = true
      log.error('app_scheduler_tick_failed', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.ticking = false
      await this.arm(failed)
    }
  }

  private async declarationOf(row: AppScheduleRecord): Promise<AppScheduleDeclaration | null> {
    const app = await this.apps.hostRecord(row.appId)
    return app ? (await this.declarations(app)).find((schedule) => schedule.name === row.name) ?? null : null
  }

  /** Marks a run as started: the row gets its next run and the time of this one. */
  private async claim(row: AppScheduleRecord, next: number | null): Promise<AppScheduleRecord> {
    const key = `${row.appId}/${row.name}`
    if (this.running.has(key)) throw new Error(`The schedule ${row.name} has a run in progress.`)
    this.running.add(key)
    const claimed = { ...row, nextRunAt: next, lastRunAt: this.now() }
    await saveSchedule(claimed)
    return claimed
  }

  /** One run of a claimed schedule's mutation, as the app's owner. It records how the run ended and does not retry. */
  private async run(appId: string, declared: AppScheduleDeclaration, claimed: AppScheduleRecord): Promise<void> {
    let error: string | null = null
    try {
      await this.apps.callOperation(appId, declared.run, declared.input, { kind: 'schedule', name: declared.name }, null)
      log.info('app_schedule_ran', { appId, schedule: declared.name })
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
      log.warn('app_schedule_failed', { appId, schedule: declared.name, error })
    } finally {
      this.running.delete(`${appId}/${declared.name}`)
    }
    // The switch may have changed while the run was in progress: only the outcome is written over the row as it is now.
    const current = (await listSchedules(appId)).find((entry) => entry.name === declared.name)
    if (current) await saveSchedule({ ...current, lastRunAt: claimed.lastRunAt, lastOutcome: error === null ? 'ok' : 'failed', lastError: error })
    await this.arm()
  }
}
