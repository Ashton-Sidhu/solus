import { spawn } from 'node:child_process'
import { z } from 'zod'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { resolveHomePath } from '../platform/paths'
import { createLogger } from '../logger'

const log = createLogger('devices', 'device-helpers.ts')

/** A long-lived helper process Solus started. Only its captured PID is ever signalled. */
export interface HelperProcess {
  readonly pid: number
  /** Resolves with the exit code when the process ends. */
  readonly exited: Promise<number | null>
  kill(): void
}

export type HelperSpawner = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => HelperProcess

export const spawnHelper: HelperSpawner = (command, args, env) => {
  const child = spawn(command, [...args], {
    cwd: resolveHomePath(homedir()),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: false,
  })
  const pid = child.pid ?? -1
  // Helper output is noise unless it fails; keep a short tail for diagnosis.
  let tail = ''
  const append = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2000) }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      log.warn('device_helper_spawn_failed', { command, error: error.message })
      resolve(127)
    })
    child.once('exit', (code) => {
      if (code !== 0 && code !== null) log.warn('device_helper_exited', { pid, code, tail: tail.slice(-500) })
      resolve(code)
    })
  })
  return {
    pid,
    exited,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    },
  }
}

const loopbackAddressSchema = z.object({ port: z.number().int().positive() })

/** The port a listening server bound, or 0 when it reports none. */
export function listeningPort(server: { address(): ReturnType<ReturnType<typeof createServer>['address']> }): number {
  const address = loopbackAddressSchema.safeParse(server.address())
  return address.success ? address.data.port : 0
}

/** A free loopback port. The helper binds it right after; a race fails readiness, not silently. */
export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = listeningPort(server)
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))))
    })
  })
}

/** Poll an HTTP readiness route until it answers 2xx or the deadline passes. */
export async function waitForHttpReady(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  isAlive: () => boolean = () => true,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive()) return false
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) })
      await response.arrayBuffer().catch(() => {})
      if (response.ok) return true
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}
