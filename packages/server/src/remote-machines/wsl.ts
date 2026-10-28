import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { WslDistro, WslDistroList } from '@solus/contracts/remote-machines'
import { reserveLoopbackPort, waitForHttpReady, type HelperProcess, type HelperSpawner } from '../devices/device-helpers'
import type { DeviceCommandOptions, DeviceCommandResult, DeviceCommandRunner } from '../devices/device-process'
import { createLogger } from '../logger'
import { quoteRemoteArg, type SshClient, type SshRunOptions, type SshTarget } from '../platform/ssh'

const log = createLogger('main', 'wsl')

/**
 * A WSL distro on this Windows host, added as a machine (docs/plans/windows.md
 * §13.6). It goes through the same add as a machine reached over SSH: the
 * provisioner's scripts run in the distro, the published installer puts the
 * Linux release there, and this host holds a forward to it. Only the transport
 * differs: `wsl.exe` instead of `ssh`.
 */

/** A distro is named as a target `wsl:<distro>`, so the forwards and the provisioner keep one kind of target. */
const TARGET_PREFIX = 'wsl:'

export function wslTarget(distro: string): SshTarget {
  return { destination: `${TARGET_PREFIX}${distro}` }
}

/** The distro a target names, or null for an SSH target. */
export function wslDistroOf(target: SshTarget): string | null {
  return target.destination.startsWith(TARGET_PREFIX) ? target.destination.slice(TARGET_PREFIX.length) : null
}

/** A loopback port here that reaches the server on the machine. */
export interface MachineForward {
  readonly localPort: number
  readonly remotePort: number
  /** Resolves when the forward ends. */
  readonly exited: Promise<number | null>
  close(): void
}

/** What the provisioner and the forwards need of a machine: run a script there, and reach a port there. */
export interface MachineClient {
  run(target: SshTarget, script: string | undefined, args: readonly string[], options?: SshRunOptions): Promise<DeviceCommandResult>
  forward(target: SshTarget, remotePort: number, readyPath?: string, preferredLocalPort?: number): Promise<MachineForward>
}

/** Sends a `wsl:` target to WSL and every other target to SSH. */
export function machineClient(ssh: SshClient, wsl: MachineClient): MachineClient {
  return {
    run: (target, script, args, options) => (wslDistroOf(target) !== null ? wsl : ssh).run(target, script, args, options),
    forward: (target, remotePort, readyPath, preferredLocalPort) => (wslDistroOf(target) !== null ? wsl : ssh).forward(target, remotePort, readyPath, preferredLocalPort),
  }
}

/** `wsl.exe`, named by its full path so a `wsl` earlier on PATH is never run. */
export function wslExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'wsl.exe')
}

/** `wsl.exe` writes UTF-16 unless WSL_UTF8 is set; an older WSL ignores it, so NULs are dropped too. */
const WSL_ENV = { WSL_UTF8: '1' }

/**
 * The distros in `wsl.exe --list --verbose`:
 *
 *     NAME            STATE           VERSION
 *   * Ubuntu          Running         2
 *     docker-desktop  Stopped         2
 *
 * The header and the state are translated on other Windows languages, and a
 * state can be several words ("Wird ausgeführt"), so rows are read by position:
 * an optional `*`, the name (a distro name has no spaces), the state, and the
 * version last. Only the English state is read as running.
 */
export function parseDistroList(output: string): WslDistro[] {
  const distros: WslDistro[] = []
  for (const rawLine of output.replaceAll('\0', '').split(/\r?\n/).slice(1)) {
    const line = rawLine.trim()
    if (!line) continue
    const isDefault = line.startsWith('*')
    const fields = (isDefault ? line.slice(1) : line).trim().split(/\s+/)
    const version = Number(fields.at(-1))
    if (fields.length < 3 || (version !== 1 && version !== 2)) continue
    distros.push({ name: fields[0], isDefault, isRunning: /^running$/i.test(fields.slice(1, -1).join(' ')), version })
  }
  return distros
}

/** The distros of the WSL on this host, or why there are none. Bounded: a stuck WSL answers "could not list", not "none". */
export async function listWslDistros(run: DeviceCommandRunner, platform: NodeJS.Platform = process.platform): Promise<WslDistroList> {
  if (platform !== 'win32') return { status: 'unavailable', message: 'WSL runs on Windows hosts only.' }
  const result = await run(wslExecutable(), ['--list', '--verbose'], { timeoutMs: 8_000, env: { ...process.env, ...WSL_ENV } })
    .catch((error: Error) => ({ code: -1, stdout: '', stderr: error.message }))
  const output = `${result.stdout}\n${result.stderr}`.replaceAll('\0', '')
  if (/not installed|wsl\.exe --install/i.test(output)) {
    return { status: 'unavailable', message: 'WSL is not installed on this computer. Run `wsl --install` as an administrator, then restart.' }
  }
  if (result.code !== 0) return { status: 'unavailable', message: `Could not list the WSL distros: ${output.trim() || `wsl.exe exited with ${result.code}`}` }
  const distros = parseDistroList(result.stdout)
  if (distros.length === 0) return { status: 'unavailable', message: 'WSL has no distro. Run `wsl --install -d Ubuntu`.' }
  return { status: 'ready', distros }
}

