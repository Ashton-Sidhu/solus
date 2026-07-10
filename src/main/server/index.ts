import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Server as HttpServer } from 'http'
import { SolusServer } from './server'
import { buildHttpServer } from './http'
import { getServerSettings, setRemoteAccess } from './settings'
import { isLoopbackHost, resolveEffectiveServerOptions } from './bind-policy'
import { attachWebSocketTransport } from '../transports/websocket'
import type { ControlPlane } from '../control-plane'
import type { NormalizedEvent, EnrichedError } from '../../shared/types'
import type { AgentId, IpcContext } from '../../shared/types'
import { registerWindowHandlers, type WindowDeps } from './handlers/window-handlers'
import { registerSessionHandlers, type SessionDeps } from './handlers/session-handlers'
import { registerWorktreeHandlers } from './handlers/worktree-handlers'
import { registerHistoryHandlers } from './handlers/history-handlers'
import type { FileDeps } from './handlers/file-handlers'
import { registerFolioHandlers } from './handlers/folio-handlers'
import { registerReviewHandlers } from './handlers/review-handlers'
import { registerAutomationHandlers } from './handlers/automation-handlers'
import { startAutomationScheduler, stopAutomationScheduler } from '../automations/automation-scheduler'
import { setAutomationSessionDispatcher } from '../automations/automation-runner'
import { setAutomationsChangedListener } from '../automations/automations-store'
import { setSessionController, setSessionCreator } from '../sessions/session-tools'
import { registerConnectionsHandlers } from './handlers/connections-handlers'
import { registerGoogleHandlers } from './handlers/google-handlers'
import { registerProviderHandlers } from './handlers/provider-handlers'
import { setPrsChangedNotifier } from '../providers/pr-tools'
import { registerMergeQueueHandlers } from './handlers/merge-queue-handlers'
import { registerSkillsHandlers } from './handlers/skills-handlers'
import { registerPinnedSessionsHandlers } from './handlers/pinned-sessions-handlers'
import { registerRunHandlers } from './handlers/run-handlers'
import { registerProjectConfigHandlers } from './handlers/project-config-handlers'
import { registerTasksHandlers } from './handlers/tasks-handlers'
import { setVoiceModelStatusListener } from '../model-downloader'
import { createLogger } from '../logger'
import type { RunManager } from '../run/run-manager'
import { PushNotificationService, attentionEntryKey, diffNewPushAttentionEntries } from '../notifications/push-service'
import { ensureClaimWindow } from './auth'
import { probeServerCapabilities, registerSetupHandlers } from './handlers/setup-handlers'
import packageJson from '../../../package.json'

const log = createLogger('main', 'server-boot')

const SOLUS_DIR = join(homedir(), '.solus')
const LOCK_FILE = join(SOLUS_DIR, 'server.lock')

export interface BootOptions {
  controlPlane: ControlPlane
  /** Optional dependencies provided by the Electron host. Headless mode passes none of these. */
  windowDeps?: WindowDeps
  fileDeps?: FileDeps
  agentIdFromContext: (ctx?: IpcContext) => AgentId
  /** Loopback-only auth preference. Non-loopback binds always force auth. */
  requireAuth?: boolean
  /** Override host (default 127.0.0.1, or 0.0.0.0 when remoteAccess is enabled). */
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
  const settings = getServerSettings()
  const initial = resolveEffectiveServerOptions({ host: opts.host, requireAuth: opts.requireAuth, remoteAccess: settings.remoteAccess })
  let host = initial.host
  let requireAuth = initial.requireAuth
  const port = opts.port ?? WEB_UI_PORT
  let actualPort = port

  const server = new SolusServer()
  const pushNotifications = new PushNotificationService()
  const hasDesktopHandlers = !!opts.windowDeps && !!opts.fileDeps

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
  if (opts.fileDeps) {
    const { registerFileHandlers } = await import('./handlers/file-handlers')
    registerFileHandlers(server, opts.fileDeps)
    const { setVoicePartialListener } = await import('../transcription')
    setVoicePartialListener((event) => server.broadcast('voice-partial', event))
  }
  if (opts.windowDeps) {
    const { registerThemeHandlers } = await import('./handlers/theme-handlers')
    registerThemeHandlers(server)
  }
  registerFolioHandlers(server)
  registerReviewHandlers(server)
  registerAutomationHandlers(server)
  // Let session-bound automations run their prompt inside the chat thread they
  // were created in (full conversation context), routed through the control plane.
  setAutomationSessionDispatcher((o) => opts.controlPlane.dispatchAutomationRun(o))
  // Push every automation mutation (saves, deletes, run transitions — incl.
  // background scheduler fires) to all connected clients so the UI stays live.
  setAutomationsChangedListener((event) => server.broadcast('automations-changed', event))
  setPrsChangedNotifier((cwd) => server.broadcast('prs-changed', cwd))
  // Let the create_session tool spawn fresh background sessions via the control plane.
  setSessionCreator((req) => opts.controlPlane.createSession(req))
  setSessionController({
    listSessions: (providers, projectPath) => opts.controlPlane.listSessionsForProviders(providers, projectPath),
    getSessionInfo: (provider, sessionId, projectPath) => opts.controlPlane.getSessionInfo(provider, sessionId, projectPath),
    loadSessionTail: (provider, sessionId, projectPath, limit) => opts.controlPlane.loadSession(provider, sessionId, projectPath, limit),
    liveStatus: (sessionId) => opts.controlPlane.liveSessionStatus(sessionId),
    promptSession: (sessionId, prompt) => opts.controlPlane.promptSession(sessionId, prompt),
    stopSession: (sessionId) => opts.controlPlane.stopSession(sessionId),
  })
  // Local, in-process automation scheduler. Fires time-based triggers while the
  // app is open and catches up missed fires on launch (local-only by design).
  startAutomationScheduler()
  if (opts.runManager) registerRunHandlers(server, opts.runManager)
  registerProjectConfigHandlers(server)
  registerTasksHandlers(server)
  registerGoogleHandlers(server, { getServerInfo: () => ({ host, port: actualPort }) })
  registerProviderHandlers(server)
  registerMergeQueueHandlers(server)
  registerSkillsHandlers(server, { controlPlane: opts.controlPlane })
  registerPinnedSessionsHandlers(server)
  registerSetupHandlers(server)

