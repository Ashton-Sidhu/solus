import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getDb, withTx } from '../db'
import { createLogger } from '../logger'
import { nextRunFrom, validateTrigger } from './automation-schedule'
import type {
  AgentId,
  Automation,
  AutomationAction,
  AutomationCreator,
  AutomationRun,
  AutomationRunStatus,
  AutomationsChangedEvent,
  AutomationTrigger,
} from '../../shared/types'

const log = createLogger('automations', 'automations-store.ts')

/** Cap retained runs per automation so the run log can't grow unbounded. */
const MAX_RUNS_PER_AUTOMATION = 50
/** Cap the stored output of a single run. The full transcript lives in the
 *  spawned session anyway; together with the run cap this bounds run storage. */
const MAX_RUN_OUTPUT_CHARS = 20_000
const RUNNABLE_AGENT_PROVIDERS = new Set<AgentId>(['claude-code', 'codex'])

interface AutomationRow {
  id: string
  name: string
  enabled: number
  favorite: number | null
  action: string
  trigger_config: string
  next_run_at: number | null
  last_run: string | null
  created_at: number
  updated_at: number
}

interface AutomationRunRow {
  id: string
  automation_id: string
  started_at: number
  finished_at: number | null
  status: AutomationRunStatus
  output: string | null
  data: string | null
}

// Every mutation is announced so the server can broadcast it to all clients —
// scheduled fires happen with no renderer in the loop, so push is the only way
// the UI learns a run started/finished without reopening the page.
type AutomationsChangedListener = (event: AutomationsChangedEvent) => void
let changedListener: AutomationsChangedListener | null = null
export function setAutomationsChangedListener(listener: AutomationsChangedListener): void {
  changedListener = listener
}
function emitChanged(event: AutomationsChangedEvent): void {
  try {
    changedListener?.(event)
  } catch (err: any) {
    log.error(`automations-changed listener failed: ${String(err)}`)
  }
}