/**
 * A bridge for one TCP connection, run in the distro with the Node that the
 * Linux release installs: stdin goes to the server's loopback port, and its
 * answers come back on stdout. It needs no shell and no quoting beyond spaces,
 * and it works whichever way WSL networks the distro (NAT or mirrored).
 */
const BRIDGE_SCRIPT = "const s=require('net').connect(+process.argv[1],'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0))"
const RELEASE_NODE = '.local/share/solus/current/bin/node'
const FORWARD_READY_MS = 30_000

/** The arguments that start one bridge in `distro` to `remotePort`. */
export function bridgeArgs(distro: string, remotePort: number): string[] {
  return ['-d', distro, '--cd', '~', '--exec', RELEASE_NODE, '-e', BRIDGE_SCRIPT, String(remotePort)]
}

/** The arguments that run `command` (a POSIX shell line) in `distro`. */
export function runArgs(distro: string, command: string): string[] {
  return ['-d', distro, '--cd', '~', '--exec', 'sh', '-c', command]
}

export interface WslClientDeps {
  run: DeviceCommandRunner
  spawn: HelperSpawner
  /** Starts one bridge process with piped stdio; tests pass their own. */
  bridge?: (args: readonly string[]) => ChildProcess
  reservePort?: () => Promise<number>
  fetch?: typeof fetch
}

/** A forward into a distro: a loopback server here, one bridge per connection, and one process that keeps the distro running. */
class WslForward implements MachineForward {
  readonly exited: Promise<number | null>
  private readonly connections = new Set<{ socket: Socket; bridge: ChildProcess }>()

  constructor(private readonly server: Server, private readonly keepAlive: HelperProcess, readonly localPort: number, readonly remotePort: number) {
    this.exited = keepAlive.exited
  }

  track(socket: Socket, bridge: ChildProcess): void {
    const connection = { socket, bridge }
    this.connections.add(connection)
    const end = () => {
      this.connections.delete(connection)
      socket.destroy()
      bridge.kill()
    }
    socket.once('close', end)
    bridge.once('exit', end)
  }

  close(): void {
    this.server.close()
    for (const { socket, bridge } of this.connections) {
      socket.destroy()
      bridge.kill()
    }
    this.connections.clear()
    this.keepAlive.kill()
  }
}

export class WslClient implements MachineClient {
  constructor(private readonly deps: WslClientDeps) {}

  /** Run `script` in the distro, on stdin, as the provisioner does over SSH. */
  run(target: SshTarget, script: string | undefined, args: readonly string[], options: SshRunOptions = {}): Promise<DeviceCommandResult> {
    const distro = this.distro(target)
    const command = [options.command ?? 'sh -s --', ...args.map(quoteRemoteArg)].join(' ')
    const runOptions: DeviceCommandOptions = { timeoutMs: options.timeoutMs ?? 30_000, env: { ...process.env, ...WSL_ENV } }
    if (script !== undefined) runOptions.stdin = script
    return this.deps.run(wslExecutable(), runArgs(distro, command), runOptions)
  }

  /**
   * A loopback port here that reaches `remotePort` on the distro's loopback. WSL
   * stops a distro when no process from Windows runs in it, so the forward holds
   * one (`sleep infinity`) for as long as it is open; its end is the forward's end.
   */
  async forward(target: SshTarget, remotePort: number, readyPath?: string, preferredLocalPort?: number): Promise<MachineForward> {
    const distro = this.distro(target)
    const keepAlive = this.deps.spawn(wslExecutable(), ['-d', distro, '--exec', 'sleep', 'infinity'], { ...process.env, ...WSL_ENV })
    const server = createServer()
    const localPort = await this.listen(server, preferredLocalPort).catch((error: Error) => {
      keepAlive.kill()
      throw error
    })
    const forward = new WslForward(server, keepAlive, localPort, remotePort)
    const startBridge = this.deps.bridge ?? ((args: readonly string[]) => spawn(wslExecutable(), [...args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }))
    server.on('connection', (socket) => {
      const bridge = startBridge(bridgeArgs(distro, remotePort))
      bridge.once('error', (error) => {
        log.warn('wsl_bridge_failed', { distro, error: error.message })
        socket.destroy()
      })
      if (bridge.stdin && bridge.stdout) {
        socket.pipe(bridge.stdin)
        bridge.stdout.pipe(socket)
      }
      forward.track(socket, bridge)
    })
    if (readyPath === undefined) return forward
    let alive = true
    void forward.exited.then(() => { alive = false })
    if (!(await waitForHttpReady(`http://127.0.0.1:${localPort}${readyPath}`, FORWARD_READY_MS, this.deps.fetch ?? fetch, () => alive))) {
      forward.close()
      throw new Error(`Solus in ${distro} did not answer through the forward.`)
    }
    return forward
  }

  private distro(target: SshTarget): string {
    const distro = wslDistroOf(target)
    if (distro === null) throw new Error(`${target.destination} is not a WSL distro.`)
    return distro
  }

  /** Listens on the preferred loopback port when it is free, else on a fresh one. */
  private async listen(server: Server, preferred?: number): Promise<number> {
    const tryPort = (port: number) => new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (preferred && await tryPort(preferred)) return preferred
    const port = await (this.deps.reservePort ?? reserveLoopbackPort)()
    if (await tryPort(port)) return port
    throw new Error('No loopback port was free for the WSL forward.')
  }
}
