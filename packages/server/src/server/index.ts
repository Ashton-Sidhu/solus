import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { hostname } from 'os'
import { z } from 'zod'
import { createServer as createNodeHttpServer, type IncomingMessage, type Server as HttpServer } from 'http'
import { SolusServer } from './server'
import { buildHttpServer } from './http'
import { HostGrantVerifier } from './host-grants'
import { CloudflaredConnector, resolveCloudflaredBinary } from './uplink/connector'
import { UplinkLinkManager } from './uplink/link'
import type { UplinkLinkConfig } from '@solus/contracts/uplink'
import { registerUplinkHandlers } from './handlers/uplink-handlers'
import { hostOperatingSystem } from '../platform/host-operating-system'
import { getServerSettings, setRemoteAccess, setTrustLocalNetwork } from './settings'
import { isLoopbackHost, resolveEffectiveServerOptions } from './bind-policy'
import { isTrustedRequesterAddress } from './trusted-requesters'
import { attachWebSocketTransport } from '../transports/websocket'
import { ResponseReceiptBudget } from '../transports/response-receipt-cache'
import { ClientEventRegistry } from '../events/client-event-registry'
import { HostEventPublisher } from '../events/host-event-publisher'
import { BrowserFrameChannel } from '../browser/browser-frame-channel'
import type { ControlPlane } from '../control-plane'
import type { AgentMetadata, NormalizedEvent, EnrichedError, SessionIndexUpdatedEvent } from '@solus/contracts/types'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { AgentId, IpcContext } from '@solus/contracts/types'
import { DEFAULT_SERVER_PORT } from '@solus/contracts/types'
import { registerWindowHandlers, type WindowDeps } from './handlers/window-handlers'
import { enrichAgentMetadata, registerSessionHandlers, type SessionDeps } from './handlers/session-handlers'
import { registerWorktreeHandlers } from './handlers/worktree-handlers'
import { registerGitPublishHandlers } from './handlers/git-publish-handlers'
import { registerFilesystemHandlers } from './handlers/filesystem-handlers'
import { registerCodeIntelHandlers } from './handlers/code-intel-handlers'
import { CodeIntelManager } from '../code-intel/code-intel-manager'
import { registerHistoryHandlers } from './handlers/history-handlers'
import { registerFolioHandlers } from './handlers/folio-handlers'
import { registerReviewHandlers } from './handlers/review-handlers'
import { registerAutomationHandlers } from './handlers/automation-handlers'
import { startAutomationScheduler, stopAutomationScheduler } from '../automations/automation-scheduler'
import { setAutomationBackgroundSessionDispatcher, setAutomationSessionDispatcher, setAutomationWorktreeNameGenerator } from '../automations/automation-runner'
import { generateWorktreeName } from '../git/worktree-name'
import { onAutomationsChanged } from '../automations/automations-store'
import { setSessionController, setSessionCreator } from '../sessions/session-tools'
import { onAnnotationsChanged } from '../annotations/annotation-events'
import { registerConnectionsHandlers } from './handlers/connections-handlers'
import { registerSettingsHandlers } from './handlers/settings-handlers'
import { isLanDiscoveryDisabled, startLanDiscoveryService, type LanDiscoveryService } from './lan-discovery'
import { registerGoogleHandlers } from './handlers/google-handlers'
import { prepareReviewGuidePrContext, registerProviderHandlers } from './handlers/provider-handlers'
import { onPrsChanged } from '../providers/pr-tools'
import { PrReconciler } from '../prs/pr-reconciler'
import { registerCloudflareHandlers } from './handlers/cloudflare-handlers'
import { registerAtlassianHandlers } from './handlers/atlassian-handlers'
import { setOAuthCompletedListener as setAtlassianOAuthCompletedListener } from '../atlassian/oauth'
import { setConnectionConnectNeededListener } from '../connections/connection-tools'
import { setHostConfigChangedListener } from './config-tools'
import { registerBrowserHandlers } from './handlers/browser-handlers'
import { registerStackHandlers } from './handlers/stack-handlers'
import { registerChecksHandlers } from './handlers/checks-handlers'
import { registerUsageHandlers } from './handlers/usage-handlers'
import { registerSkillsHandlers } from './handlers/skills-handlers'
import { registerPinnedSessionsHandlers } from './handlers/pinned-sessions-handlers'
import { registerSavedPromptsHandlers } from './handlers/saved-prompts-handlers'
import { registerProjectConfigHandlers } from './handlers/project-config-handlers'
import { registerTasksHandlers } from './handlers/tasks-handlers'
import { setVoiceModelStatusListener } from '../model-downloader'
import { createLogger, isDebugEnabled } from '../logger'
import { PushNotificationService, attentionEntryKey, diffNewPushAttentionEntries } from '../notifications/push-service'
import { getInstallationId } from './auth'
import { probeServerCapabilities, registerSetupHandlers } from './handlers/setup-handlers'
import packageJson from '../../../../package.json'
import { solusDir } from '../platform/paths'
import { onTasksChanged } from '../tasks/task-store'
import { onOutboxChanged } from '../outbox/outbox-store'
import { registerOutboxHandlers } from './handlers/outbox-handlers'
import { registerTaskOutboxApplier } from '../tasks/task-applier'
import { registerWorkOutboxApplier } from '../folio/work-applier'
import { agentTargetFromMetadata } from '../agents/agent-targets'
import { recordSessionDelegation } from '../sessions/session-delegations'
import { registerAttachmentHandlers } from './handlers/attachment-handlers'
import { registerAssetHandlers } from './handlers/asset-handlers'
import { registerCapabilityHandlers } from './handlers/capability-handlers'
import { registerObservabilityHandlers } from './handlers/observability-handlers'
import { startMetricsRollover, stopMetricsRollover } from '../observability/rollover'
import { projectSessionEvent, serializedBytes } from './result-projection'

