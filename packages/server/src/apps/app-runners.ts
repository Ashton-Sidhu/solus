import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { AppCaller, AppPermissions } from '@solus/contracts/apps'
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
 * run at all.
 */

const IDLE_MS = 5 * 60_000
const CALL_TIMEOUT_MS = 60_000
/** A start applies the version's new migrations, so it has more time than a call. */
const START_TIMEOUT_MS = 60_000
const STDERR_TAIL_CHARACTERS = 2000
const MAX_RESULT_BYTES = 1024 * 1024

/** What one app's runner runs: the backend of one version, under its permissions. */
export interface AppRun {
  appId: string
  /** Changes when the runner must start again: another version, or another set of secrets. */
  signature: string
  /** The backend module: CommonJS for Node. */
  code: string
  permissions: AppPermissions
  /** The app's data folder: its database is here, and the runner may always read and write it. */
  appFolder: string
  /** The folder the backend gets as `ctx.files`. */
  filesDir: string
  secrets: { [name: string]: string }
  migrations: AppMigration[]
  /** The operations the descriptor declares. The kind here decides the database a call gets. */
  operations: { name: string; kind: 'query' | 'mutation' }[]
}

/** One call of an operation. `tools` answers an integration call the operation makes. */
export interface AppRunnerCall {
  name: string
  input: StoredValue
  caller: AppCaller
  tools(slug: string, tool: string, input: StoredValue): Promise<StoredValue>
}

export interface AppRunnerResult {
  value: StoredValue
  /** The call changed the app's database. */
  changed: boolean
}

export interface AppRunnersOptions {
  /** The Node that runs a runner. The host's own by default; a test under another runtime names one. */
  node?: string
  idleMs?: number
  callTimeoutMs?: number
}

const runnerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), applied: z.array(z.string()) }),
  z.object({ type: z.literal('failed'), message: z.string() }),
  z.object({ type: z.literal('result'), id: z.number(), ok: z.boolean(), value: z.json().optional(), message: z.string().optional(), changed: z.boolean() }),
  z.object({ type: z.literal('tool'), id: z.number(), call: z.number(), slug: z.string(), tool: z.string(), input: z.json() }),
])

type RunnerLoad = Pick<AppRun, 'code' | 'appFolder' | 'filesDir' | 'secrets' | 'migrations' | 'operations'> & { network: string[] }

/** What the host writes to a runner, one object on each line. */
type RunnerRequest =
  | ({ type: 'load' } & RunnerLoad)
  | { type: 'call'; id: number; name: string; input: StoredValue; caller: AppCaller }
  | { type: 'tool-result'; id: number; ok: true; value: StoredValue }
  | { type: 'tool-result'; id: number; ok: false; message: string }

/** An operation failed inside the app: the message is the app's own, for its caller. */
export class AppOperationError extends Error {
  constructor(message: string, readonly changed: boolean) {
    super(message)
    this.name = 'AppOperationError'
  }
}

interface PendingCall {
  resolve: (result: AppRunnerResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  tools: AppRunnerCall['tools']
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
        else if (message.type === 'tool') void this.answerTool(message.id, message.call, message.slug, message.tool, message.input)
        else if (Buffer.byteLength(line) > MAX_RESULT_BYTES) this.settle(message.id, false, null, 'The result is over 1 MiB. Return less, or page it.', message.changed)
        else this.settle(message.id, message.ok, message.value ?? null, message.message, message.changed)
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

  call(call: AppRunnerCall, timeoutMs: number): Promise<AppRunnerResult> {
    if (!this.isRunning) return Promise.reject(new Error('The app\'s backend stopped. Call it again.'))
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const id = this.nextId++
    return new Promise<AppRunnerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // An operation that never answers may hold the whole process: stop it, so the next call starts clean.
        this.stop(`The operation ${call.name} did not answer in ${Math.round(timeoutMs / 1000)} seconds.`)
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, tools: call.tools })
      this.send({ type: 'call', id, name: call.name, input: call.input, caller: call.caller })
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

  /** An operation called an integration: the call it belongs to says whose connection answers. */
  private async answerTool(id: number, callId: number, slug: string, tool: string, input: StoredValue): Promise<void> {
    const call = this.pending.get(callId)
    if (!call) return
    try {
      this.send({ type: 'tool-result', id, ok: true, value: await call.tools(slug, tool, input) })
    } catch (error) {
      this.send({ type: 'tool-result', id, ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private settle(id: number, ok: boolean, value: StoredValue, message: string | undefined, changed: boolean): void {
    const call = this.pending.get(id)
    if (!call) return
    this.pending.delete(id)
    clearTimeout(call.timer)
    if (ok) call.resolve({ value, changed })
    else call.reject(new AppOperationError(message || 'The operation failed.', changed))
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
    // Another version or other secrets: the old process must not answer for them.
    current?.stop('The app changed. Call it again.')
    const launch = launchedProcess({ env: runnerEnvironment() }, this.node(), runnerArguments(run.permissions, run.appFolder, await this.hasNetworkPermission()))
    const raced = this.runners.get(run.appId)
    if (raced?.signature === run.signature && raced.isRunning) return raced
    const child = spawn(launch.file, launch.args, { env: launch.env, cwd: run.filesDir, stdio: ['pipe', 'pipe', 'pipe'] })
    const runner: Runner = new Runner(run.signature, run.appId, child, {
      code: run.code, network: run.permissions.network, appFolder: run.appFolder, filesDir: run.filesDir,
      secrets: run.secrets, migrations: run.migrations, operations: run.operations,
    }, this.options.idleMs ?? IDLE_MS, () => {
      if (this.runners.get(run.appId) === runner) this.runners.delete(run.appId)
    })
    this.runners.set(run.appId, runner)
    log.info('app_runner_started', { appId: run.appId, pid: child.pid })
    return runner
  }
}
