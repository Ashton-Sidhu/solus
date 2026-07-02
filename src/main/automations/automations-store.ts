import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, rm, } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createLogger } from '../logger'
import { nextRunFrom, validateTrigger } from './automation-schedule'
import type {
  Automation,
  AutomationAction,
  AutomationCreator,
  AutomationRun,
  AutomationsChangedEvent,
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
/** Cap the stored output of a single run. The full transcript lives in the
 *  spawned session anyway; together with the run cap this bounds each sidecar. */
const MAX_RUN_OUTPUT_CHARS = 20_000
const MANIFEST_PATH = join(ROOT, MANIFEST_FILE)

function runsPath(id: string): string {
  return join(ROOT, `${id}.runs.json`)
}

// Nothing else creates ~/.solus/automations (the app only mkdirs ~/.solus), so
// every write path funnels through this memoized mkdir before touching disk.
let rootReady: Promise<unknown> | null = null
function ensureRoot(): Promise<unknown> {
  return (rootReady ??= mkdir(ROOT, { recursive: true }))
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
  const write = async () => {
    await ensureRoot()
    await writeJson(MANIFEST_PATH, manifest)
  }
  const next = writeChain.then(write, write)
  writeChain = next.catch(() => {})
  return next
}

export async function createAutomation(
  name: string,
  action: AutomationAction,
  createdBy: AutomationCreator,
  enabled = true,
  trigger: AutomationTrigger = { type: 'manual' },
): Promise<Automation> {
  // Reject malformed triggers at the single choke point every caller funnels
  // through (agent tools pre-validate for a friendlier message; the renderer
  // relies on this throw). Otherwise a typo'd cron would save fine and just
  // never fire.
  const triggerError = validateTrigger(trigger)
  if (triggerError) throw new Error(triggerError)
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
  emitChanged({ kind: 'saved', automation })
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
  if (patch.trigger !== undefined) {
    const triggerError = validateTrigger(patch.trigger)
    if (triggerError) throw new Error(triggerError)
  }
  const enabledChanged = patch.enabled !== undefined && patch.enabled !== existing.enabled
  if (patch.name !== undefined) existing.name = patch.name
  if (patch.enabled !== undefined) existing.enabled = patch.enabled
  if (patch.favorite !== undefined) existing.favorite = patch.favorite
  if (patch.action) existing.action = { ...existing.action, ...patch.action }
  if (patch.trigger !== undefined) existing.trigger = patch.trigger

  // Re-arm the schedule whenever the trigger or enabled state actually changes.
  // A paused automation carries no pending fire; a re-enabled one schedules
  // afresh from now so resuming never replays a fire that elapsed while it was
  // paused. A no-op `enabled: true` patch must NOT re-arm — that would push out
  // a pending fire.
  if (patch.trigger !== undefined || enabledChanged) {
    existing.nextRunAt = existing.enabled ? nextRunFrom(existing.trigger, new Date()) : undefined
  }
  existing.updatedAt = new Date().toISOString()
  await persist()
  emitChanged({ kind: 'saved', automation: existing })
  return existing
}

export async function deleteAutomation(id: string): Promise<boolean> {
  const m = await getManifest()
  if (!m.automations[id]) return false
  delete m.automations[id]
  await persist()
  const runs = runsPath(id)
  if (existsSync(runs)) await rm(runs).catch(() => {})
  emitChanged({ kind: 'deleted', automationId: id })
  return true
}

// ─── Scheduling ───

/**
 * Claim every enabled, non-manual automation whose `nextRunAt` is due, advancing
 * their schedules in a single manifest write before the caller fires any runs.
 * A one-time automation is consumed (disabled, no next fire); recurring ones
 * schedule their next occurrence from `now`.
 *
 * `isRunning` lets the scheduler skip automations with a run still in flight:
 * a skipped automation keeps its past-due `nextRunAt`, so it's re-claimed on
 * the first tick after the run finishes rather than stacking overlapping runs
 * (two unattended agents mutating the same cwd).
 */
export async function claimDueAutomations(
  now = new Date(),
  isRunning?: (automationId: string) => boolean,
): Promise<Automation[]> {
  const m = await getManifest()
  const nowIso = now.toISOString()
  const due = Object.values(m.automations).filter(
    (a) =>
      a.enabled &&
      a.trigger.type !== 'manual' &&
      !!a.nextRunAt &&
      a.nextRunAt <= nowIso &&
      !isRunning?.(a.id),
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
  for (const a of due) emitChanged({ kind: 'saved', automation: a })
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

// Runs files get the same lost-update protection as the manifest, per file:
// each read-modify-write waits for the previous one on that automation to land.
// Without this, a run finishing while another starts (or two finishing close
// together) would clobber each other's stamps. Different automations never
// contend — each owns its own sidecar and its own chain.
const runsChains = new Map<string, Promise<unknown>>()
function mutateRuns<T>(id: string, mutate: (runs: AutomationRun[]) => T): Promise<T> {
  const op = async () => {
    const runs = await readRuns(id)
    const result = mutate(runs)
    await ensureRoot()
    await writeJson(runsPath(id), runs.slice(-MAX_RUNS_PER_AUTOMATION))
    return result
  }
  const next = (runsChains.get(id) ?? Promise.resolve()).then(op, op)
  runsChains.set(id, next.catch(() => {}))
  return next
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
  await mutateRuns(automationId, (runs) => runs.push(run))

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
    emitChanged({ kind: 'run-started', automation: a, run })
  }
  return run
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
  const finished = await mutateRuns(automationId, (runs): AutomationRun | null => {
    const run = runs.find((r) => r.id === runId)
    if (!run) return null
    Object.assign(run, outcome, { finishedAt: new Date().toISOString() })
    return run
  })
  const m = await getManifest()
  const a = m.automations[automationId]
  if (a && a.lastRunId === runId) {
    a.lastRunStatus = outcome.status
    await persist()
  }
  if (a && finished) emitChanged({ kind: 'run-finished', automation: a, run: finished })
}

export async function loadRun(automationId: string, runId: string): Promise<AutomationRun | null> {
  const runs = await readRuns(automationId)
  return runs.find((r) => r.id === runId) ?? null
}
