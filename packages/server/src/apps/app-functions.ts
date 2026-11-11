import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { AppHostAccess } from '@solus/contracts/apps'
import { launchedProcess } from '../cli-env'
import { createLogger } from '../logger'
import { resolveHomePath } from '../platform/paths'
import { APP_RUNNER_SCRIPT } from './app-runner-script'
import type { StoredValue } from './app-storage'

const log = createLogger('apps', 'app-functions.ts')

/**
 * An app's host functions (docs/plans/apps.md §6): one runner process for
 * each app, started on the first call under the host access the owner
 * allowed, stopped when idle. This class owns every runner's lifecycle; the
 * caller decides whether a call may run at all.
 */

const IDLE_MS = 5 * 60_000
const CALL_TIMEOUT_MS = 60_000
const START_TIMEOUT_MS = 15_000
const STDERR_TAIL_CHARACTERS = 2000

/** What one app's runner runs: the server module of one revision, under one host access. */
export interface AppFunctionsRun {
  workId: string
  contentVersion: number
  server: string
  access: AppHostAccess
  /** The app's own `data/` folder, always readable and writable. */
  dataFolder: string
}

export interface AppFunctionsOptions {
  /** The Node that runs a runner. The host's own by default; a test under another runtime names one. */
  node?: string
  idleMs?: number
  callTimeoutMs?: number
}

const runnerMessageSchema = z.union([
  z.object({ type: z.literal('ready'), functions: z.array(z.string()) }),
  z.object({ type: z.literal('failed'), message: z.string() }),
  z.object({ type: z.literal('result'), id: z.number(), ok: z.boolean(), value: z.json().optional(), message: z.string().optional() }),
])

interface PendingCall {
  resolve: (value: StoredValue) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** `*` is every path; any other entry is a host path, with `~` as the home folder. */
function hostPath(entry: string): string {
  return entry === '*' ? '*' : resolveHomePath(entry)
}

/** Node's arguments for a runner: the permission model with the app's paths. A path it may write, it may read. */
export function runnerArguments(access: AppHostAccess, dataFolder: string, hasNetworkPermission: boolean): string[] {
  const write = [dataFolder, ...access.files.write.map(hostPath)]
  const read = [...write, ...access.files.read.map(hostPath)]
  return [
    '--permission',
    ...read.map((path) => `--allow-fs-read=${path}`),
    ...write.map((path) => `--allow-fs-write=${path}`),
    // A Node with the network permission refuses every socket without this. The runner checks each host itself.
    ...(hasNetworkPermission && access.network.length > 0 ? ['--allow-net'] : []),
    '--max-old-space-size=512',
    '-e',
    APP_RUNNER_SCRIPT,
  ]
}

/** What a runner's process gets of the environment: enough to run, and no token of the server's. */
function runnerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1', HOME: homedir(), TMPDIR: tmpdir() }
  for (const name of ['PATH', 'LANG', 'TZ', 'SystemRoot', 'USERPROFILE']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

class Runner {
  readonly ready: Promise<void>
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 1
  private stderrTail = ''
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** Why this runner was stopped, from the moment it was told to stop. */
  private stopReason: string | null = null
  private hasEnded = false

  constructor(
    readonly signature: string,
    private readonly workId: string,
    private readonly child: ChildProcess,
    load: { code: string; network: string[]; dataDir: string },
    private readonly idleMs: number,
    private readonly onStopped: () => void,
  ) {
    let settle: { resolve: () => void; reject: (error: Error) => void } | null = null
    this.ready = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject }
    })
    const startTimer = setTimeout(() => this.stop('The app\'s host code did not start in time.'), START_TIMEOUT_MS)
    const started = (error: Error | null) => {
      clearTimeout(startTimer)
      if (error) settle?.reject(error)
      else settle?.resolve()
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
        if (message.type === 'ready') started(null)
        else if (message.type === 'failed') started(new Error(message.message))
        else this.settle(message.id, message.ok, message.value ?? null, message.message)
      })
    }
    child.on('error', (error) => this.ended(`The app's host code could not start: ${error.message}`, started))
    child.on('exit', () => this.ended(this.exitReason(), started))
    child.stdin?.on('error', () => {
      // The process ended with a write in flight; its exit says why.
    })
    child.stdin?.write(`${JSON.stringify({ type: 'load', ...load })}\n`)
    this.restartIdleTimer()
  }

  /** False from the moment the runner is told to stop: a new call needs a new runner. */
  get isRunning(): boolean {
    return this.stopReason === null && !this.hasEnded
  }

  call(name: string, input: StoredValue, timeoutMs: number): Promise<StoredValue> {
    if (!this.isRunning) return Promise.reject(new Error('The app\'s host code stopped. Call it again.'))
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const id = this.nextId++
    return new Promise<StoredValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A function that never answers may hold the whole process: stop it, so the next call starts clean.
        this.stop(`The host function ${name} did not answer in ${Math.round(timeoutMs / 1000)} seconds.`)
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin?.write(`${JSON.stringify({ type: 'call', id, name, input })}\n`)
    })
  }

  /** Stops the process this runner started. Calls in flight fail with `reason`. */
  stop(reason = 'The app\'s host code was stopped.'): void {
    if (!this.isRunning) return
    this.stopReason = reason
    this.failPending(reason)
    this.child.kill()
  }

  private settle(id: number, ok: boolean, value: StoredValue, message: string | undefined): void {
    const call = this.pending.get(id)
    if (!call) return
    this.pending.delete(id)
    clearTimeout(call.timer)
    if (ok) call.resolve(value)
    else call.reject(new Error(message || 'The host function failed.'))
    if (this.pending.size === 0) this.restartIdleTimer()
  }

  private restartIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs)
    this.idleTimer.unref?.()
  }

  private exitReason(): string {
    const lastLine = this.stderrTail.trim().split('\n').pop()
    return lastLine ? `The app's host code stopped: ${lastLine}` : 'The app\'s host code stopped.'
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
    log.info('app_runner_stopped', { workId: this.workId })
    this.onStopped()
  }
}

