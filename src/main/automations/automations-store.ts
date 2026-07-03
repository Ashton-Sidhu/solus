import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, rm, } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createLogger } from '../logger'
import { nextRunFrom, validateTrigger } from './automation-schedule'
import type {
  AgentId,
  Automation,
  AutomationAction,
  AutomationCreator,
  AutomationRun,
  AutomationsManifest,
  AutomationTrigger,
} from '../../shared/types'
import { writeJson } from '../project-config/json-file'

const log = createLogger('automations', 'automations-store.ts')

// Local-only persistence under ~/.solus/automations/. The manifest holds every
// automation definition (they are small); each automation's runs live in a
// sidecar `${id}.runs.json` so the manifest stays cheap to read/write.
const ROOT = join(homedir(), '.solus', 'automations')
const MANIFEST_FILE = 'automations-manifest.json'
/** Cap retained runs per automation so the run log can't grow unbounded. */
const MAX_RUNS_PER_AUTOMATION = 50
const MANIFEST_PATH = join(ROOT, MANIFEST_FILE)
const RUNNABLE_AGENT_PROVIDERS = new Set<AgentId>(['claude-code', 'codex'])

function runsPath(id: string): string {
  return join(ROOT, `${id}.runs.json`)
}

// The manifest is read from disk once and then kept in memory as the single
// source of truth. Every mutation edits this one object synchronously and
// persists it — so when the scheduler fires several due automations in the same
// tick, each stamps the same representation instead of racing on its own disk
// snapshot. There is no read-modify-write window to lose, so concurrent fires
// can no longer clobber each other's run stamps.
let manifest: AutomationsManifest | null = null

async function getManifest(): Promise<AutomationsManifest> {
  if (manifest) return manifest
  manifest = await loadManifest()
  return manifest
}

async function loadManifest(): Promise<AutomationsManifest> {
  if (!existsSync(MANIFEST_PATH)) return { version: 1, automations: {} }
  try {
    const loaded = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as AutomationsManifest
    // Backfill: automations written before triggers existed (Phase 1) have no
    // `trigger`. Treat them as manual so reads stay safe without a migration.
    for (const a of Object.values(loaded.automations)) {
      if (!a.trigger) a.trigger = { type: 'manual' }
    }
    return loaded
  } catch (err: any) {
    log.error(`loadManifest failed: ${String(err)}`)
    return { version: 1, automations: {} }
  }
}

// Writes never overlap: each persist waits for the previous one to land, then
// writes whatever the in-memory manifest currently holds. Mutations themselves
// are synchronous in-memory edits, so this only orders the file I/O — it can't
// reintroduce a lost-update race.
let writeChain: Promise<void> = Promise.resolve()
function persist(): Promise<void> {
  const write = () => writeJson(MANIFEST_PATH, manifest)
  const next = writeChain.then(write, write)
  writeChain = next.catch(() => {})
  return next
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
  const m = await getManifest()
  m.automations[automation.id] = automation
  await persist()
  return automation
}

