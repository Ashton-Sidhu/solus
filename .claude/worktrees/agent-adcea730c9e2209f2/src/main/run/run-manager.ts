import { spawn, type ChildProcess } from 'child_process'
import { readFile, realpath } from 'fs/promises'
import path from 'path'
import { MAX_RUN_LOG_LINES, worktreeProjectRoot, type RunLogBatch, type RunLogLevel, type RunLogLine, type RunProjectStatus, type RunStatus } from '../../shared/types'
import { loadProjectConfig } from '../project-config/project-config'
import { runAsync } from '../git/exec'
import { getCliEnv } from '../cli-env'
import { stopProcessGroup } from './process-group'

interface ManagedRun {
  repoRoot: string
  commandId: string
  name: string | null
  state: RunStatus['state']
  command: string | null
  source: RunStatus['source']
  configPort: number | null
  ports: number[]
  pid: number | null
  error: string | null
  exitCode: number | null
  startedAt: number | null
  child: ChildProcess | null
  logs: RunLogLine[]
  /** Next seq to assign; resets to 0 on each start so clients can detect restarts. */
  logSeq: number
  stopRequested: boolean
  runningTimer: ReturnType<typeof setTimeout> | null
}

interface CommandSpec {
  id: string
  name: string | null
  command: string
  args: string[]
  shell: boolean
  source: NonNullable<RunStatus['source']>
  display: string
  configPort: number | null
}

const PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/g
const ANSI_RE = /\x1b\[[0-9;]*m/g
const AUTO_COMMAND_ID = 'auto'

// Line classification for the debug console. Checked in priority order:
// error > warn > success, falling through to plain info.
const ERROR_RE = /(\berror\b|\bfatal\b|\bexception\b|\bfailed\b|\bcannot\b|unhandled|panic|traceback|ENOENT|EADDRINUSE|ECONNREFUSED|✖|✗|×)/i
const WARN_RE = /(\bwarn(?:ing)?\b|\bdeprecat|\bskipping\b|⚠)/i
const SUCCESS_RE = /(\bready\b|\bcompiled\b|\bsuccess|\bbuilt\b|\blistening\b|\bstarted\b|\bup to date\b|✓|✔|➜)/i
// Stricter "the server is actually serving" signal — flips starting → running
// even before a port is parsed, and drives the UI's ready celebration.
const READY_RE = /(\bready\b|\blistening\b|\bcompiled successfully\b|\bstarted server\b|server (?:running|started)|local:\s+https?:\/\/)/i

function classify(line: string): RunLogLevel {
  if (ERROR_RE.test(line)) return 'error'
  if (WARN_RE.test(line)) return 'warn'
  if (SUCCESS_RE.test(line)) return 'success'
  return 'info'
}

export class RunManager {
  /** repoRoot -> commandId -> run */
  private runs = new Map<string, Map<string, ManagedRun>>()
  private repoRootByCwd = new Map<string, string>()

  constructor(private opts: { broadcast(status: RunStatus): void; broadcastLog(batch: RunLogBatch): void }) {}

  async status(cwd: string): Promise<RunProjectStatus> {
    const repoRoot = await this.repoRootFor(cwd)
    return this.statusForRoot(repoRoot, await this.resolveCommands(repoRoot))
  }

  /** True while any managed dev-server process is starting or running. */
  hasActiveRuns(): boolean {
    for (const byId of this.runs.values()) {
      for (const run of byId.values()) {
        if (run.state === 'starting' || run.state === 'running') return true
      }
    }
    return false
  }

  private statusForRoot(repoRoot: string, specs: CommandSpec[]): RunProjectStatus {
    const byId = this.bucket(repoRoot)
    const runs: RunStatus[] = []
    const seen = new Set<string>()
    for (const spec of specs) {
      const run = this.ensure(repoRoot, spec)
      this.applySpec(run, spec)
      seen.add(spec.id)
      runs.push(this.snapshot(run))
    }
    // Keep runs whose config entry was removed but that are still alive, so they can be stopped.
    for (const run of byId.values()) {
      if (seen.has(run.commandId)) continue
      if (run.state === 'starting' || run.state === 'running') runs.push(this.snapshot(run))
      else byId.delete(run.commandId)
    }
    return { repoRoot, runs }
  }

  async start(cwd: string, commandId: string): Promise<RunProjectStatus> {
    const repoRoot = await this.repoRootFor(cwd)
    const specs = await this.resolveCommands(repoRoot)
    const spec = specs.find((s) => s.id === commandId)
    if (!spec) return this.statusForRoot(repoRoot, specs)
    const run = this.ensure(repoRoot, spec)
    if (run.state === 'starting' || run.state === 'running') return this.statusForRoot(repoRoot, specs)
    this.applySpec(run, spec)

    run.state = 'starting'
    run.ports = run.configPort ? [run.configPort] : []
    run.pid = null
    run.error = null
    run.exitCode = null
    run.startedAt = Date.now()
    run.logs = []
    run.logSeq = 0
    run.stopRequested = false
    this.emit(run)

    const child = spawn(spec.command, spec.args, {
      cwd: repoRoot,
      detached: true,
      shell: spec.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getCliEnv({ FORCE_COLOR: '0' }),
    })
    run.child = child
    run.pid = child.pid ?? null

    const onData = (chunk: Buffer) => this.capture(run, chunk.toString('utf-8'))
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      // Ignore a stale exit from a process we've already superseded (restart).
      if (run.child !== child) return
      this.clearTimer(run)
      run.child = null
      run.pid = null
      run.exitCode = code
      if (run.stopRequested) {
        // User cancelled — neither success nor failure.
        run.state = 'stopped'
        run.error = null
      } else if (code === 0) {
        // Exit 0 is success regardless of whether we ever flipped to 'running'
        // (a fast one-shot build/test exits while still 'starting').
        run.state = 'completed'
        run.error = null
      } else {
        run.state = 'error'
        run.error = this.lastLogLine(run) || `Exited with code ${code ?? 'unknown'}`
      }
      run.ports = []
      run.startedAt = null
      this.emit(run)
    })
    child.once('error', (err) => {
      if (run.child !== child) return
      this.clearTimer(run)
      run.child = null
      run.pid = null
      run.state = 'error'
      run.ports = []
      run.error = err.message
      run.startedAt = null
      this.emit(run)
    })

    run.runningTimer = setTimeout(() => {
      if (run.state !== 'starting') return
      run.state = 'running'
      this.emit(run)
    }, 10_000)
    this.emit(run)
    return this.statusForRoot(repoRoot, specs)
  }

  async stop(cwd: string, commandId: string): Promise<RunProjectStatus> {
    const repoRoot = await this.repoRootFor(cwd)
    const run = this.runs.get(repoRoot)?.get(commandId)
    if (run) this.stopRun(run, false)
    return this.statusForRoot(repoRoot, await this.resolveCommands(repoRoot))
  }

  async restart(cwd: string, commandId: string): Promise<RunProjectStatus> {
    const repoRoot = await this.repoRootFor(cwd)
    const run = this.runs.get(repoRoot)?.get(commandId)
    // SIGTERM the live process group, then spawn fresh. The old process's exit
    // handler is neutralised by the run.child identity guard in start().
    if (run && (run.state === 'starting' || run.state === 'running')) {
      this.stopRun(run, false)
    }
    return this.start(cwd, commandId)
  }

  stopAll(): void {
    for (const byId of this.runs.values()) {
      for (const run of byId.values()) this.stopRun(run, true)
    }
  }

  async logs(cwd: string, commandId: string): Promise<RunLogLine[]> {
    const repoRoot = await this.repoRootFor(cwd)
    return [...(this.runs.get(repoRoot)?.get(commandId)?.logs ?? [])]
  }

  private async repoRootFor(cwd: string): Promise<string> {
    const cached = this.repoRootByCwd.get(cwd)
    if (cached) return cached
    const root = await runAsync('git', ['rev-parse', '--show-toplevel'], cwd, { timeout: 5_000 }).catch(() => null)
    const base = root || cwd
    const resolved = await realpath(base).catch(() => path.resolve(base))
    this.repoRootByCwd.set(cwd, resolved)
    return resolved
  }

  private bucket(repoRoot: string): Map<string, ManagedRun> {
    let byId = this.runs.get(repoRoot)
    if (!byId) {
      byId = new Map()
      this.runs.set(repoRoot, byId)
    }
    return byId
  }

  private ensure(repoRoot: string, spec: CommandSpec): ManagedRun {
    const byId = this.bucket(repoRoot)
    let run = byId.get(spec.id)
    if (!run) {
      run = {
        repoRoot,
        commandId: spec.id,
        name: spec.name,
        state: 'stopped',
        command: spec.display,
        source: spec.source,
        configPort: spec.configPort,
        ports: [],
        pid: null,
        error: null,
        exitCode: null,
        startedAt: null,
        child: null,
        logs: [],
        logSeq: 0,
        stopRequested: false,
        runningTimer: null,
      }
      byId.set(spec.id, run)
    }
    return run
  }

  /** Refresh display fields from config for runs that aren't mid-flight. */
  private applySpec(run: ManagedRun, spec: CommandSpec): void {
    run.name = spec.name
    run.configPort = spec.configPort
    if (run.state === 'starting' || run.state === 'running') return
    run.command = spec.display
    run.source = spec.source
  }

  private configRootFor(repoRoot: string): string {
    return worktreeProjectRoot(repoRoot)
  }

  private async resolveCommands(repoRoot: string): Promise<CommandSpec[]> {
    const config = await loadProjectConfig(this.configRootFor(repoRoot))
    const configured = (config?.runCommands ?? []).filter((entry) => entry.command.trim())
    if (config?.runCommands) {
      return configured.map((entry) => ({
        id: entry.id,
        name: entry.name ?? null,
        command: entry.command.trim(),
        args: [],
        shell: true,
        source: 'config' as const,
        display: entry.command.trim(),
        configPort: entry.port ?? null,
      }))
    }
    try {
      const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> }
      if (pkg.scripts?.dev) {
        return [{ id: AUTO_COMMAND_ID, name: null, command: 'npm', args: ['run', 'dev'], shell: false, source: 'package-dev', display: 'npm run dev', configPort: null }]
      }
      if (pkg.scripts?.start) {
        return [{ id: AUTO_COMMAND_ID, name: null, command: 'npm', args: ['run', 'start'], shell: false, source: 'package-start', display: 'npm run start', configPort: null }]
      }
    } catch {}
    return []
  }

  private capture(run: ManagedRun, text: string): void {
    const fresh: RunLogLine[] = []
    let stateChanged = false
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(ANSI_RE, '').trimEnd()
      if (!line.trim()) continue
      const entry: RunLogLine = { seq: run.logSeq++, level: classify(line), text: line, ts: Date.now() }
      run.logs.push(entry)
      fresh.push(entry)
      if (run.logs.length > MAX_RUN_LOG_LINES) run.logs.splice(0, run.logs.length - MAX_RUN_LOG_LINES)

      const ports = [...line.matchAll(PORT_RE)]
        .map((match) => Number(match[1]))
        .filter((port) => Number.isInteger(port))
      for (const port of ports) {
        if (!run.ports.includes(port)) run.ports.push(port)
      }
      // A detected port or an explicit readiness signal both mean "it's up".
      if (run.state === 'starting' && (ports.length > 0 || READY_RE.test(line))) {
        run.state = 'running'
        this.clearTimer(run)
        stateChanged = true
      } else if (ports.length > 0) {
        stateChanged = true
      }
    }
    if (fresh.length > 0) {
      this.opts.broadcastLog({ repoRoot: run.repoRoot, commandId: run.commandId, lines: fresh })
    }
    if (stateChanged) this.emit(run)
  }

  private stopRun(run: ManagedRun, syncOnly: boolean): void {
    run.stopRequested = true
    this.clearTimer(run)
    if (!run.pid) {
      run.state = 'stopped'
      run.ports = []
      run.error = null
      this.emit(run)
      return
    }
    const pid = run.pid
    try {
      stopProcessGroup(pid, syncOnly)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        run.state = 'error'
        run.error = (err as Error).message
        this.emit(run)
        return
      }
    }
    run.state = 'stopped'
    run.error = null
    run.ports = []
    run.pid = null
    run.child = null
    run.startedAt = null
    this.emit(run)
  }

  private clearTimer(run: ManagedRun): void {
    if (run.runningTimer) {
      clearTimeout(run.runningTimer)
      run.runningTimer = null
    }
  }

  private lastLogLine(run: ManagedRun): string | null {
    return run.logs[run.logs.length - 1]?.text ?? null
  }

  private snapshot(run: ManagedRun): RunStatus {
    return {
      repoRoot: run.repoRoot,
      commandId: run.commandId,
      name: run.name,
      state: run.state,
      command: run.command,
      source: run.source,
      ports: [...run.ports],
      pid: run.pid,
      error: run.error,
      exitCode: run.exitCode,
      startedAt: run.startedAt,
    }
  }

  private emit(run: ManagedRun): void {
    this.opts.broadcast(this.snapshot(run))
  }
}