const log = createLogger('main', 'server-boot')

export interface BootOptions {
  controlPlane: ControlPlane
  /** Optional dependencies provided by the Electron host. Headless mode passes none of these. */
  windowDeps?: WindowDeps
  /** Optional host-owned RPC groups, registered only by clients with native capabilities. */
  registerHostHandlers?: (server: SolusServer) => void | Promise<void>
  agentIdFromContext: (ctx?: IpcContext) => AgentId
  /** Loopback-only auth preference. Non-loopback binds always force auth. */
  requireAuth?: boolean
  /** Override host (default 127.0.0.1, or 0.0.0.0 when remoteAccess is enabled). */
  host?: string
  /** Override port (default = WEB_UI_PORT = 3000, or SOLUS_PORT env var). */
  port?: number
  /** Path to the bundled web client static files. */
  staticDir?: string
  /** Optional voice transcription implementation supplied by the desktop host. */
  transcribeAudio?: (samples: Float32Array) => Promise<{ error: string | null; transcript: string | null }>
}

export interface BootedServer {
  server: SolusServer
  events: HostEventPublisher
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
export const WEB_UI_PORT = parseInt(process.env.SOLUS_PORT ?? '') || DEFAULT_SERVER_PORT
/**
 * Loopback port the tunnel connector forwards to (docs/plans/personal-uplink.md, H3).
 * A second listener on the same routes, tagged so nothing arriving through it is ever
 * a trusted requester. Override with SOLUS_TUNNEL_PORT.
 */
export const DEFAULT_TUNNEL_LISTENER_PORT = parseInt(process.env.SOLUS_TUNNEL_PORT ?? '') || 34118
const SESSION_INDEX_POLL_MS = 60_000
const SESSION_INDEX_POLL_JITTER_MS = 5_000
const SESSION_INDEX_POLL_MAX_BACKOFF_MS = 5 * 60_000

interface LockFileBody {
  pid: number
  port: number
  host: string
  startedAt: number
}

const lockFileSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  host: z.string(),
  startedAt: z.number(),
}).strict()
const systemErrorSchema = z.object({ code: z.string().optional() })