export class AppFunctions {
  private readonly runners = new Map<string, Runner>()
  private networkPermission: Promise<boolean> | null = null

  constructor(private readonly options: AppFunctionsOptions = {}) {}

  /** Runs one host function. Starts the app's runner when it has none for this revision and host access. */
  async call(run: AppFunctionsRun, name: string, input: StoredValue): Promise<StoredValue> {
    const runner = await this.runnerFor(run)
    await runner.ready
    return runner.call(name, input, this.options.callTimeoutMs ?? CALL_TIMEOUT_MS)
  }

  /** Stops an app's runner, if it has one: its host access was revoked, or its work is gone. */
  stop(workId: string): void {
    this.runners.get(workId)?.stop()
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
      execFile(probe.file, probe.args, { env: probe.env, timeout: START_TIMEOUT_MS }, (error, stdout) => resolve(!error && stdout.trim() === 'true'))
    })
    return this.networkPermission
  }

  private async runnerFor(run: AppFunctionsRun): Promise<Runner> {
    const signature = `${run.contentVersion}:${JSON.stringify(run.access)}`
    const current = this.runners.get(run.workId)
    if (current?.signature === signature && current.isRunning) return current
    // A new revision or a changed host access: the old process must not answer for it.
    current?.stop('The app changed. Call it again.')
    const launch = launchedProcess({ env: runnerEnvironment() }, this.node(), runnerArguments(run.access, run.dataFolder, await this.hasNetworkPermission()))
    const raced = this.runners.get(run.workId)
    if (raced?.signature === signature && raced.isRunning) return raced
    const child = spawn(launch.file, launch.args, { env: launch.env, cwd: resolveHomePath(run.dataFolder), stdio: ['pipe', 'pipe', 'pipe'] })
    const runner: Runner = new Runner(signature, run.workId, child, { code: run.server, network: run.access.network, dataDir: run.dataFolder }, this.options.idleMs ?? IDLE_MS, () => {
      if (this.runners.get(run.workId) === runner) this.runners.delete(run.workId)
    })
    this.runners.set(run.workId, runner)
    log.info('app_runner_started', { workId: run.workId, pid: child.pid })
    return runner
  }
}