  server.register('getServerCapabilities', () => probeServerCapabilities({
    headless: !opts.windowDeps,
    desktopHandlers: hasDesktopHandlers,
    version: packageJson.version,
  }))

  // Attention: expose the active per-session entries and push every change to
  // all connected clients (payload is the full active list — see AttentionService).
  server.register('listAttention', async () => opts.controlPlane.attention.list())
  server.register('pushGetPublicKey', async () => pushNotifications.getPublicKey())
  server.register('pushSubscribe', (args, ctx) => {
    const [subscription] = args
    pushNotifications.subscribe(ctx.deviceId ?? '', ctx.deviceLabel ?? 'Web', subscription)
    return { ok: true }
  })
  server.register('pushUnsubscribe', (_args, ctx) => {
    if (!ctx.deviceId) throw new Error('Push subscriptions require a paired web device')
    return { ok: pushNotifications.unsubscribe(ctx.deviceId) }
  })

  let isDeviceOnline = (_deviceId: string) => false
  let lastAttentionKeys = new Set(opts.controlPlane.attention.list().map(attentionEntryKey))
  opts.controlPlane.attention.onChange((entries) => {
    server.broadcast('attention-changed', entries)

    const { created, nextKeys } = diffNewPushAttentionEntries(lastAttentionKeys, entries)
    lastAttentionKeys = nextKeys
    if (created.length === 0 || !pushNotifications.hasOfflineSubscription(isDeviceOnline)) return

    for (const entry of created) {
      void pushNotifications.sendToOfflineDevices(entry, isDeviceOnline).catch((err) => {
        log.warn(`web push fanout failed: ${String(err)}`)
      })
    }
  })
  setVoiceModelStatusListener((status) => server.broadcast('voice-model-status', status))

  opts.controlPlane.on('event', (tabId: string, event: NormalizedEvent) => {
    server.broadcast('normalized-event', tabId, event)
  })
  opts.controlPlane.on('error', (tabId: string, error: EnrichedError) => {
    server.broadcast('enriched-error', tabId, error)
  })

  ensureClaimWindow()

  const { server: http } = buildHttpServer({ host, port, staticDir: opts.staticDir, getHost: () => host, getPort: () => actualPort })
  const ws = attachWebSocketTransport(http, server, { requireAuth: () => requireAuth })
  server.subscribe('presence', (payload) => {
    const event = payload[0] as { type?: string; id?: string; deviceId?: string | null } | undefined
    if (event?.type === 'disconnect' && event.id) {
      opts.controlPlane.handleClientDisconnected(`ws:${event.id}`, event.deviceId ?? undefined)
    }
  })
  isDeviceOnline = (deviceId: string) => {
    for (const session of ws.sessions.values()) {
      if (session.deviceId === deviceId) return true
    }
    return false
  }

  // Walk forward from the requested port if it's taken — keeps the picked port
  // close to the deterministic default so the chance a saved web-client URL
  // still works stays high. EADDRINUSE on a contiguous range is common when
  // running Solus alongside another tool that grabbed the same hash bucket;
  // anything else (permission denied, etc.) bubbles up.
  const MAX_PORT_RETRIES = 20
  async function listenWithRetries(startPort: number): Promise<number> {
    let nextPort = startPort
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
          http.listen(nextPort, host)
        })
        return (http.address() as any)?.port ?? nextPort
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== 'EADDRINUSE' || i === MAX_PORT_RETRIES) throw err
        log.info(`port ${nextPort} in use, trying ${nextPort + 1}`)
        nextPort += 1
      }
    }
    return nextPort
  }

  actualPort = await listenWithRetries(port)

  if (actualPort !== port) {
    log.info(`server bound to ${host}:${actualPort} (default ${port} unavailable)`)
  }

  let lock = acquireLock(host, actualPort)
  if (!lock) {
    log.warn('lock acquisition failed; proceeding without single-instance enforcement')
  }

  async function rebind(remoteAccess: boolean): Promise<void> {
    const next = resolveEffectiveServerOptions({ host: opts.host, requireAuth: opts.requireAuth, remoteAccess })
    if (next.host === host && next.requireAuth === requireAuth) return
    host = next.host
    requireAuth = next.requireAuth
    lock?.release()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    actualPort = await listenWithRetries(actualPort)
    lock = acquireLock(host, actualPort)
    if (!lock) log.warn('lock acquisition failed after rebind; proceeding without single-instance enforcement')
    log.info(`Solus server rebound to http://${host}:${actualPort} (auth=${requireAuth ? 'on' : 'off'})`)
  }

  registerConnectionsHandlers(server, {
    getServerInfo: () => ({ host, port: actualPort, allowLan: !isLoopbackHost(host), remoteAccess: getServerSettings().remoteAccess, requireAuth }),
    getActiveSessions: () => [...ws.sessions.values()].map(s => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      deviceId: s.deviceId,
      connectedAt: s.connectedAt,
    })),
    setRemoteAccess: async (remoteAccess) => {
      const next = setRemoteAccess(remoteAccess)
      await rebind(next.remoteAccess)
      return { ...next, host, port: actualPort, allowLan: !isLoopbackHost(host), requireAuth }
    },
  })

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