function readLock(): LockFileBody | null {
  const lockFile = join(solusDir(), 'server.lock')
  if (!existsSync(lockFile)) return null
  try {
    const raw = readFileSync(lockFile, 'utf-8')
    return lockFileSchema.parse(JSON.parse(raw))
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
  const stateDir = solusDir()
  const lockFile = join(stateDir, 'server.lock')
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })

  const existing = readLock()
  if (existing && isAlive(existing.pid)) {
    log.warn('solus_already_running', { pid: existing.pid, host: existing.host, port: existing.port })
    return null
  }

  const body: LockFileBody = { pid: process.pid, port, host, startedAt: Date.now() }
  writeFileSync(lockFile, JSON.stringify(body, null, 2), { mode: 0o600 })

  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      try { if (existsSync(lockFile)) unlinkSync(lockFile) } catch {}
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
  const clientEvents = new ClientEventRegistry()
  const events = new HostEventPublisher(clientEvents)
  // Streamed browser frames bypass the typed-event envelope: the transport
  // registers a per-client binary delivery here, the browser registry publishes
  // only to the clients watching each page.
  const browserFrames = new BrowserFrameChannel()
  const codeIntel = new CodeIntelManager()
  const domainEventUnsubscribes = [
    codeIntel.onStatusChanged((status) => events.broadcast('codeIntel.statusChanged', status)),
    onAutomationsChanged((event) => events.broadcast('automation.changed', event)),
    onPrsChanged((projectRoot) => events.broadcast('prs.invalidated', { projectRoot })),
    onAnnotationsChanged((change) => events.broadcast('annotations.changed', change)),
    onTasksChanged(() => events.broadcast('tasks.invalidated', {})),
    onOutboxChanged(() => events.broadcast('outbox.changed', {})),
  ]
  // A pull request merged on the code host announces nothing to Solus, so the
  // host asks on the workspace's behalf and turns what it finds into the same
  // event an in-Solus merge sends.
  const prReconciler = new PrReconciler({
    announce: (projectRoot, detail) => events.broadcast('pr.lifecycleChanged', { projectRoot, detail }),
  })
  prReconciler.start()
  const pushNotifications = new PushNotificationService()
  const hasDesktopHandlers = !!opts.windowDeps && !!opts.registerHostHandlers

  // Register handlers. Each group only registers what its deps support — the
  // headless server (no Electron window) skips window/file groups.
  if (opts.windowDeps) registerWindowHandlers(server, opts.windowDeps)

  const sessionDeps: SessionDeps = {
    controlPlane: opts.controlPlane,
    agentIdFromContext: opts.agentIdFromContext,
  }
  registerSessionHandlers(server, sessionDeps)
  registerSettingsHandlers(server, {
    controlPlane: opts.controlPlane,
    onHostConfigChanged: (snapshot) => events.broadcast('config.changed', snapshot),
  })

  registerWorktreeHandlers(server, { controlPlane: opts.controlPlane, events })
  registerGitPublishHandlers(server)
  // Browsing a host's filesystem must work headless — that is the whole point
  // of pairing a server that has no window.
  registerFilesystemHandlers(server)
  registerCodeIntelHandlers(server, { codeIntel })
  registerAttachmentHandlers(server)
  registerAssetHandlers(server)
  registerHistoryHandlers(server, {
    controlPlane: opts.controlPlane,
    events,
    agentIdFromContext: opts.agentIdFromContext,
  })
  await opts.registerHostHandlers?.(server)
  registerFolioHandlers(server)
  registerReviewHandlers(server, opts.controlPlane, events, prepareReviewGuidePrContext)
  registerAutomationHandlers(server)
  // Let session-bound automations run their prompt inside the chat thread they
  // were created in (full conversation context), routed through the control plane.
  setAutomationSessionDispatcher((o) => opts.controlPlane.dispatchAutomationRun(o))
  // Isolated automations use the same headless ControlPlane lifecycle as normal
  // background sessions, so their live transcript can be opened mid-run.
  setAutomationBackgroundSessionDispatcher((o) => opts.controlPlane.startAutomationSession(o))
  setAutomationWorktreeNameGenerator((prompt, cwd, abortSignal) => (
    generateWorktreeName(opts.controlPlane, prompt, cwd, abortSignal)
  ))
  // Push every automation mutation (saves, deletes, run transitions — incl.
  // background scheduler fires) to all connected clients so the UI stays live.
  // Let the create_session tool spawn fresh background sessions via the control plane.
  setSessionCreator((req) => opts.controlPlane.createSession(req))
  setSessionController({
    listAgentTargets: async () => Promise.all(
      opts.controlPlane
        .getBackendIds()
        .map((id) => opts.controlPlane.getMetadataFor(id))
        .filter((metadata): metadata is AgentMetadata => metadata !== undefined)
        .map(async (metadata) => agentTargetFromMetadata(await enrichAgentMetadata(metadata))),
    ),
    listSessions: (providers, projectPath) => opts.controlPlane.listSessionsForProviders(providers, projectPath),
    getSessionInfo: (sessionId) => opts.controlPlane.getSessionInfo(sessionId),
    loadSessionTail: (provider, sessionId, projectPath, limit) => opts.controlPlane.loadSession(provider, sessionId, projectPath, limit),
    liveStatus: (sessionId) => opts.controlPlane.liveSessionStatus(sessionId),
    pendingInputEvents: (sessionId) => opts.controlPlane.pendingInputEventsForSession(sessionId),
    promptSession: (sessionId, prompt, delivery, options) => opts.controlPlane.promptSession(sessionId, prompt, delivery, options),
    watchSessionSettled: (targetSessionId, callerSessionId, watch) => opts.controlPlane.watchSessionSettled(targetSessionId, callerSessionId, watch),
    stopSession: (sessionId) => opts.controlPlane.stopSession(sessionId),
    answerQuestion: (questionId, answers) => opts.controlPlane.respondToQuestion(questionId, answers),
    respondPermission: (questionId, optionId, revisedPlan) => opts.controlPlane.respondToPermission(questionId, optionId, revisedPlan),
    loadPlanContent: (provider, sessionId, projectPath, planToolUseId) =>
      opts.controlPlane.loadPlanContent(provider, sessionId, projectPath, planToolUseId),
    listPlans: (provider, projectPath, allProjects) => opts.controlPlane.listPlans(provider, projectPath, allProjects),
    invalidatePlanCaches: (sessionId) => opts.controlPlane.invalidatePlanCaches(sessionId),
    recordSessionDelegation,
  })
  // Agent-conversation cards drive sessions that have no bound tab in the renderer.
  server.register('promptSession', async (args) => {
    const [sessionId, prompt, delivery] = args
    if (!sessionId.trim()) throw new Error('promptSession requires a session id')
    if (!prompt.trim()) throw new Error('promptSession requires a non-empty prompt')
    return opts.controlPlane.promptSession(sessionId, prompt, delivery === 'steer' ? 'steer' : 'queue')
  })
  server.register('stopSession', async (args) => {
    const [sessionId] = args
    if (!sessionId.trim()) throw new Error('stopSession requires a session id')
    return opts.controlPlane.stopSession(sessionId)
  })
  // Local, in-process automation scheduler. Fires time-based triggers while the
  // app is open and catches up missed fires on launch (local-only by design).
  startAutomationScheduler()
  startMetricsRollover(() => getServerSettings().metricsRetentionDays)
  registerObservabilityHandlers(server, { controlPlane: opts.controlPlane })
  registerProjectConfigHandlers(server)
  registerTasksHandlers(server)
  registerOutboxHandlers(server)
  // Any host can own tasks (and their works), so the owner-side appliers
  // register unconditionally.
  registerTaskOutboxApplier()
  registerWorkOutboxApplier()
  registerGoogleHandlers(server, { getServerInfo: () => ({ host, port: actualPort }) })
  registerCloudflareHandlers(server)
  registerAtlassianHandlers(server)
  setAtlassianOAuthCompletedListener((event) => events.broadcast('atlassian.oauthCompleted', event))
  setConnectionConnectNeededListener((request) => events.broadcast('connection.connectNeeded', request))
  // A config write from an agent tool converges every mounted client the same
  // way one made in Settings does.
  setHostConfigChangedListener((snapshot) => events.broadcast('config.changed', snapshot))
  registerProviderHandlers(server, {
    dispatcher: opts.controlPlane,
    events,
    isWorktreeInUse: (path) => opts.controlPlane.listGitContexts().some((context) => context.worktreePath === path),
  })
  registerStackHandlers(server, events)
  const checksHandlers = registerChecksHandlers(server, { events })
  registerUsageHandlers(server, { controlPlane: opts.controlPlane, events })
  registerSkillsHandlers(server, { controlPlane: opts.controlPlane })
  registerPinnedSessionsHandlers(server)
  registerSavedPromptsHandlers(server)
  registerSetupHandlers(server, { events })
  // Browser pages are server-owned so an agent addresses the same page the user
  // sees, and keeps addressing it after the pane closes. A headless host still
  // registers the domain: it can discover targets and hold pages, and reports
  // `no-surface` rather than pretending to drive one.
  const browserRegistry = registerBrowserHandlers(server, { events, ownPort: () => actualPort, frames: browserFrames })

  server.register('getServerCapabilities', () => probeServerCapabilities({
    headless: !opts.windowDeps,
    desktopHandlers: hasDesktopHandlers,
    version: packageJson.version,
  }))
  registerCapabilityHandlers(server)

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
    events.broadcast('attention.snapshotChanged', { entries })

    const { created, nextKeys } = diffNewPushAttentionEntries(lastAttentionKeys, entries)
    lastAttentionKeys = nextKeys
    if (created.length === 0 || !pushNotifications.hasOfflineSubscription(isDeviceOnline)) return

    for (const entry of created) {
      void pushNotifications.sendToOfflineDevices(entry, isDeviceOnline, getInstallationId()).catch((err) => {
        log.warn('web_push_fanout_failed', { error: err instanceof Error ? err.message : String(err) })
      })
    }
  })
  setVoiceModelStatusListener((status) => events.broadcast('voice.modelStatusChanged', status))

  // One publish per watching client. Two panes on one renderer are one client
  // and receive one payload; desktop and web are two, with the same payload.
  opts.controlPlane.on('event', (sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }) => {
    const projectedEvent = projectSessionEvent(event)
    if (!projectedEvent) return
    // Measure the projected event — the payload that actually ships to clients.
    // Serializing the raw event would re-inflate the tool bodies projection
    // exists to strip, on every single event.
    if (isDebugEnabled()) {
      const details = {
        sessionId,
        eventType: event.type,
        bytes: serializedBytes(projectedEvent),
      }
      if ('toolName' in event && event.toolName) Object.assign(details, { toolName: event.toolName })
      log.debug('session_event_bytes', details)
    }
    let clients = opts.controlPlane.clientsWatching(sessionId)
    if (to?.only) clients = clients.filter((clientId) => clientId === to.only)
    if (to?.except) clients = clients.filter((clientId) => clientId !== to.except)
    if (clients.length) events.publish(clients, 'session.eventReceived', { sessionId, event: projectedEvent })
  })
  opts.controlPlane.on('error', (sessionId: string, error: EnrichedError) => {
    const clients = opts.controlPlane.clientsWatching(sessionId)
    if (clients.length) events.publish(clients, 'session.errorReceived', { sessionId, error })
  })
  opts.controlPlane.on('session-index-updated', (event: SessionIndexUpdatedEvent) => {
    events.broadcast('session.indexChanged', event)
  })
  // Global session-status feed: agent-conversation cards track sessions no
  // client is watching.
  opts.controlPlane.on('session-status', (event: HostEventMap['session.statusChanged']) => {
    events.broadcast('session.statusChanged', event)
  })

  // Personal Uplink: the tunnel listener, the link to the control plane, and the
  // verifier for its grants. All three exist on every host; only a linked host uses them.
  let tunnelPort = 0
  const isTunnelRequest = (incoming: IncomingMessage): boolean =>
    tunnelPort !== 0 && incoming.socket.localPort === tunnelPort
  // One verifier per link: it follows the link record, and a host with no link
  // treats every grant as a stranger's.
  let grantVerifier: HostGrantVerifier | null = null
  const followLink = (link: UplinkLinkConfig | null): void => {
    grantVerifier = link ? new HostGrantVerifier({ link }) : null
  }
  let uplinkManager: UplinkLinkManager
  const uplinkConnector = new CloudflaredConnector({
    resolveBinary: resolveCloudflaredBinary,
    onObservation: (observation) => uplinkManager.handleConnectorObservation(observation),
  })
  uplinkManager = new UplinkLinkManager({
    installationId: getInstallationId,
    hostLabel: () => getServerSettings().name ?? hostname() ?? 'Solus host',
    os: hostOperatingSystem,
    proxiedPort: () => tunnelPort,
    connector: uplinkConnector,
    onLinkChanged: followLink,
  })
  followLink(uplinkManager.currentLink())

  const { server: http, requestListener } = buildHttpServer({
    host,
    port,
    staticDir: opts.staticDir,
    getHost: () => host,
    getPort: () => actualPort,
    requireAuth: () => requireAuth,
    isTrustedRequester: isTrustedRequesterAddress,
    isTunnelRequest,
    verifyHostGrant: (grant) => grantVerifier
      ? grantVerifier.verify(grant)
      : Promise.resolve({ ok: false, reason: 'not-linked' }),
    transcribeAudio: opts.transcribeAudio,
  })
  const responseReceiptBudget = new ResponseReceiptBudget()
  let ws = attachWebSocketTransport(http, server, {
    clientEvents,
    browserFrames,
    requireAuth: () => requireAuth,
    isTrustedRequester: isTrustedRequesterAddress,
    isTunnelRequest,
    responseBudget: responseReceiptBudget,
    onClientConnected: ({ clientId }) => {
      checksHandlers.handleClientConnected(clientId)
    },
    onClientDisconnected: ({ clientId }) => {
      checksHandlers.handleClientDisconnected(clientId)
    },
    onClientExpired: ({ clientId }) => {
      opts.controlPlane.handleClientExpired(clientId)
      void browserRegistry.dropClient(clientId)
    },
  })
  let sessionIndexPollTimer: ReturnType<typeof setTimeout> | null = null
  let sessionIndexPollFailures = 0

  function scheduleSessionIndexPoll(delay = SESSION_INDEX_POLL_MS): void {
    if (sessionIndexPollTimer) clearTimeout(sessionIndexPollTimer)
    const jitter = Math.floor(Math.random() * SESSION_INDEX_POLL_JITTER_MS)
    sessionIndexPollTimer = setTimeout(() => {
      sessionIndexPollTimer = null
      void pollSessionIndexes()
    }, delay + jitter)
    sessionIndexPollTimer.unref()
  }

  async function pollSessionIndexes(): Promise<void> {
    if (ws.sessions.size === 0) {
      scheduleSessionIndexPoll()
      return
    }
    try {
      await opts.controlPlane.refreshSessionIndexes()
      sessionIndexPollFailures = 0
      scheduleSessionIndexPoll()
    } catch (err) {
      sessionIndexPollFailures++
      const backoff = Math.min(
        SESSION_INDEX_POLL_MAX_BACKOFF_MS,
        SESSION_INDEX_POLL_MS * 2 ** sessionIndexPollFailures,
      )
      log.warn('session_index_poll_failed', { error: err instanceof Error ? err.message : String(err) })
      scheduleSessionIndexPoll(backoff)
    }
  }

  scheduleSessionIndexPoll()
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
        const address = http.address()
        return address && 'port' in address ? address.port : nextPort
      } catch (err) {
        const parsed = systemErrorSchema.safeParse(err)
        const code = parsed.success ? parsed.data.code : undefined
        if (code !== 'EADDRINUSE' || i === MAX_PORT_RETRIES) throw err
        log.info('port_in_use_retrying', { port: nextPort, nextPort: nextPort + 1 })
        nextPort += 1
      }
    }
    return nextPort
  }

  actualPort = await listenWithRetries(port)

  if (actualPort !== port) {
    log.info('server_bound_fallback_port', { host, port: actualPort, defaultPort: port })
  }

  let lock = acquireLock(host, actualPort)
  if (!lock) {
    log.warn('lock_acquisition_failed')
  }

  // The proxied listener: same routes, loopback only, never trusted. `cloudflared`
  // forwards the tunnel here, so every remote caller is loopback on the wire and the
  // listener — not the address — is what tells the policy it came from outside.
  const tunnelHttp = createNodeHttpServer(requestListener)
  tunnelHttp.on('upgrade', (request, socket, head) => {
    if (request.url?.startsWith('/ws')) ws.handleUpgrade(request, socket, head)
    else socket.destroy()
  })
  // The port is part of the link: the tunnel's ingress points at it. No fallback to
  // another port — a listener the tunnel cannot reach would only make the status lie.
  // A linked host whose port is taken reports that instead (`resume` checks it).
  const tunnelListenerPort = uplinkManager.currentLink()?.proxiedPort ?? DEFAULT_TUNNEL_LISTENER_PORT
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        tunnelHttp.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        tunnelHttp.off('error', onError)
        resolve()
      }
      tunnelHttp.once('error', onError)
      tunnelHttp.once('listening', onListening)
      tunnelHttp.listen(tunnelListenerPort, '127.0.0.1')
    })
    tunnelPort = tunnelListenerPort
    log.info('tunnel_listener_bound', { port: tunnelPort })
  } catch (err) {
    log.error('tunnel_listener_failed', { port: tunnelListenerPort, error: err instanceof Error ? err.message : String(err) })
  }
  void uplinkManager.resume().catch((err) => {
    log.warn('uplink_resume_failed', { error: err instanceof Error ? err.message : String(err) })
  })

  const noLanDiscovery: LanDiscoveryService = {
    discoverServers: async () => [],
    close: async () => {},
  }
  let lanDiscovery: LanDiscoveryService
  if (isLanDiscoveryDisabled()) {
    log.info('lan_discovery_skipped')
    lanDiscovery = noLanDiscovery
  } else {
    try {
      lanDiscovery = await startLanDiscoveryService(() => ({
        port: actualPort,
        installationId: getInstallationId(),
        isReachable: !isLoopbackHost(host),
      }))
    } catch (err) {
      log.warn('lan_discovery_unavailable', { error: err instanceof Error ? err.message : String(err) })
      lanDiscovery = noLanDiscovery
    }
  }

  async function rebind(remoteAccess: boolean): Promise<void> {
    const next = resolveEffectiveServerOptions({ host: opts.host, requireAuth: opts.requireAuth, remoteAccess })
    if (next.host === host && next.requireAuth === requireAuth) return
    host = next.host
    requireAuth = next.requireAuth
    lock?.release()
    // Existing WS connections (including the one carrying this very toggle)
    // keep the plain http.close() callback from ever firing, since Node waits
    // for all live sockets to end on their own. Force them closed first.
    checksHandlers.handleTransportClosed()
    try { ws.close() } catch (err) { log.warn('ws_close_failed_during_rebind', { error: err instanceof Error ? err.message : String(err) }) }
    await new Promise<void>((resolve) => http.close(() => resolve()))
    actualPort = await listenWithRetries(actualPort)
    ws = attachWebSocketTransport(http, server, {
      clientEvents,
      browserFrames,
      requireAuth: () => requireAuth,
      isTrustedRequester: isTrustedRequesterAddress,
      isTunnelRequest,
      responseBudget: responseReceiptBudget,
      onClientConnected: ({ clientId }) => {
        checksHandlers.handleClientConnected(clientId)
      },
      onClientDisconnected: ({ clientId }) => {
        checksHandlers.handleClientDisconnected(clientId)
      },
      onClientExpired: ({ clientId }) => {
        opts.controlPlane.handleClientExpired(clientId)
        void browserRegistry.dropClient(clientId)
      },
    })
    lock = acquireLock(host, actualPort)
    if (!lock) log.warn('lock_acquisition_failed_after_rebind')
    log.info('server_rebound', { host, port: actualPort, requireAuth })
  }

  registerConnectionsHandlers(server, {
    getServerInfo: () => ({ host, port: actualPort, allowLan: !isLoopbackHost(host), remoteAccess: getServerSettings().remoteAccess, requireAuth, trustLocalNetwork: getServerSettings().trustLocalNetwork }),
    getActiveSessions: () => [...ws.sessions.values()].map(s => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      deviceId: s.deviceId,
      connectedAt: s.connectedAt,
    })),
    discoverLanServers: () => lanDiscovery.discoverServers(),
    setRemoteAccess: async (remoteAccess) => {
      const next = setRemoteAccess(remoteAccess)
      await rebind(next.remoteAccess)
      return { ...next, host, port: actualPort, allowLan: !isLoopbackHost(host), requireAuth }
    },
    // Trust is evaluated per request, so no rebind: the next connection
    // attempt simply reads the new policy.
    setTrustLocalNetwork: (trustLocalNetwork) => ({
      trustLocalNetwork: setTrustLocalNetwork(trustLocalNetwork).trustLocalNetwork,
    }),
  })
  registerUplinkHandlers(server, { manager: uplinkManager })

  log.info('server_listening', { host, port: actualPort })
  console.log(`\n  Solus web UI → http://localhost:${actualPort}\n`)

  let shutdownPromise: Promise<void> | null = null

  return {
    server,
    events,
    http,
    host,
    port: actualPort,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        stopAutomationScheduler()
        stopMetricsRollover()
        prReconciler.stop()
        codeIntel.dispose()
        for (const unsubscribe of domainEventUnsubscribes) unsubscribe()
        if (sessionIndexPollTimer) clearTimeout(sessionIndexPollTimer)
        sessionIndexPollTimer = null
        await lanDiscovery.close()
        await uplinkConnector.stop()
        checksHandlers.handleTransportClosed()
        try { ws.close() } catch (err) { log.warn('ws_close_failed', { error: err instanceof Error ? err.message : String(err) }) }
        await new Promise<void>((resolve) => http.close(() => resolve()))
        await new Promise<void>((resolve) => tunnelHttp.close(() => resolve()))
        lock?.release()
      })()
      return shutdownPromise
    },
  }
}
