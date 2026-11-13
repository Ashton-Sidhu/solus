import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { appLogLineSchema, appSpanSchema, type AppCaller, type AppConfigValue, type AppLogLine, type AppPermissions, type AppProtocol, type AppRuntimeView, type AppSpan } from '@solus/contracts/apps'
import { launchedProcess } from '../cli-env'
import { createLogger } from '../logger'
import { resolveHomePath } from '../platform/paths'
import type { AppMigration } from './app-project'
import { APP_RUNNER_SCRIPT } from './app-runner-script'
import type { StoredValue } from './app-storage'

const log = createLogger('apps', 'app-runners.ts')

/**
 * The runners (docs/plans/apps.md §6): one child process for each app, started
 * on the first call or when a version becomes active, stopped when idle. This
 * class owns every runner's lifecycle; the caller decides whether a call may
 * run at all. A runner with a call or a run in progress does not stop for
 * idle.
 */

const IDLE_MS = 5 * 60_000
const CALL_TIMEOUT_MS = 60_000
/** How long a run may say nothing before its first step starts, and between two steps. */
export const RUN_QUIET_MS = 75_000
/** A start applies the version's new migrations, so it has more time than a call. */
const START_TIMEOUT_MS = 60_000
const STDERR_TAIL_CHARACTERS = 2000
const MAX_RESULT_BYTES = 1024 * 1024

/** What one app's runner runs: the backend of one version, under its permissions. */
export interface AppRun {
  appId: string
  /** Changes when the runner must start again: another version, other secrets, or another config. */
  signature: string
  /** The backend module: CommonJS for Node. */
  code: string
  /** The build's protocol: what `ctx` holds (§6.3). */
  protocol: AppProtocol
  permissions: AppPermissions
  /** The app's data folder: its database and its app files are here, and the runner may always read and write it. */
  appFolder: string
  /** The app's own `files/` folder, with no records. */
  filesDir: string
  secrets: { [name: string]: string }
  /** The config values the app runs with: each declared field, with its value or its default. */
  config: { [name: string]: AppConfigValue }
  migrations: AppMigration[]
  /** The operations the descriptor declares. The kind here decides the database a call gets. */
  operations: { name: string; kind: 'query' | 'mutation' }[]
  /** The workflows the descriptor declares. */
  workflows: string[]
}

/** A call or a run in progress, as its host side sees it. */
export interface AppExecution {
  /** Gives the execution this much more time from now. A run has no fixed length: each step sets how long the next silence may be. */
  extend(ms: number): void
}

/** What the host does for one call or one run while it is in progress. */
export interface AppRunnerHost {
  /** One request of the app for what the host owns: an integration tool, an app file's record, a step's receipt, a workflow control. */
  request(method: string, input: StoredValue, execution: AppExecution): Promise<StoredValue>
  log(line: AppLogLine): void
  span(span: AppSpan): void
}

/** One call of an operation. */
export interface AppRunnerCall {
  name: string
  input: StoredValue
  caller: AppCaller
  /** How long the call may take; the default when absent. */
  timeoutMs?: number
  host: AppRunnerHost
}

/** A step's receipt as a run that starts again reads it. */
export interface AppRunnerStep {
  name: string
  state: 'running' | 'done' | 'failed' | 'sleeping'
  result: StoredValue
  attempts: number
  wakeAt: number | null
}

/** One execution of a workflow's function, from its top. */
export interface AppRunnerWorkflow {
  workflow: string
  runId: string
  input: StoredValue
  steps: AppRunnerStep[]
  host: AppRunnerHost
}

/** A signal a call or a step emitted. */
export interface AppEmittedSignal {
  name: string
  payload: StoredValue
}

export interface AppRunnerResult {
  value: StoredValue
  /** The call changed the app's database. */
  changed: boolean
  /** What the call emitted. Empty for a call that failed. */
  signals: AppEmittedSignal[]
  /** A run only: its function waits for a long sleep, and the host starts it again when the time comes. */
  suspended: boolean
}

export interface AppRunnersOptions {
  /** The Node that runs a runner. The host's own by default; a test under another runtime names one. */
  node?: string
  idleMs?: number
  callTimeoutMs?: number
}

const emittedSignalSchema = z.object({ name: z.string(), payload: z.json() })

const runnerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), applied: z.array(z.string()) }),
  z.object({ type: z.literal('failed'), message: z.string() }),
  z.object({
    type: z.literal('result'), id: z.number(), ok: z.boolean(), value: z.json().optional(), message: z.string().optional(), stack: z.string().nullable().optional(),
    changed: z.boolean(), signals: z.array(emittedSignalSchema).optional(), suspended: z.boolean().optional(), rssBytes: z.number().optional(),
  }),
  z.object({ type: z.literal('request'), id: z.number(), call: z.number().nullable(), method: z.string(), input: z.json() }),
  appLogLineSchema.extend({ type: z.literal('log'), call: z.number() }),
  appSpanSchema.extend({ type: z.literal('span'), call: z.number() }),
])

type RunnerLoad = Pick<AppRun, 'code' | 'protocol' | 'appFolder' | 'filesDir' | 'secrets' | 'config' | 'migrations' | 'operations' | 'workflows'> & { network: string[] }

/** What the host writes to a runner, one object on each line. */
type RunnerRequest =
  | ({ type: 'load' } & RunnerLoad)
  | { type: 'call'; id: number; name: string; input: StoredValue; caller: AppCaller }
  | { type: 'run'; id: number; workflow: string; runId: string; input: StoredValue; steps: AppRunnerStep[] }
  | { type: 'reply'; id: number; ok: true; value: StoredValue }
  | { type: 'reply'; id: number; ok: false; message: string }

/** An operation failed inside the app: the message is the app's own, for its caller. */
export class AppOperationError extends Error {
  constructor(message: string, readonly changed: boolean, readonly appStack: string | null = null) {
    super(message)
    this.name = 'AppOperationError'
  }
}

