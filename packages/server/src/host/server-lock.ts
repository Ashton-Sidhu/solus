import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { join } from 'path'
import { z } from 'zod'
import { solusDir } from '../platform/paths'
import { createLogger } from '../logger'

const log = createLogger('main', 'server-lock')

/** `server.lock` in the data folder: the server that owns the folder, and where it listens. */
export interface ServerLock {
  pid: number
  port: number
  host: string
  startedAt: number
}

const serverLockSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  host: z.string(),
  startedAt: z.number(),
}).strict()

function lockFile(): string {
  return join(solusDir(), 'server.lock')
}

function readLock(): ServerLock | null {
  if (!existsSync(lockFile())) return null
  try {
    return serverLockSchema.parse(JSON.parse(readFileSync(lockFile(), 'utf-8')))
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Whether something accepts a connection on the lock's port. */
function portAccepts(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return new Promise((resolve) => {
    const socket = connect({ host: target, port })
    const done = (accepted: boolean) => { socket.destroy(); resolve(accepted) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * Another server that owns this data folder and still runs, or null. Two
 * servers on one folder share one SQLite database, one host identity, and one
 * set of sessions, so the second must not boot. A live process id alone is not
 * proof: Windows reuses them, so the lock's port must also answer.
 */
export async function otherServerOnDataFolder(): Promise<ServerLock | null> {
  const existing = readLock()
  if (!existing || existing.pid === process.pid || !isAlive(existing.pid)) return null
  return (await portAccepts(existing.host, existing.port)) ? existing : null
}

/** Why a boot stopped: the folder belongs to another running server. */
export function dataFolderInUseMessage(owner: ServerLock): string {
  return `Another Solus server (process ${owner.pid}, port ${owner.port}) is using this data folder. `
    + 'Stop that server, or start this one with SOLUS_DATA_DIR set to another folder.'
}

/**
 * Takes the single-instance lock. If a live Solus instance owns the lock,
 * returns null. Stale locks (dead PID) are reclaimed. Boot has already refused
 * a folder another server owns (`otherServerOnDataFolder`), so null here means
 * that server started in between.
 */
export function acquireLock(host: string, port: number): { release(): void } | null {
  const stateDir = solusDir()
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })

  const existing = readLock()
  if (existing && isAlive(existing.pid)) {
    log.warn('solus_already_running', { pid: existing.pid, host: existing.host, port: existing.port })
    return null
  }

  const body: ServerLock = { pid: process.pid, port, host, startedAt: Date.now() }
  writeFileSync(lockFile(), JSON.stringify(body, null, 2), { mode: 0o600 })

  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      try { if (existsSync(lockFile())) unlinkSync(lockFile()) } catch {}
    },
  }
}
