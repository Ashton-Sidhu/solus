import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { APP_MODEL_MAX_TIMEOUT_SECONDS } from '@solus/contracts/app-models'
import type { AppCaller, AppDescriptor, AppRunDetail, AppRunState, AppRunView, AppStepKind, AppStepView } from '@solus/contracts/apps'
import { listCalls, type AppRecord, type AppVersionRecord } from '../data/apps/app-store'
import {
  countSteps,
  deleteUnfinishedSteps,
  insertRun,
  listOpenRuns,
  listOpenRunsOf,
  listRuns,
  listSteps,
  loadRun,
  loadRunByKey,
  pruneRuns,
  saveRun,
  saveStep,
  type AppRunRecord,
  type AppStepRecord,
} from '../data/apps/app-workflow-store'
import { createLogger } from '../logger'
import { emitAppActivity } from './app-events'
import { beginCall } from './app-observability'
import { stepTries, type AppRunCallSpans } from './app-step-tries'
import { AppOperationError, RUN_QUIET_MS, type AppExecution, type AppRun, type AppRunners } from './app-runners'
import type { AppArrivedSignal } from './app-signals'
import type { StoredValue } from './app-storage'
import type { AppAuthority, AppLifecyclePart } from './apps'

const log = createLogger('apps', 'app-workflows.ts')

/**
 * Workflows (docs/plans/apps.md §8.3): a function of an app that the host
 * runs to its end. The host keeps a receipt for each step. When a run starts
 * again (after a sleep, a deploy, a stop, or a restart of the host), its
 * function runs from the top in the runner and each finished step answers
 * from its receipt. A step that was in progress runs again: at least once,
 * never exactly once (decision 23).
 *
 * This class owns the runs: their states, their receipts, the timer that
 * wakes a sleeping run, and what happens when the runner stops under one.
 */

const MAX_WAIT_MS = 5 * 60_000
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_INTERRUPTIONS = 5
const OPERATION_STEP_MS = 15 * 60_000
const WAIT_IN_PROCESS_MS = 60_000
const RESULT_PREVIEW_CHARACTERS = 4096
/** The calls of one run that its detail reads for the tries of its steps. */
const RUN_LOG_CALLS = 200
const PRUNE_EVERY_RUNS = 50

/** An app that can run now, with what its runner runs. */
export interface AppRunnable {
  app: AppRecord
  version: AppVersionRecord
  run: AppRun
}

/** Result of looking up the runnable version for a workflow run. */
export type AppRunnableLookup =
  | { kind: 'ready'; target: AppRunnable }
  | { kind: 'waiting' }
  | { kind: 'missing'; version: number }

/** What the workflows part needs of the Apps service. */
export interface AppWorkflowHost {
  record(authority: AppAuthority, idOrSlug: string): Promise<AppRecord>
  /** The app with the requested pinned version (or active version when null/omitted). */
  runnable(appId: string, version?: number | null): Promise<AppRunnableLookup>
  /** One call of an operation for a step, as the app's owner, on the run's version when given. */
  callOperation(appId: string, operation: string, input: StoredValue, caller: AppCaller, authority: null, version?: AppVersionRecord): Promise<StoredValue>
  /** What a step asks that is not a receipt: an integration tool, an app file. */
  hostRequest(app: AppRecord, version: AppVersionRecord, method: string, input: StoredValue, caller: AppCaller): Promise<StoredValue>
  /** Gives the signals of a step that succeeded to their signal actions. */
  signalsEmitted(app: AppRecord, descriptor: AppDescriptor, signals: readonly AppArrivedSignal[], runId: string): Promise<void>
  /** A run finished, ran again, or was dismissed: what needs the owner can differ. */
  runsChanged(appId: string): void
}

/** One run as an operation of the app reads it (`ctx.workflows`). */
export interface AppWorkflowRunFace {
  id: string
  workflow: string
  state: AppRunState
  startedAt: number
  finishedAt: number | null
  error: string | null
  result: StoredValue
}