export async function listAutomations(): Promise<Automation[]> {
  const m = await getManifest()
  return Object.values(m.automations).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function loadAutomation(id: string): Promise<Automation | null> {
  const m = await getManifest()
  return m.automations[id] ?? null
}

/** Patch an automation's mutable fields. Action patches merge into the existing
 *  action so callers can update a single field (e.g. just the prompt). Changing
 *  the trigger or the enabled state re-arms `nextRunAt` from now. */
export async function updateAutomation(
  id: string,
  patch: { name?: string; enabled?: boolean; favorite?: boolean; action?: Partial<AutomationAction>; trigger?: AutomationTrigger },
): Promise<Automation | null> {
  const m = await getManifest()
  const existing = m.automations[id]
  if (!existing) return null
  const nextAction = patch.action ? { ...existing.action, ...patch.action } : existing.action
  const nextTrigger = patch.trigger ?? existing.trigger
  assertValidAction(nextAction)
  assertValidTrigger(nextTrigger)
  if (patch.name !== undefined) existing.name = patch.name
  if (patch.enabled !== undefined) existing.enabled = patch.enabled
  if (patch.favorite !== undefined) existing.favorite = patch.favorite
  if (patch.action) existing.action = nextAction
  if (patch.trigger !== undefined) existing.trigger = nextTrigger

  // Re-arm the schedule whenever the trigger or enabled state changes. A paused
  // automation carries no pending fire; a (re)enabled one schedules afresh from
  // now so resuming never replays a fire that elapsed while it was paused.
  if (patch.trigger !== undefined || patch.enabled !== undefined) {
    existing.nextRunAt = existing.enabled ? nextRunFrom(existing.trigger, new Date()) : undefined
  }
  existing.updatedAt = new Date().toISOString()
  await persist()
  return existing
}

export async function deleteAutomation(id: string): Promise<boolean> {
  const m = await getManifest()
  if (!m.automations[id]) return false
  delete m.automations[id]
  await persist()
  const runs = runsPath(id)
  if (existsSync(runs)) await rm(runs).catch(() => {})
  return true
}

// ─── Scheduling ───

/**
 * Claim every enabled, non-manual automation whose `nextRunAt` is due, advancing
 * their schedules in a single manifest write before the caller fires any runs.
 * A one-time automation is consumed (disabled, no next fire); recurring ones
 * schedule their next occurrence from `now`.
 */
export async function claimDueAutomations(now = new Date()): Promise<Automation[]> {
  const m = await getManifest()
  const nowIso = now.toISOString()
  const due = Object.values(m.automations).filter(
    (a) => a.enabled && a.trigger.type !== 'manual' && !!a.nextRunAt && a.nextRunAt <= nowIso,
  )
  if (due.length === 0) return []

  for (const a of due) {
    if (a.trigger.type === 'once') {
      a.nextRunAt = undefined
      a.enabled = false
    } else {
      a.nextRunAt = nextRunFrom(a.trigger, now)
    }
    a.updatedAt = nowIso
  }
  await persist()
  return due
}

// ─── Runs ───

/** Runs in stored (oldest-first) order, as persisted. Internal: mutators rely on
 *  this order so the cap trim drops the oldest, not the newest. */
async function readRuns(id: string): Promise<AutomationRun[]> {
  const path = runsPath(id)
  if (!existsSync(path)) return []
  try {
    return JSON.parse(await readFile(path, 'utf8')) as AutomationRun[]
  } catch (err: any) {
    log.error(`readRuns(${id}) failed: ${String(err)}`)
    return []
  }
}

/** Public accessor: newest first for the UI. */
export async function listRuns(id: string): Promise<AutomationRun[]> {
  return (await readRuns(id)).reverse()
}

/** Record a fresh run in the 'running' state and stamp it on the automation. */
export async function startRun(automationId: string): Promise<AutomationRun> {
  const run: AutomationRun = {
    id: randomUUID(),
    automationId,
    startedAt: new Date().toISOString(),
    status: 'running',
  }
  // Each automation owns its own runs file, so concurrent fires of *different*
  // automations never touch the same one.
  const runs = await readRuns(automationId)
  runs.push(run)
  // Newest last; trim oldest beyond the cap.
  await writeJson(runsPath(automationId), runs.slice(-MAX_RUNS_PER_AUTOMATION))

  // Stamp the run onto the automation. Note we do NOT bump `updatedAt` here —
  // running is not an edit, so a fired automation (incl. background scheduler
  // fires) must not reorder the updatedAt-sorted list.
  const m = await getManifest()
  const a = m.automations[automationId]
  if (a) {
    a.lastRunId = run.id
    a.lastRunStatus = 'running'
    a.lastRunAt = run.startedAt
    await persist()
  }
  return run
}

/** Finalize a run with its outcome and mirror the status onto the automation. */
export async function finishRun(
  automationId: string,
  runId: string,
  outcome: Pick<AutomationRun, 'status' | 'output' | 'agentSessionId' | 'error'>,
): Promise<void> {
  const runs = await readRuns(automationId)
  const run = runs.find((r) => r.id === runId)
  if (run) {
    Object.assign(run, outcome, { finishedAt: new Date().toISOString() })
    await writeJson(runsPath(automationId), runs)
  }
  const m = await getManifest()
  const a = m.automations[automationId]
  if (a && a.lastRunId === runId) {
    a.lastRunStatus = outcome.status
    await persist()
  }
}

export async function loadRun(automationId: string, runId: string): Promise<AutomationRun | null> {
  const runs = await readRuns(automationId)
  return runs.find((r) => r.id === runId) ?? null
}