function epochMs(value: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid automation timestamp: ${value}`)
  return timestamp
}

function isoTime(value: number): string {
  return new Date(value).toISOString()
}

function automationFromRow(row: AutomationRow): Automation {
  const metadata = row.last_run ? JSON.parse(row.last_run) as Record<string, unknown> : {}
  return {
    ...metadata,
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    ...(row.favorite === null ? {} : { favorite: row.favorite === 1 }),
    action: JSON.parse(row.action) as AutomationAction,
    trigger: JSON.parse(row.trigger_config) as AutomationTrigger,
    ...(row.next_run_at === null ? {} : { nextRunAt: isoTime(row.next_run_at) }),
    createdAt: isoTime(row.created_at),
    updatedAt: isoTime(row.updated_at),
  } as Automation
}

function runFromRow(row: AutomationRunRow): AutomationRun {
  const data = row.data ? JSON.parse(row.data) as Record<string, unknown> : {}
  return {
    ...data,
    id: row.id,
    automationId: row.automation_id,
    startedAt: isoTime(row.started_at),
    ...(row.finished_at === null ? {} : { finishedAt: isoTime(row.finished_at) }),
    status: row.status,
    ...(row.output === null ? {} : { output: row.output }),
  } as AutomationRun
}

function writeAutomation(db: DatabaseSync, automation: Automation): void {
  const {
    id,
    name,
    enabled,
    favorite,
    action,
    trigger,
    nextRunAt,
    createdAt,
    updatedAt,
    lastRunId,
    lastRunStatus,
    lastRunAt,
    ...metadata
  } = automation
  const lastRun = {
    ...metadata,
    ...(lastRunId === undefined ? {} : { lastRunId }),
    ...(lastRunStatus === undefined ? {} : { lastRunStatus }),
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
  }
  db.prepare(`
    INSERT INTO automations(
      id, name, enabled, favorite, action, trigger_config, next_run_at,
      last_run, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      favorite = excluded.favorite,
      action = excluded.action,
      trigger_config = excluded.trigger_config,
      next_run_at = excluded.next_run_at,
      last_run = excluded.last_run,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `).run(
    id,
    name,
    enabled ? 1 : 0,
    favorite === undefined ? null : favorite ? 1 : 0,
    JSON.stringify(action),
    JSON.stringify(trigger),
    nextRunAt === undefined ? null : epochMs(nextRunAt),
    JSON.stringify(lastRun),
    epochMs(createdAt),
    epochMs(updatedAt),
  )
}

function writeRun(db: DatabaseSync, run: AutomationRun): void {
  const {
    id,
    automationId,
    startedAt,
    finishedAt,
    status,
    output,
    ...data
  } = run
  db.prepare(`
    INSERT INTO automation_runs(
      id, automation_id, started_at, finished_at, status, output, data
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      automation_id = excluded.automation_id,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      status = excluded.status,
      output = excluded.output,
      data = excluded.data
  `).run(
    id,
    automationId,
    epochMs(startedAt),
    finishedAt === undefined ? null : epochMs(finishedAt),
    status,
    output ?? null,
    JSON.stringify(data),
  )
}

function pruneRuns(db: DatabaseSync, automationId: string): void {
  db.prepare(`
    DELETE FROM automation_runs
    WHERE automation_id = ?
      AND id NOT IN (
        SELECT id
        FROM automation_runs
        WHERE automation_id = ?
        ORDER BY started_at DESC, rowid DESC
        LIMIT ?
      )
  `).run(automationId, automationId, MAX_RUNS_PER_AUTOMATION)
}

function database(): DatabaseSync {
  return getDb()
}

function assertValidAction(action: AutomationAction): void {
  if (!RUNNABLE_AGENT_PROVIDERS.has(action.agentProvider)) {
    throw new Error(`Unsupported automation agent provider: ${action.agentProvider}`)
  }
  if (!action.prompt.trim()) throw new Error('Automation prompt cannot be empty.')
  if (!action.cwd.trim()) throw new Error('Automation cwd cannot be empty.')
}

function assertValidTrigger(trigger: AutomationTrigger): void {
  const err = validateTrigger(trigger)
  if (err) throw new Error(err)
}

export async function createAutomation(
  name: string,
  action: AutomationAction,
  createdBy: AutomationCreator,
  enabled = true,
  trigger: AutomationTrigger = { type: 'manual' },
): Promise<Automation> {
  assertValidAction(action)
  assertValidTrigger(trigger)
  const now = new Date()
  const nowIso = now.toISOString()
  const automation: Automation = {
    id: randomUUID(),
    name,
    enabled,
    action,
    trigger,
    // Only arm a next fire when the automation is enabled; a paused automation
    // has nothing pending until it's resumed.
    nextRunAt: enabled ? nextRunFrom(trigger, now) : undefined,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy,
  }
  writeAutomation(database(), automation)
  emitChanged({ kind: 'saved', automation })
  return automation
}

export async function listAutomations(): Promise<Automation[]> {
  const rows = database().prepare(`
    SELECT *
    FROM automations
    ORDER BY updated_at DESC
  `).all() as unknown as AutomationRow[]
  return rows.map(automationFromRow)
}

export async function loadAutomation(id: string): Promise<Automation | null> {
  const row = database().prepare('SELECT * FROM automations WHERE id = ?').get(id) as unknown as AutomationRow | undefined
  return row ? automationFromRow(row) : null
}

/** Patch an automation's mutable fields. Action patches merge into the existing
 *  action so callers can update a single field (e.g. just the prompt). Changing
 *  the trigger or the enabled state re-arms `nextRunAt` from now. */
export async function updateAutomation(
  id: string,
  patch: { name?: string; enabled?: boolean; favorite?: boolean; action?: Partial<AutomationAction>; trigger?: AutomationTrigger },
): Promise<Automation | null> {
  const db = database()
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as unknown as AutomationRow | undefined
  if (!row) return null
  const existing = automationFromRow(row)
  const nextAction = patch.action ? { ...existing.action, ...patch.action } : existing.action
  const nextTrigger = patch.trigger ?? existing.trigger
  assertValidAction(nextAction)
  assertValidTrigger(nextTrigger)
  const enabledChanged = patch.enabled !== undefined && patch.enabled !== existing.enabled
  if (patch.name !== undefined) existing.name = patch.name
  if (patch.enabled !== undefined) existing.enabled = patch.enabled
  if (patch.favorite !== undefined) existing.favorite = patch.favorite
  if (patch.action) existing.action = nextAction
  if (patch.trigger !== undefined) existing.trigger = nextTrigger

  // Re-arm the schedule whenever the trigger or enabled state actually changes.
  // A paused automation carries no pending fire; a re-enabled one schedules
  // afresh from now so resuming never replays a fire that elapsed while paused.
  if (patch.trigger !== undefined || enabledChanged) {
    existing.nextRunAt = existing.enabled ? nextRunFrom(existing.trigger, new Date()) : undefined
  }
  existing.updatedAt = new Date().toISOString()
  writeAutomation(db, existing)
  emitChanged({ kind: 'saved', automation: existing })
  return existing
}

export async function deleteAutomation(id: string): Promise<boolean> {
  const db = database()
  const deleted = withTx(() => {
    const result = db.prepare('DELETE FROM automations WHERE id = ?').run(id)
    return result.changes > 0
  })
  if (deleted) emitChanged({ kind: 'deleted', automationId: id })
  return deleted
}

// ─── Scheduling ───

/**
 * Claim every enabled, non-manual automation whose `nextRunAt` is due, advancing
 * their schedules atomically before the caller fires any runs. A one-time
 * automation is consumed (disabled, no next fire); recurring ones schedule
 * their next occurrence from `now`.
 *
 * `isRunning` lets the scheduler skip automations with a run still in flight:
 * a skipped automation keeps its past-due `nextRunAt`, so it's re-claimed on
 * the first tick after the run finishes rather than stacking overlapping runs.
 */
export async function claimDueAutomations(
  now = new Date(),
  isRunning?: (automationId: string) => boolean,
): Promise<Automation[]> {
  const db = database()
  const nowMs = now.getTime()
  const nowIso = now.toISOString()
  const due = withTx(() => {
    const rows = db.prepare(`
      SELECT *
      FROM automations
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    `).all(nowMs) as unknown as AutomationRow[]
    const claimed = rows
      .map(automationFromRow)
      .filter((automation) => automation.trigger.type !== 'manual' && !isRunning?.(automation.id))

    for (const automation of claimed) {
      if (automation.trigger.type === 'once') {
        automation.nextRunAt = undefined
        automation.enabled = false
      } else {
        automation.nextRunAt = nextRunFrom(automation.trigger, now)
      }
      automation.updatedAt = nowIso
      writeAutomation(db, automation)
    }
    return claimed
  })
  for (const automation of due) emitChanged({ kind: 'saved', automation })
  return due
}

// ─── Runs ───

/** Public accessor: newest first for the UI. */
export async function listRuns(id: string): Promise<AutomationRun[]> {
  const rows = database().prepare(`
    SELECT *
    FROM automation_runs
    WHERE automation_id = ?
    ORDER BY started_at DESC, rowid DESC
  `).all(id) as unknown as AutomationRunRow[]
  return rows.map(runFromRow)
}

/** Record a fresh run in the 'running' state and stamp it on the automation. */
export async function startRun(automationId: string): Promise<AutomationRun> {
  const run: AutomationRun = {
    id: randomUUID(),
    automationId,
    startedAt: new Date().toISOString(),
    status: 'running',
  }
  const db = database()
  const automation = withTx(() => {
    writeRun(db, run)
    pruneRuns(db, automationId)

    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId) as unknown as AutomationRow | undefined
    if (!row) return null
    const stored = automationFromRow(row)
    // Running is not an edit, so do not bump updatedAt and reorder the list.
    stored.lastRunId = run.id
    stored.lastRunStatus = 'running'
    stored.lastRunAt = run.startedAt
    writeAutomation(db, stored)
    return stored
  })
  if (automation) emitChanged({ kind: 'run-started', automation, run })
  return run
}

/** Link a still-running automation record to its provider session as soon as
 *  session_init arrives, so clients can open the live transcript before the
 *  run reaches a terminal state. */
export async function attachRunSession(
  automationId: string,
  runId: string,
  agentSessionId: string,
  branch?: string,
  worktreePath?: string,
): Promise<void> {
  const db = database()
  const result = withTx(() => {
    const runRow = db.prepare(`
      SELECT *
      FROM automation_runs
      WHERE automation_id = ? AND id = ?
    `).get(automationId, runId) as unknown as AutomationRunRow | undefined
    const run = runRow ? runFromRow(runRow) : null
    if (!run || run.status !== 'running') return { automation: null, run: null }
    run.agentSessionId = agentSessionId
    if (branch) run.branch = branch
    if (worktreePath) run.worktreePath = worktreePath
    writeRun(db, run)

    const automationRow = db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId) as unknown as AutomationRow | undefined
    return {
      automation: automationRow ? automationFromRow(automationRow) : null,
      run,
    }
  })
  if (result.automation && result.run) {
    emitChanged({ kind: 'run-updated', automation: result.automation, run: result.run })
  }
}

/** Finalize a run with its outcome and mirror the status onto the automation. */
export async function finishRun(
  automationId: string,
  runId: string,
  outcome: Pick<AutomationRun, 'status' | 'output' | 'agentSessionId' | 'error' | 'branch'>,
): Promise<void> {
  if (outcome.output && outcome.output.length > MAX_RUN_OUTPUT_CHARS) {
    outcome = { ...outcome, output: `${outcome.output.slice(0, MAX_RUN_OUTPUT_CHARS)}\n… [output truncated]` }
  }

  const db = database()
  const result = withTx(() => {
    const runRow = db.prepare(`
      SELECT *
      FROM automation_runs
      WHERE automation_id = ? AND id = ?
    `).get(automationId, runId) as unknown as AutomationRunRow | undefined
    const finished = runRow ? runFromRow(runRow) : null
    if (finished) {
      Object.assign(finished, outcome, { finishedAt: new Date().toISOString() })
      writeRun(db, finished)
    }

    const automationRow = db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId) as unknown as AutomationRow | undefined
    const automation = automationRow ? automationFromRow(automationRow) : null
    if (automation?.lastRunId === runId) {
      automation.lastRunStatus = outcome.status
      writeAutomation(db, automation)
    }
    return { automation, finished }
  })
  if (result.automation && result.finished) {
    emitChanged({ kind: 'run-finished', automation: result.automation, run: result.finished })
  }
}

export async function loadRun(automationId: string, runId: string): Promise<AutomationRun | null> {
  const row = database().prepare(`
    SELECT *
    FROM automation_runs
    WHERE automation_id = ? AND id = ?
  `).get(automationId, runId) as unknown as AutomationRunRow | undefined
  return row ? runFromRow(row) : null
}