interface PendingCall {
  resolve: (result: AppRunnerResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  host: AppRunnerHost
  execution: AppExecution
}

/** `*` is every path; any other entry is a host path, with `~` as the home folder. */
function hostPath(entry: string): string {
  return entry === '*' ? '*' : resolveHomePath(entry)
}

/** Node's arguments for a runner: the permission model with the app's paths. A path it may write, it may read. */
export function runnerArguments(permissions: AppPermissions, appFolder: string, hasNetworkPermission: boolean): string[] {
  const write = [appFolder, ...permissions.files.write.map(hostPath)]
  const read = [...write, ...permissions.files.read.map(hostPath)]
  return [
    '--permission',
    ...read.map((path) => `--allow-fs-read=${path}`),
    ...write.map((path) => `--allow-fs-write=${path}`),
    // A Node with the network permission refuses every socket without this. The runner checks each host itself.
    ...(hasNetworkPermission && permissions.network.length > 0 ? ['--allow-net'] : []),
    '--max-old-space-size=512',
    '-e',
    APP_RUNNER_SCRIPT,
  ]
}

/** What a runner's process gets of the environment: enough to run, and no token of the host's. */
function runnerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1', HOME: homedir(), TMPDIR: tmpdir() }
  for (const name of ['PATH', 'LANG', 'TZ', 'SystemRoot', 'USERPROFILE']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

class Runner {
  /** Settles when the backend loaded: with the migrations this start applied. */
  readonly ready: Promise<string[]>
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 1
  private stderrTail = ''
  private readonly startedAt = Date.now()
  private rssBytes: number | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** Why this runner was stopped, from the moment it was told to stop. */
  private stopReason: string | null = null
  private hasEnded = false

  constructor(
    readonly signature: string,
    private readonly appId: string,
    private readonly child: ChildProcess,
    load: RunnerLoad,
    private readonly idleMs: number,
    private readonly onStopped: () => void,
  ) {
    let settle: { resolve: (applied: string[]) => void; reject: (error: Error) => void } | null = null
    this.ready = new Promise<string[]>((resolve, reject) => {
      settle = { resolve, reject }
    })
    const startTimer = setTimeout(() => this.stop('The app\'s backend did not start in time.'), START_TIMEOUT_MS)
    const started = (error: Error | null, applied: string[] = []) => {
      clearTimeout(startTimer)
      if (error) settle?.reject(error)
      else settle?.resolve(applied)
      settle = null
    }
    // A caller that never awaits `ready` (the runner was replaced first) must not leave a rejection unhandled.
    this.ready.catch(() => {})

    child.stderr?.setEncoding('utf8').on('data', (text: string) => {
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARACTERS)
    })
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        let message: z.infer<typeof runnerMessageSchema>
        try {
          message = runnerMessageSchema.parse(JSON.parse(line))
        } catch {
          // Not a line of the protocol: the app wrote to stdout itself.
          return
        }
        if (message.type === 'ready') started(null, message.applied)
        else if (message.type === 'failed') started(new Error(message.message))
        else if (message.type === 'request') void this.answer(message.id, message.call, message.method, message.input)
        else if (message.type === 'log') this.pending.get(message.call)?.host.log(appLogLineSchema.parse(message))
        else if (message.type === 'span') this.pending.get(message.call)?.host.span(appSpanSchema.parse(message))
        else {
          if (message.rssBytes !== undefined) this.rssBytes = message.rssBytes
          if (Buffer.byteLength(line) > MAX_RESULT_BYTES) this.settle(message.id, new AppOperationError('The result is over 1 MiB. Return less, or page it.', message.changed))
          else if (message.ok) this.settle(message.id, { value: message.value ?? null, changed: message.changed, signals: message.signals ?? [], suspended: message.suspended === true })
          else this.settle(message.id, new AppOperationError(message.message || 'The operation failed.', message.changed, message.stack ?? null))
        }
      })
    }
    child.on('error', (error) => this.ended(`The app's backend could not start: ${error.message}`, started))
    child.on('exit', () => this.ended(this.exitReason(), started))
    child.stdin?.on('error', () => {
      // The process ended with a write in flight; its exit says why.
    })
    this.send({ type: 'load', ...load })
    this.restartIdleTimer()
  }

  /** False from the moment the runner is told to stop: a new call needs a new runner. */
  get isRunning(): boolean {
    return this.stopReason === null && !this.hasEnded
  }

  /** The runner's state for the app's owner. */
  get status(): AppRuntimeView {
    return { running: this.isRunning, startedAt: this.startedAt, inFlight: this.pending.size, rssBytes: this.rssBytes }
  }

  call(call: AppRunnerCall, defaultTimeoutMs: number): Promise<AppRunnerResult> {
    const timeoutMs = call.timeoutMs ?? defaultTimeoutMs
    return this.execute(call.host, timeoutMs, `The operation ${call.name} did not answer in ${Math.round(timeoutMs / 1000)} seconds.`, (id) => ({ type: 'call', id, name: call.name, input: call.input, caller: call.caller }))
  }

  /** Runs a workflow's function from its top. The host gives it more time each time a step starts (`AppExecution.extend`). */
  run(run: AppRunnerWorkflow): Promise<AppRunnerResult> {
    return this.execute(run.host, RUN_QUIET_MS, `The run of ${run.workflow} did nothing for too long.`, (id) => ({ type: 'run', id, workflow: run.workflow, runId: run.runId, input: run.input, steps: run.steps }))
  }

  private execute(host: AppRunnerHost, timeoutMs: number, lateReason: string, request: (id: number) => RunnerRequest): Promise<AppRunnerResult> {
    if (!this.isRunning) return Promise.reject(new Error('The app\'s backend stopped. Call it again.'))
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const id = this.nextId++
    return new Promise<AppRunnerResult>((resolve, reject) => {
      // An execution that never answers may hold the whole process: stop it, so the next call starts clean.
      const late = () => this.stop(lateReason)
      const pending: PendingCall = {
        resolve, reject, host, timer: setTimeout(late, timeoutMs),
        execution: {
          extend: (ms) => {
            if (this.pending.get(id) !== pending) return
            clearTimeout(pending.timer)
            pending.timer = setTimeout(late, ms)
          },
        },
      }
      this.pending.set(id, pending)
      this.send(request(id))
    })
  }

  /** Stops the process this runner started. Calls in flight fail with `reason`. */
  stop(reason = 'The app\'s backend was stopped.'): void {
    if (!this.isRunning) return
    this.stopReason = reason
    this.failPending(reason)
    this.child.kill()
  }

  private send(message: RunnerRequest): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  /** The app asked for what the host owns: the call it belongs to says who answers. */
  private async answer(id: number, callId: number | null, method: string, input: StoredValue): Promise<void> {
    const call = callId === null ? undefined : this.pending.get(callId)
    if (!call) {
      this.send({ type: 'reply', id, ok: false, message: 'The call that asked is not in progress.' })
      return
    }
    try {
      this.send({ type: 'reply', id, ok: true, value: await call.host.request(method, input, call.execution) })
    } catch (error) {
      this.send({ type: 'reply', id, ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private settle(id: number, outcome: AppRunnerResult | AppOperationError): void {
    const call = this.pending.get(id)
    if (!call) return
    this.pending.delete(id)
    clearTimeout(call.timer)
    if (outcome instanceof AppOperationError) call.reject(outcome)
    else call.resolve(outcome)
    if (this.pending.size === 0) this.restartIdleTimer()
  }

  private restartIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs)
    this.idleTimer.unref?.()
  }

  private exitReason(): string {
    const lastLine = this.stderrTail.trim().split('\n').pop()
    return lastLine ? `The app's backend stopped: ${lastLine}` : 'The app\'s backend stopped.'
  }

  private failPending(reason: string): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private ended(exitReason: string, started: (error: Error | null) => void): void {
    if (this.hasEnded) return
    this.hasEnded = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const reason = this.stopReason ?? exitReason
    started(new Error(reason))
    this.failPending(reason)
    log.info('app_runner_stopped', { appId: this.appId })
    this.onStopped()
  }
}

export class AppRunners {
  private readonly runners = new Map<string, Runner>()
  private networkPermission: Promise<boolean> | null = null

  constructor(private readonly options: AppRunnersOptions = {}) {}

  /** Starts the app's runner for this run and waits until its backend loaded. Answers the migrations the start applied. */
  async start(run: AppRun): Promise<string[]> {
    return (await this.runnerFor(run)).ready
  }

  /** Runs one operation. Starts the app's runner when it has none for this run. */
  async call(run: AppRun, call: AppRunnerCall): Promise<AppRunnerResult> {
    const runner = await this.runnerFor(run)
    await runner.ready
    return runner.call(call, this.options.callTimeoutMs ?? CALL_TIMEOUT_MS)
  }

  /** Runs a workflow's function from its top. Starts the app's runner when it has none for this run. */
  async runWorkflow(run: AppRun, workflow: AppRunnerWorkflow): Promise<AppRunnerResult> {
    const runner = await this.runnerFor(run)
    await runner.ready
    return runner.run(workflow)
  }

  /** The state of an app's runner; an app with no process now is not running. */
  status(appId: string): AppRuntimeView {
    return this.runners.get(appId)?.status ?? { running: false, startedAt: null, inFlight: 0, rssBytes: null }
  }

  /** Stops an app's runner, if it has one: the app was stopped, or it is gone. */
  stop(appId: string, reason?: string): void {
    this.runners.get(appId)?.stop(reason)
  }

  dispose(): void {
    for (const runner of this.runners.values()) runner.stop()
  }

  private node(): string {
    return this.options.node ?? process.execPath
  }

  /** Whether the runner's Node has the network permission, asked of that Node once. */
  private hasNetworkPermission(): Promise<boolean> {
    this.networkPermission ??= new Promise((resolve) => {
      const probe = launchedProcess({ env: runnerEnvironment() }, this.node(), ['-p', 'process.allowedNodeEnvironmentFlags.has("--allow-net")'])
      execFile(probe.file, probe.args, { env: probe.env, timeout: 15_000 }, (error, stdout) => resolve(!error && stdout.trim() === 'true'))
    })
    return this.networkPermission
  }

  private async runnerFor(run: AppRun): Promise<Runner> {
    const current = this.runners.get(run.appId)
    if (current?.signature === run.signature && current.isRunning) return current
    // Another version, other secrets, or another config: the old process must not answer for them.
    current?.stop('The app changed. Call it again.')
    const launch = launchedProcess({ env: runnerEnvironment() }, this.node(), runnerArguments(run.permissions, run.appFolder, await this.hasNetworkPermission()))
    const raced = this.runners.get(run.appId)
    if (raced?.signature === run.signature && raced.isRunning) return raced
    const child = spawn(launch.file, launch.args, { env: launch.env, cwd: run.filesDir, stdio: ['pipe', 'pipe', 'pipe'] })
    const runner: Runner = new Runner(run.signature, run.appId, child, {
      code: run.code, protocol: run.protocol, network: run.permissions.network, appFolder: run.appFolder, filesDir: run.filesDir,
      secrets: run.secrets, config: run.config, migrations: run.migrations, operations: run.operations, workflows: run.workflows,
    }, this.options.idleMs ?? IDLE_MS, () => {
      if (this.runners.get(run.appId) === runner) this.runners.delete(run.appId)
    })
    this.runners.set(run.appId, runner)
    log.info('app_runner_started', { appId: run.appId, pid: child.pid })
    return runner
  }
}