const stepNameSchema = z.string().min(1).max(200)
const emittedSchema = z.array(z.object({ id: z.string(), name: z.string(), payload: z.json() })).max(100)
const beginSchema = z.object({ name: stepNameSchema, attempt: z.number().int().min(1), timeoutMs: z.number().min(0) })
const retrySchema = z.object({ name: stepNameSchema, attempt: z.number().int().min(1), error: z.string(), waitMs: z.number().min(0) })
const doneSchema = z.object({ name: stepNameSchema, result: z.json(), signals: emittedSchema.default([]) })
const failSchema = z.object({ name: stepNameSchema, error: z.string() })
const sleepSchema = z.object({ name: stepNameSchema, wakeAt: z.number() })
const operationSchema = z.object({ name: stepNameSchema, kind: z.enum(['query', 'mutation']), operation: z.string().min(1).max(64), input: z.json() })
/** `step.model`: the request is checked where the call starts (`AppModelCalls`). */
const modelStepSchema = z.object({ name: stepNameSchema, request: z.json() })

function face(run: AppRunRecord): AppWorkflowRunFace {
  return { id: run.id, workflow: run.workflow, state: run.state, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, result: run.result }
}

function stepView(step: AppStepRecord, calls: readonly AppRunCallSpans[]): AppStepView {
  const text = step.result === null ? null : JSON.stringify(step.result)
  return {
    name: step.name, kind: step.kind, state: step.state, attempts: step.attempts, startedAt: step.startedAt, finishedAt: step.finishedAt, wakeAt: step.wakeAt, error: step.error,
    result: text === null ? null : text.slice(0, RESULT_PREVIEW_CHARACTERS), resultTruncated: text !== null && text.length > RESULT_PREVIEW_CHARACTERS,
    ...(step.kind === 'do' ? stepTries(calls, step.name) : { tries: [], retryPolicy: null }),
  }
}

export class AppWorkflows implements AppLifecyclePart {
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  /** The runs whose function is in a runner now. */
  private readonly driving = new Set<string>()
  private finishedCount = 0

  constructor(private readonly host: AppWorkflowHost, private readonly runners: Pick<AppRunners, 'runWorkflow'>, private readonly now: () => number = Date.now) {}

  /** The host started: each run that was in progress starts again, and each sleeping run gets its wake. */
  start(): void {
    this.started = true
    void this.tick()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** The active version changed: drive any open runs that are not already in flight (each stays on its pinned version). */
  async activated(app: AppRecord): Promise<void> {
    await this.resume(app.id)
  }

  /** The store deletes an app's runs with the app. */
  async removed(): Promise<void> {}

  /** Starts each open run of an app again: the app was started, or its runner changed. */
  async resume(appId: string): Promise<void> {
    if (!this.started) return
    for (const run of await listOpenRunsOf(appId)) if (run.state === 'running') void this.drive(run.id)
    await this.arm()
  }

  // ─── What an operation of the app does (`ctx.workflows`) ───

  async startRun(app: AppRecord, version: AppVersionRecord, workflow: string, input: StoredValue, key: string | null, startedBy: AppCaller): Promise<AppWorkflowRunFace> {
    const { descriptor } = version
    if (!descriptor.workflows.some((declared) => declared.name === workflow)) {
      throw new Error(`This app has no workflow named ${workflow}. It has: ${descriptor.workflows.map((declared) => declared.name).join(', ') || 'none'}.`)
    }
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) throw new Error('The input of a run is at most 1 MiB. Keep large data in an app file or in the database, and pass its id.')
    if (key !== null) {
      if (key.length < 1 || key.length > 128) throw new Error('The key of a run is 1 to 128 characters.')
      const existing = await loadRunByKey(app.id, workflow, key)
      if (existing) {
        if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error(`A run of ${workflow} with the key ${key} exists with another input. Use another key.`)
        return face(existing)
      }
    }
    const at = this.now()
    const run: AppRunRecord = {
      id: randomUUID(), appId: app.id, workflow, input, state: 'running', key, result: null, error: null, wakeAt: null, startedBy,
      interruptions: 0, startedAt: at, updatedAt: at, finishedAt: null, version: version.number, dismissedAt: null,
    }
    await insertRun(run)
    emitAppActivity(app.id, 'runs')
    log.info('app_run_started', { appId: app.id, runId: run.id, workflow })
    void this.drive(run.id)
    return face(run)
  }

