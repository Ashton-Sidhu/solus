import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import { createLogger } from '../logger'
import { platformServices } from '../platform/services'

const log = createLogger('main', 'resource-monitor.ts')

/** The protocol of native/resource-monitor. A child that says another is not used. */
const PROTOCOL_VERSION = 3
/** One line is one snapshot. A longer one is a fault, not data to buffer. */
const MAX_LINE_BYTES = 8 * 1024 * 1024

export type MonitorChild = ChildProcessByStdio<Writable, Readable, null>

/** The commands this server sends. The monitor has others that it does not need. */
type MonitorCommand =
  | { type: 'configure'; rootPid: number; sampleIntervalMs: number; externalProcesses: [] }
  | { type: 'setStreaming'; enabled: boolean }
  | { type: 'setSampleInterval'; sampleIntervalMs: number }

const snapshotSchema = z.object({
  type: z.literal('snapshot'),
  sampledAtUnixMs: z.number(),
  processes: z.array(z.object({
    pid: z.number(),
    ppid: z.number(),
    name: z.string(),
    command: z.string(),
    cpuPercent: z.number(),
    residentBytes: z.number(),
  })),
})
export type MonitorSnapshot = z.output<typeof snapshotSchema>

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: z.number() }),
  snapshotSchema,
  z.object({ type: z.literal('error'), code: z.string(), message: z.string(), recoverable: z.boolean() }),
])

function binaryName(): string {
  return process.platform === 'win32' ? 'solus-resource-monitor.exe' : 'solus-resource-monitor'
}

/** Where each way of running Solus keeps the binary, first match wins. */
export function resourceMonitorCandidates(env: NodeJS.ProcessEnv, appInfo: { appPath: string; isPackaged: boolean } | null): string[] {
  const name = binaryName()
  const candidates: string[] = []
  if (env.SOLUS_RESOURCE_MONITOR_PATH) candidates.push(env.SOLUS_RESOURCE_MONITOR_PATH)
  if (env.SOLUS_INSTALL_DIR) candidates.push(join(env.SOLUS_INSTALL_DIR, 'libexec', 'native', 'resource-monitor', name))
  // A packaged app's path is `Resources/app.asar`, and `extraResources` sits beside it.
  if (appInfo?.isPackaged) candidates.push(join(dirname(appInfo.appPath), 'resource-monitor', name))
  if (appInfo && !appInfo.isPackaged) candidates.push(join(appInfo.appPath, 'build', 'resource-monitor', 'bin', name))
  if (!appInfo && !env.SOLUS_INSTALL_DIR) candidates.push(join(process.cwd(), 'build', 'resource-monitor', 'bin', name))
  return candidates
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

export function resolveResourceMonitorPath(): string | null {
  const candidates = resourceMonitorCandidates(process.env, platformServices().appInfo ?? null)
  return candidates.find(isFile) ?? null
}

export interface ResourceMonitorOptions {
  path: string
  rootPid: number
  sampleIntervalMs: number
  onSnapshot: (snapshot: MonitorSnapshot) => void
  /** The monitor ended or broke. It is finished: make a new one to try again. */
  onFailed: () => void
  /** Injected by tests; a real monitor spawns its binary. */
  spawnChild?: (path: string) => MonitorChild
}

function spawnMonitor(path: string): MonitorChild {
  // No stderr pipe: the monitor reports faults as events, and an unread pipe can fill.
  return spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
}

/**
 * The server's end of the native resource monitor (docs/plans/resource-telemetry.md).
 * One JSON line each way. A child that fails ends this object and nothing else:
 * no fault here reaches the server. The child exits when its stdin closes, so it
 * cannot outlive the server.
 */
export class ResourceMonitor {
  private readonly child: MonitorChild
  private buffered = ''
  private finished = false

  constructor(private readonly options: ResourceMonitorOptions) {
    this.child = (options.spawnChild ?? spawnMonitor)(options.path)
    this.child.on('error', (error) => this.fail('resource_monitor_spawn_failed', error.message))
    this.child.on('close', (code) => this.fail('resource_monitor_exited', String(code)))
    // A write to a child that just died arrives as an error on the pipe, then `close`.
    this.child.stdin.on('error', () => {})
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk))
    this.send({ type: 'configure', rootPid: options.rootPid, sampleIntervalMs: options.sampleIntervalMs, externalProcesses: [] })
    this.send({ type: 'setStreaming', enabled: true })
  }

  /** Sample on a timer, or stop with 0. The stopped child waits on its stdin. */
  setSampling(sampleIntervalMs: number): void {
    this.send({ type: 'setStreaming', enabled: sampleIntervalMs > 0 })
    this.send({ type: 'setSampleInterval', sampleIntervalMs })
  }

  /** End the child, for good. */
  stop(): void {
    if (this.finished) return
    this.finished = true
    this.child.stdin.end()
  }

  private send(command: MonitorCommand): void {
    if (this.finished) return
    this.child.stdin.write(`${JSON.stringify({ version: PROTOCOL_VERSION, ...command })}\n`)
  }

  private receive(chunk: string): void {
    this.buffered += chunk
    let newline = this.buffered.indexOf('\n')
    while (newline >= 0 && !this.finished) {
      const line = this.buffered.slice(0, newline)
      this.buffered = this.buffered.slice(newline + 1)
      this.handleLine(line)
      newline = this.buffered.indexOf('\n')
    }
    if (this.buffered.length > MAX_LINE_BYTES) this.fail('resource_monitor_line_too_long', String(this.buffered.length))
  }

  private handleLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.fail('resource_monitor_bad_output', line.slice(0, 200))
      return
    }
    // A later monitor may add events; only a known event with a bad shape is a fault.
    const known = z.object({ type: z.enum(['hello', 'snapshot', 'error']) }).safeParse(raw)
    if (!known.success) return
    const event = eventSchema.safeParse(raw)
    if (!event.success) {
      this.fail('resource_monitor_bad_output', event.error.message.slice(0, 200))
      return
    }
    if (event.data.type === 'snapshot') this.options.onSnapshot(event.data)
    else if (event.data.type === 'hello') {
      if (event.data.version !== PROTOCOL_VERSION) this.fail('resource_monitor_protocol_mismatch', String(event.data.version))
    } else if (!event.data.recoverable) this.fail('resource_monitor_error', event.data.message)
    else log.warn('resource_monitor_reported', { code: event.data.code, detail: event.data.message })
  }

  private fail(reason: string, detail: string): void {
    if (this.finished) return
    this.finished = true
    log.warn(reason, { detail })
    // Ends a child that is alive but says what this server cannot read.
    this.child.stdin.end()
    this.child.kill()
    this.options.onFailed()
  }
}
