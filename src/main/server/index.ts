import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Server as HttpServer } from 'http'
import { SolusServer } from './server'
import { buildHttpServer } from './http'
import { attachWebSocketTransport } from '../transports/websocket'
import type { ControlPlane } from '../control-plane'
import type { NormalizedEvent, EnrichedError } from '../../shared/types'
import type { AgentId, IpcContext } from '../../shared/types'
import { registerWindowHandlers, type WindowDeps } from './handlers/window-handlers'
import { registerSessionHandlers, type SessionDeps } from './handlers/session-handlers'
import { registerWorktreeHandlers } from './handlers/worktree-handlers'
import { registerHistoryHandlers } from './handlers/history-handlers'
import { registerFileHandlers, type FileDeps } from './handlers/file-handlers'
import { registerThemeHandlers } from './handlers/theme-handlers'
import { registerFolioHandlers } from './handlers/folio-handlers'
import { registerReviewHandlers } from './handlers/review-handlers'
import { registerAutomationHandlers } from './handlers/automation-handlers'
import { startAutomationScheduler, stopAutomationScheduler } from '../automations/automation-scheduler'
import { setAutomationSessionDispatcher } from '../automations/automation-runner'
import { setAutomationsChangedListener } from '../automations/automations-store'
import { setSessionCreator } from '../sessions/session-tools'
import { registerConnectionsHandlers } from './handlers/connections-handlers'
import { registerGoogleHandlers } from './handlers/google-handlers'
import { registerProviderHandlers } from './handlers/provider-handlers'
import { registerMergeQueueHandlers } from './handlers/merge-queue-handlers'
import { registerSkillsHandlers } from './handlers/skills-handlers'
import { registerPinnedSessionsHandlers } from './handlers/pinned-sessions-handlers'
import { registerRunHandlers } from './handlers/run-handlers'
import { registerProjectConfigHandlers } from './handlers/project-config-handlers'
import { registerTasksHandlers } from './handlers/tasks-handlers'
import { createLogger } from '../logger'
import type { RunManager } from '../run/run-manager'

const log = createLogger('main', 'server-boot')

const SOLUS_DIR = join(homedir(), '.solus')
const LOCK_FILE = join(SOLUS_DIR, 'server.lock')

export interface BootOptions {
  controlPlane: ControlPlane
  /** Optional dependencies provided by the Electron host. Headless mode passes none of these. */
  windowDeps?: WindowDeps
  fileDeps?: FileDeps
  agentIdFromContext: (ctx?: IpcContext) => AgentId
  /** Set to false on first launch to keep loopback dev frictionless; production should require auth. */
  requireAuth?: boolean
  /** Override host (default 0.0.0.0). */
  host?: string
  /** Override port (default = WEB_UI_PORT = 3000, or SOLUS_PORT env var). */
  port?: number
  /** Path to the bundled web client static files. */
  staticDir?: string
  runManager?: RunManager
}

export interface BootedServer {
  server: SolusServer
  http: HttpServer
  host: string
  port: number
  /**
   * Drains in-flight RPCs (best-effort), closes WS sockets with code 1001,
   * then shuts the HTTP server. Removes the lock file last.
   */
  shutdown(): Promise<void>
}

/** Fixed port for the Solus web UI. Override with the SOLUS_PORT env var. */
export const WEB_UI_PORT = parseInt(process.env.SOLUS_PORT ?? '') || 3000

interface LockFileBody {
  pid: number
  port: number
  host: string
  startedAt: number
}

function readLock(): LockFileBody | null {
  if (!existsSync(LOCK_FILE)) return null
  try {
    const raw = readFileSync(LOCK_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as LockFileBody
    if (!parsed?.pid) return null
    return parsed
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Acquires the single-instance lock. If a live Solus instance owns the lock,
 * returns null and the caller should refuse to boot a second server. Stale
 * locks (dead PID) are reclaimed.
 */
export function acquireLock(host: string, port: number): { release(): void } | null {
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })

  const existing = readLock()
  if (existing && isAlive(existing.pid)) {
    log.warn(`solus already running pid=${existing.pid} host=${existing.host} port=${existing.port}`)
    return null
  }

  const body: LockFileBody = { pid: process.pid, port, host, startedAt: Date.now() }
  writeFileSync(LOCK_FILE, JSON.stringify(body, null, 2), { mode: 0o600 })

  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      try { if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE) } catch {}
    },
  }
}