  async getRun(app: AppRecord, runId: string): Promise<AppWorkflowRunFace | null> {
    const run = await loadRun(runId)
    return run && run.appId === app.id ? face(run) : null
  }

  async listRunFaces(app: AppRecord, options: { workflow: string | null; limit: number | null }): Promise<AppWorkflowRunFace[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100))
    return (await listRuns(app.id, limit, options.workflow ? { workflow: options.workflow } : {})).map(face)
  }

  async terminateRun(app: AppRecord, runId: string): Promise<AppWorkflowRunFace> {
    const run = await loadRun(runId)
    if (!run || run.appId !== app.id) throw new Error('This app has no run with this id.')
    if (run.state !== 'running' && run.state !== 'sleeping') return face(run)
    // A step in progress ends by itself: its next request to the host is refused.
    return face(await this.finish(run, 'terminated', null, 'The run was ended.'))
  }

  // ─── What the owner reads and does ───

  async list(authority: AppAuthority, idOrSlug: string, options: { state?: AppRunState; limit?: number }): Promise<AppRunView[]> {
    const app = await this.host.record(authority, idOrSlug)
    const runs = await listRuns(app.id, options.limit ?? 50, options.state ? { state: options.state } : {})
    const counts = await countSteps(runs.map((run) => run.id))
    return runs.map((run) => this.view(run, counts.get(run.id) ?? 0))
  }

  async read(authority: AppAuthority, idOrSlug: string, runId: string): Promise<AppRunDetail | null> {
    const app = await this.host.record(authority, idOrSlug)
    const run = await loadRun(runId)
    return run && run.appId === app.id ? this.detail(run) : null
  }

  async terminate(authority: AppAuthority, idOrSlug: string, runId: string): Promise<AppRunDetail> {
    const app = await this.host.record(authority, idOrSlug)
    await this.terminateRun(app, runId)
    return this.detail(await this.required(app, runId))
  }

  /** Starts a failed run again on the current active version: its failed step runs again, and its finished steps answer from their receipts. */
  async retry(authority: AppAuthority, idOrSlug: string, runId: string): Promise<AppRunDetail> {
    const app = await this.host.record(authority, idOrSlug)
    const run = await this.required(app, runId)
    if (run.state !== 'failed') throw new Error('Only a run that failed can run again.')
    await deleteUnfinishedSteps(run.id)
    await saveRun({ ...run, state: 'running', error: null, result: null, wakeAt: null, interruptions: 0, updatedAt: this.now(), finishedAt: null, version: app.activeVersion, dismissedAt: null })
    emitAppActivity(app.id, 'runs')
    this.host.runsChanged(app.id)
    void this.drive(run.id)
    return this.detail(await this.required(app, runId))
  }

  /** The owner does not want a failed run back: it no longer needs them, and it stays in the history. */
  async dismiss(authority: AppAuthority, idOrSlug: string, runId: string): Promise<AppRunDetail> {
    const app = await this.host.record(authority, idOrSlug)
    const run = await this.required(app, runId)
    if (run.state !== 'failed') throw new Error('Only a run that failed can be dismissed.')
    if (run.dismissedAt === null) {
      await saveRun({ ...run, dismissedAt: this.now() })
      emitAppActivity(app.id, 'runs')
      this.host.runsChanged(app.id)
    }
    return this.detail(await this.required(app, runId))
  }

  private async required(app: AppRecord, runId: string): Promise<AppRunRecord> {
    const run = await loadRun(runId)
    if (!run || run.appId !== app.id) throw new Error('This app has no run with this id.')
    return run
  }

  private view(run: AppRunRecord, stepCount: number): AppRunView {
    return {
      id: run.id, workflow: run.workflow, state: run.state, startedAt: run.startedAt, updatedAt: run.updatedAt, finishedAt: run.finishedAt,
      wakeAt: run.state === 'sleeping' ? run.wakeAt : null, error: run.error, startedBy: run.startedBy, stepCount, version: run.version, dismissedAt: run.dismissedAt,
    }
  }

  private async detail(run: AppRunRecord): Promise<AppRunDetail> {
    const steps = await listSteps(run.id)
    // The tries of each step are the spans of the run's log: the calls that ran its function.
    const calls = steps.some((step) => step.kind === 'do') ? await listCalls(run.appId, RUN_LOG_CALLS, { runId: run.id }) : []
    return { ...this.view(run, steps.length), input: JSON.stringify(run.input), result: run.result === null ? null : JSON.stringify(run.result), key: run.key, steps: steps.map((step) => stepView(step, calls)) }
  }

  // ─── The engine ───

  /** Sets the one timer: for the next sleeping run that is due, or sooner for a run that waits to start again. */
  private async arm(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.started) return
    try {
      const open = await listOpenRuns()
      if (open.length === 0) return
      const waits = open.filter((run) => !this.driving.has(run.id)).map((run) => (run.state === 'sleeping' ? Math.max((run.wakeAt ?? 0) - this.now(), 0) : MAX_WAIT_MS))
      if (waits.length === 0) return
      this.timer = setTimeout(() => void this.tick(), Math.min(...waits, MAX_WAIT_MS))
      // The wake timer alone does not keep the process alive.
      this.timer.unref?.()
    } catch (error) {
      log.error('app_run_arm_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Starts every run that is due: a sleeping run whose time came, and a run that is `running` with no function in a runner. */
  async tick(): Promise<void> {
    try {
      for (const run of await listOpenRuns()) {
        if (run.state === 'sleeping' && (run.wakeAt ?? 0) > this.now()) continue
        void this.drive(run.id)
      }
    } catch (error) {
      log.error('app_run_tick_failed', { error: error instanceof Error ? error.message : String(error) })
    }
    await this.arm()
  }

  /** Runs the function of one run from its top, once. Never throws. */
  private async drive(runId: string): Promise<void> {
    if (this.driving.has(runId)) return
    this.driving.add(runId)
    try {
      await this.execute(runId)
    } catch (error) {
      log.error('app_run_drive_failed', { runId, error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.driving.delete(runId)
      await this.arm()
    }
  }

  private async execute(runId: string): Promise<void> {
    const loaded = await loadRun(runId)
    if (!loaded || (loaded.state !== 'running' && loaded.state !== 'sleeping')) return
    if (loaded.state === 'sleeping' && (loaded.wakeAt ?? 0) > this.now()) return
    // A run of a stopped app waits: Start drives it again.
    const lookup = await this.host.runnable(loaded.appId, loaded.version)
    if (lookup.kind === 'waiting') return
    if (lookup.kind === 'missing') {
      await this.finish(loaded, 'failed', null, `Version ${lookup.version} of this app is no longer available.`)
      return
    }
    const { target } = lookup
    if (!target.version.descriptor.workflows.some((declared) => declared.name === loaded.workflow)) {
      const which = loaded.version === null ? 'The active version' : `Version ${target.version.number}`
      await this.finish({ ...loaded, version: target.version.number }, 'failed', null, `${which} of the app does not declare the workflow ${loaded.workflow}.`)
      return
    }
    const run: AppRunRecord = { ...loaded, state: 'running', wakeAt: null, updatedAt: this.now(), version: target.version.number }
    if (loaded.state === 'sleeping' || loaded.version !== run.version) {
      await saveRun(run)
      emitAppActivity(run.appId, 'runs')
    }
    const caller: AppCaller = { kind: 'workflow', runId: run.id, workflow: run.workflow, step: '' }
    // One execution of the function is one row of the call log: its log lines and the spans of its steps.
    const recording = await beginCall({ app: target.app, version: target.version.number, operation: run.workflow, operationKind: 'workflow', caller, input: run.input, runId: run.id })
    const steps = await listSteps(run.id)
    try {
      const result = await this.runners.runWorkflow(target.run, {
        workflow: run.workflow,
        runId: run.id,
        input: run.input,
        steps: steps.map((step) => ({ name: step.name, state: step.state, result: step.result, attempts: step.attempts, wakeAt: step.wakeAt })),
        host: { log: recording.log, span: recording.span, request: (method, input, execution) => this.answer(target, run, caller, method, input, execution) },
      })
      await recording.succeeded(result.value)
      const current = await loadRun(run.id)
      if (!current || current.state !== 'running') return
      if (!result.suspended) {
        await this.finish(current, 'succeeded', result.value, null)
        return
      }
      const wakes = (await listSteps(run.id)).filter((step) => step.state === 'sleeping' && step.wakeAt !== null).map((step) => step.wakeAt ?? 0)
      await saveRun({ ...current, state: 'sleeping', wakeAt: wakes.length > 0 ? Math.min(...wakes) : this.now(), interruptions: 0, updatedAt: this.now() })
      emitAppActivity(run.appId, 'runs')
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      await recording.failed(failure)
      await this.stopped(run.id, failure)
    }
  }

  /** The function of a run did not end: it threw, or the runner stopped under it. */
  private async stopped(runId: string, failure: Error): Promise<void> {
    const current = await loadRun(runId)
    if (!current || current.state !== 'running') return
    // The function threw: the run failed. Any other error is the runner that stopped under it.
    if (failure instanceof AppOperationError) {
      await this.finish(current, 'failed', null, failure.message)
      return
    }
    const interruptions = current.interruptions + 1
    if (interruptions >= MAX_INTERRUPTIONS) {
      await this.finish(current, 'failed', null, `The app's backend stopped ${MAX_INTERRUPTIONS} times in a row while this run was in progress: ${failure.message}`)
      return
    }
    // The run stays `running`: the next deploy, Start, or tick starts its function again.
    await saveRun({ ...current, interruptions, updatedAt: this.now() })
    log.warn('app_run_interrupted', { appId: current.appId, runId, interruptions, error: failure.message })
  }

  private async finish(run: AppRunRecord, state: 'succeeded' | 'failed' | 'terminated', result: StoredValue, error: string | null): Promise<AppRunRecord> {
    const at = this.now()
    const finished: AppRunRecord = { ...run, state, result, error, wakeAt: null, updatedAt: at, finishedAt: at }
    await saveRun(finished)
    emitAppActivity(run.appId, 'runs')
    this.host.runsChanged(run.appId)
    log.info('app_run_finished', { appId: run.appId, runId: run.id, workflow: run.workflow, state })
    this.finishedCount += 1
    if (this.finishedCount % PRUNE_EVERY_RUNS === 0) await pruneRuns(run.appId).catch(() => {})
    return finished
  }

  /** One request of a run's function to the host: a step's receipt, or what a step uses. */
  private async answer(target: AppRunnable, run: AppRunRecord, caller: AppCaller, method: string, input: StoredValue, execution: AppExecution): Promise<StoredValue> {
    const current = await loadRun(run.id)
    if (!current || current.state !== 'running') throw new Error('This run was ended.')
    const receipt = async (name: string, kind: AppStepKind, change: Partial<AppStepRecord>): Promise<void> => {
      const existing = (await listSteps(run.id)).find((step) => step.name === name)
      await saveStep({
        runId: run.id, name, kind: existing?.kind ?? kind, state: 'running', attempts: existing?.attempts ?? 0, result: null, error: null, wakeAt: existing?.wakeAt ?? null,
        startedAt: existing?.startedAt ?? this.now(), finishedAt: null, ...change,
      })
      emitAppActivity(run.appId, 'runs')
    }
    switch (method) {
      case 'step.begin': {
        const step = beginSchema.parse(input)
        await receipt(step.name, 'do', { attempts: step.attempt })
        execution.extend(step.timeoutMs + RUN_QUIET_MS)
        return null
      }
      case 'step.retry': {
        const step = retrySchema.parse(input)
        await receipt(step.name, 'do', { attempts: step.attempt, error: step.error })
        execution.extend(step.waitMs + RUN_QUIET_MS)
        return null
      }
      case 'step.done': {
        const step = doneSchema.parse(input)
        await receipt(step.name, 'do', { state: 'done', result: step.result, finishedAt: this.now() })
        // The run made progress, so the runner's earlier stops no longer count against it.
        if (current.interruptions > 0) await saveRun({ ...current, interruptions: 0, updatedAt: this.now() })
        await this.host.signalsEmitted(target.app, target.version.descriptor, step.signals, run.id)
        execution.extend(RUN_QUIET_MS)
        return null
      }
      case 'step.fail': {
        const step = failSchema.parse(input)
        await receipt(step.name, 'do', { state: 'failed', error: step.error, finishedAt: this.now() })
        execution.extend(RUN_QUIET_MS)
        return null
      }
      case 'step.sleep': {
        const step = sleepSchema.parse(input)
        await receipt(step.name, 'sleep', { state: 'sleeping', wakeAt: step.wakeAt })
        execution.extend(Math.min(Math.max(step.wakeAt - this.now(), 0), WAIT_IN_PROCESS_MS) + RUN_QUIET_MS)
        return null
      }
      case 'step.op': {
        const step = operationSchema.parse(input)
        const declared = target.version.descriptor.operations.find((operation) => operation.name === step.operation)
        if (!declared) throw new Error(`This app has no operation named ${step.operation}.`)
        if (declared.kind !== step.kind) throw new Error(`${step.operation} is a ${declared.kind}. Run it with ${declared.kind === 'query' ? 'step.runQuery' : 'step.runMutation'}.`)
        await receipt(step.name, step.kind, { attempts: 1 })
        execution.extend(OPERATION_STEP_MS + RUN_QUIET_MS)
        try {
          const value = await this.host.callOperation(run.appId, step.operation, step.input, { kind: 'workflow', runId: run.id, workflow: run.workflow, step: step.name }, null, target.version)
          await receipt(step.name, step.kind, { state: 'done', result: value, finishedAt: this.now() })
          execution.extend(RUN_QUIET_MS)
          return value
        } catch (error) {
          await receipt(step.name, step.kind, { state: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: this.now() })
          execution.extend(RUN_QUIET_MS)
          throw error
        }
      }
      case 'step.model': {
        // A model call is one step: its receipt keeps the result, so a run that starts again does not pay for it twice (docs/plans/app-models.md §2).
        const step = modelStepSchema.parse(input)
        await receipt(step.name, 'model', { attempts: 1 })
        execution.extend(APP_MODEL_MAX_TIMEOUT_SECONDS * 1000 + RUN_QUIET_MS)
        try {
          const value = await this.host.hostRequest(target.app, target.version, 'models.run', step.request, { kind: 'workflow', runId: run.id, workflow: run.workflow, step: step.name })
          await receipt(step.name, 'model', { state: 'done', result: value, finishedAt: this.now() })
          execution.extend(RUN_QUIET_MS)
          return value
        } catch (error) {
          await receipt(step.name, 'model', { state: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: this.now() })
          execution.extend(RUN_QUIET_MS)
          throw error
        }
      }
      default:
        return this.host.hostRequest(target.app, target.version, method, input, caller)
    }
  }
}