export async function bootServer(opts: BootOptions): Promise<BootedServer> {
  const host = opts.host ?? '0.0.0.0'
  const port = opts.port ?? WEB_UI_PORT

  const server = new SolusServer()

  // Register handlers. Each group only registers what its deps support — the
  // headless server (no Electron window) skips window/file groups.
  if (opts.windowDeps) registerWindowHandlers(server, opts.windowDeps)

  const sessionDeps: SessionDeps = {
    controlPlane: opts.controlPlane,
    agentIdFromContext: opts.agentIdFromContext,
  }
  registerSessionHandlers(server, sessionDeps)

  registerWorktreeHandlers(server, { controlPlane: opts.controlPlane })
  registerHistoryHandlers(server, {
    controlPlane: opts.controlPlane,
    agentIdFromContext: opts.agentIdFromContext,
  })
  if (opts.fileDeps) registerFileHandlers(server, opts.fileDeps)
  registerThemeHandlers(server)
  registerFolioHandlers(server)
  registerReviewHandlers(server)
  registerAutomationHandlers(server)
  // Let session-bound automations run their prompt inside the chat thread they
  // were created in (full conversation context), routed through the control plane.
  setAutomationSessionDispatcher((o) => opts.controlPlane.dispatchAutomationRun(o))
  // Push every automation mutation (saves, deletes, run transitions — incl.
  // background scheduler fires) to all connected clients so the UI stays live.
  setAutomationsChangedListener((event) => server.broadcast('automations-changed', event))
  // Let the create_session tool spawn fresh background sessions via the control plane.
  setSessionCreator((req) => opts.controlPlane.createSession(req))
  // Local, in-process automation scheduler. Fires time-based triggers while the
  // app is open and catches up missed fires on launch (local-only by design).
  startAutomationScheduler()
  if (opts.runManager) registerRunHandlers(server, opts.runManager)
  registerProjectConfigHandlers(server)
  registerTasksHandlers(server)
  registerGoogleHandlers(server)
  registerProviderHandlers(server)
  registerMergeQueueHandlers(server)
  registerSkillsHandlers(server, { controlPlane: opts.controlPlane })
  registerPinnedSessionsHandlers(server)

  opts.controlPlane.on('event', (tabId: string, event: NormalizedEvent) => {
    server.broadcast('normalized-event', tabId, event)
  })
  opts.controlPlane.on('error', (tabId: string, error: EnrichedError) => {
    server.broadcast('enriched-error', tabId, error)
  })

  const { server: http } = buildHttpServer({ host, port, staticDir: opts.staticDir })
  const ws = attachWebSocketTransport(http, server, { requireAuth: opts.requireAuth ?? true })

  // Walk forward from the requested port if it's taken — keeps the picked port
  // close to the deterministic default so the chance a saved web-client URL
  // still works stays high. EADDRINUSE on a contiguous range is common when
  // running Solus alongside another tool that grabbed the same hash bucket;
  // anything else (permission denied, etc.) bubbles up.
  const MAX_PORT_RETRIES = 20
  let attemptedPort = port
  for (let i = 0; i <= MAX_PORT_RETRIES; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          http.off('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          http.off('error', onError)
          resolve()
        }
        http.once('error', onError)
        http.once('listening', onListening)
        http.listen(attemptedPort, host)
      })
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'EADDRINUSE' || i === MAX_PORT_RETRIES) throw err
      log.info(`port ${attemptedPort} in use, trying ${attemptedPort + 1}`)
      attemptedPort += 1
    }
  }

  const actualPort = (http.address() as any)?.port ?? attemptedPort
  if (actualPort !== port) {
    log.info(`server bound to ${host}:${actualPort} (default ${port} unavailable)`)
  }

  registerConnectionsHandlers(server, {
    getServerInfo: () => ({ host, port: actualPort, allowLan: host !== '127.0.0.1' }),
    getActiveSessions: () => [...ws.sessions.values()].map(s => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      deviceId: s.deviceId,
      connectedAt: s.connectedAt,
    })),
  })

  const lock = acquireLock(host, actualPort)
  if (!lock) {
    log.warn('lock acquisition failed; proceeding without single-instance enforcement')
  }

  log.info(`Solus server listening on http://${host}:${actualPort}`)
  console.log(`\n  Solus web UI → http://localhost:${actualPort}\n`)

  let shutdownPromise: Promise<void> | null = null

  return {
    server,
    http,
    host,
    port: actualPort,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        stopAutomationScheduler()
        try { ws.close() } catch (err) { log.warn(`ws.close failed: ${err}`) }
        await new Promise<void>((resolve) => http.close(() => resolve()))
        lock?.release()
      })()
      return shutdownPromise
    },
  }
}
