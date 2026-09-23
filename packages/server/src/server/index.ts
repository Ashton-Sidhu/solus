import { useIntegrationExecutor } from '../vault/account-integrations'
import { organizationOf } from './principal'
import { transcriptMirrorPayloadSchema } from './uplink/runner-protocol'
import { SharedPromptRelay, sharedPromptRequestSchema } from '../sharing/shared-prompt'
import { startSharedPromptRunner } from '../sharing/shared-prompt-runner'
import { RemoteUpdateService } from '../updates/remote-update-service'
import type { ServerUpdateSupport, SupervisorMessage } from '@solus/contracts/server-update'
import { UpdateStatusService } from '../updates/update-status-service'
import { detectInstallKind } from '../updates/install-kind'
import { fetchLatestRelease } from '../updates/release-sources'
import { readProviderVersion } from '../updates/provider-versions'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { createServer as createNodeHttpServer, type IncomingMessage, type Server as HttpServer } from 'http'
import { SolusServer } from './server'
import { buildHttpServer, type HttpServerOptions } from './http'
import { HostGrantVerifier } from './host-grants'
import { CloudflaredConnector, resolveCloudflaredBinary } from './uplink/connector'
import { UplinkLinkManager } from './uplink/link'
import { RunnerDelivery } from './uplink/runner-delivery'
import { applyRunnerMirror, applyRunnerOutbox, applyRunnerSessionRecords } from './runner-intake'
import { TranscriptMirror, listOwnInterruptedSessions } from '../mirror/transcript-mirror'
import { applyWorkspaceMode, isWorkspaceMode, workspaceConfig } from './workspace-mode'
import { WORKSPACE_AUDIENCE, type HostKind, type UplinkLinkConfig } from '@solus/contracts/uplink'
import { registerUplinkHandlers } from './handlers/uplink-handlers'
import { registerSharingHandlers } from './handlers/sharing-handlers'
import { ShareManager } from '../sharing/share-manager'
import { taskShareContents, tasksContaining } from '../tasks/task-sharing'
import { registerSeatHandlers } from './handlers/seat-handlers'
import { registerPresenceHandlers } from './handlers/presence-handlers'
import { PresenceManager } from '../presence/presence-manager'
import { SeatManager, seatUserFor, turnActorFor } from '../seats/seat-manager'
import { SeatConnector } from '../seats/seat-connect'
import { TurnLedger } from '../sessions/turn-ledger'
import { eventVisibleTo } from '../sharing/event-audience'
import { getDb } from '../db'
import { closeDatabase, getDatabase } from '../db/database'
import { markOwnRunningSessionRecordsInterrupted } from '../sessions/session-records'
import { LOCAL_ORGANIZATION_ID } from './principal'
import { resolveRoles, type SolusRole } from './roles'
import { hostOperatingSystem } from '../platform/host-operating-system'
import { hostDisplayName } from '../platform/host-display-name'
import { getHostConfig, getServerSettings, setRemoteAccess, setTrustLocalNetwork } from './settings'
import { notificationEventForAttentionKind } from '@solus/contracts/notification-types'
import { isLoopbackHost, resolveEffectiveServerOptions } from './bind-policy'
import { isTrustedRequesterAddress } from './trusted-requesters'
import { applyManagedMode, isManagedHost, readManagedLinkEnv } from './managed-mode'
import { attachWebSocketTransport } from '../transports/websocket'
import { ResponseReceiptBudget } from '../transports/response-receipt-cache'
import { ClientEventRegistry } from '../events/client-event-registry'
import { HostEventPublisher } from '../events/host-event-publisher'
import { BrowserFrameChannel } from '../browser/browser-frame-channel'
import type { ControlPlane } from '../control-plane'
import type { AgentMetadata, NormalizedEvent, EnrichedError, SessionIndexUpdatedEvent } from '@solus/contracts/types'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { AgentId, IpcContext } from '@solus/contracts/types'
import { DEFAULT_SERVER_PORT, isSessionBusyStatus } from '@solus/contracts/types'
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
import { hasAutomationWork, setAutomationUpdatesPaused, setAutomationBackgroundSessionDispatcher, setAutomationSessionDispatcher, setAutomationWorktreeNameGenerator } from '../automations/automation-runner'
import { generateWorktreeName } from '../git/worktree-name'
import { onAutomationsChanged } from '../automations/automations-store'
import { setSessionController, setSessionCreator } from '../sessions/session-tools'
import { onAnnotationsChanged } from '../annotations/annotation-events'
import { registerConnectionsHandlers } from './handlers/connections-handlers'
import { registerSettingsHandlers } from './handlers/settings-handlers'
import { isLanDiscoveryDisabled, startLanDiscoveryService, type LanDiscoveryService } from './lan-discovery'
import { registerGoogleHandlers } from './handlers/google-handlers'
import { registerProviderHandlers } from './handlers/provider-handlers'
import { PrReconciler } from '../prs/pr-reconciler'
import { registerCloudflareHandlers } from './handlers/cloudflare-handlers'
import { registerAtlassianHandlers } from './handlers/atlassian-handlers'
import { setOAuthCompletedListener as setAtlassianOAuthCompletedListener } from '../atlassian/oauth'
import { setConnectionConnectNeededListener } from '../connections/connection-tools'
import { setHostConfigChangedListener } from './config-tools'
import { registerBrowserHandlers } from './handlers/browser-handlers'
import { registerChecksHandlers } from './handlers/checks-handlers'
import { registerUsageHandlers } from './handlers/usage-handlers'
import { registerSkillsHandlers } from './handlers/skills-handlers'
import { registerPinnedSessionsHandlers } from './handlers/pinned-sessions-handlers'
import { registerSessionReadStateHandlers } from './handlers/session-read-state-handlers'
import { registerSavedPromptsHandlers } from './handlers/saved-prompts-handlers'
import { registerProjectConfigHandlers } from './handlers/project-config-handlers'
import { onWorkspaceProjectsChanged } from '../projects/workspace-projects'
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
  updateSupervisor?: {
    support: ServerUpdateSupport
    send(message: SupervisorMessage): void
    subscribe(listener: (message: SupervisorMessage) => void): () => void
    shutdown(): void
  }
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

/** What this process is to its clients: a person's machine, one the cloud provisioned, or the cloud's own workspace service. */
function resolveHostKind(workspaceMode: boolean): HostKind {
  if (workspaceMode) return 'cloud'
  return isManagedHost() ? 'managed' : 'personal'
}

/** The workspace service serves the collaboration plane and nothing else, whatever SOLUS_ROLES says. */
function resolveServerRoles(workspaceMode: boolean): ReadonlySet<SolusRole> {
  return workspaceMode ? new Set<SolusRole>(['collaboration']) : resolveRoles()
}

/** One verifier per link: a host with no link treats every grant as a stranger's. */
function grantVerifierForLink(link: UplinkLinkConfig | null): HostGrantVerifier | null {
  return link ? new HostGrantVerifier({ issuer: link.issuer, jwksUrl: link.jwksUrl, audience: link.hostId }) : null
}

/** The workspace service's one verifier: the cloud issuer, for `WORKSPACE_AUDIENCE`; null on a host, whose verifier follows its link. */
function workspaceGrantVerifier(workspaceMode: boolean): HostGrantVerifier | null {
  return workspaceMode ? new HostGrantVerifier({ ...workspaceConfig(), audience: WORKSPACE_AUDIENCE }) : null
}

/**
 * What a host does for its organization's workspace service once it is linked
 * and shared (cloud-service-model.md §4–§6, §16): the delivery of its streams,
 * and the mirror of turns its previous
 * process left unsettled. Nothing starts until the delivery holds a grant.
 */
function startRunnerCloud(deps: {
  uplinkManager: UplinkLinkManager
  transcriptMirror: TranscriptMirror
  interruptSweep: Promise<unknown>
}): RunnerDelivery {
  const delivery = new RunnerDelivery({
    link: () => deps.uplinkManager.currentLink(),
    hostToken: () => deps.uplinkManager.hostToken(),
  })
  // A turn the previous process left unsettled is mirrored once this runner
  // holds a grant: the mirror log appends nothing before then.
  let stopInterruptedSweep: (() => void) | null = null
  stopInterruptedSweep = delivery.onGrant((grant) => {
    if (!grant) return
    stopInterruptedSweep?.()
    void deps.interruptSweep.then(listOwnInterruptedSessions).then((sessions) => {
      for (const session of sessions) deps.transcriptMirror.touch(session.sessionId, session)
    }).catch((error) => {
      log.warn('transcript_mirror_interrupted_sweep_failed', { error: String(error) })
    })
  })
  return delivery
}

/** The workspace service's runner routes (cloud-service-model.md §16); `buildHttpServer` mounts them in workspace mode only. */
function runnerRoutes(shares: ShareManager): NonNullable<HttpServerOptions['runner']> {
  return {
    applyOutbox: (runner, request) => applyRunnerOutbox(runner, request, shares),
    applySessionRecords: (runner, request) => applyRunnerSessionRecords(runner, request, shares),
    applyMirror: applyRunnerMirror,
  }
}

/**
 * Binds the proxied listener on loopback. The port is part of the link: the
 * tunnel's ingress points at it, so there is no fallback to another port — a
 * listener the tunnel cannot reach would only make the status lie. A linked host
 * whose port is taken reports that instead (`resume` checks it). Answers the
 * bound port, or 0 when the bind failed.
 */
async function bindTunnelListener(tunnelHttp: HttpServer, tunnelListenerPort: number): Promise<number> {
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
    log.info('tunnel_listener_bound', { port: tunnelListenerPort })
    return tunnelListenerPort
  } catch (err) {
    log.error('tunnel_listener_failed', { port: tunnelListenerPort, error: err instanceof Error ? err.message : String(err) })
    return 0
  }
}

export async function bootServer(opts: BootOptions): Promise<BootedServer> {
  // The renderer's first connection waits on this function. An empty store
  // boots in tens of milliseconds; a real one has cost in the stores and the
  // host handlers, so the phases report where it went.
  const bootStartedAt = performance.now()
  const phaseDone = (phase: 'db_opened' | 'host_handlers_registered' | 'domain_handlers_registered' | 'update_services_ready'): void => {
    log.info('server_boot_phase', { phase, elapsedMs: Math.round(performance.now() - bootStartedAt) })
  }
  // Before the database, the listeners, or any child process: the link tokens in
  // the environment must leave it first (managed-hosts.md §1, §2).
  applyManagedMode()
  // And the workspace service refuses to start half-configured (cloud-service-model.md §15).
  applyWorkspaceMode()
  const workspaceMode = isWorkspaceMode()
  const hostKind = resolveHostKind(workspaceMode)
  // A managed host and the workspace service demand a credential on every listener, whatever the bind policy says.
  const credentialAlwaysRequired = hostKind !== 'personal'
  const settings = getServerSettings()
  const initial = resolveEffectiveServerOptions({ host: opts.host, requireAuth: opts.requireAuth, remoteAccess: settings.remoteAccess })
  let host = initial.host
  let requireAuth = initial.requireAuth || credentialAlwaysRequired
  const port = opts.port ?? WEB_UI_PORT
  let actualPort = port

  const server = new SolusServer()
  const roles = resolveServerRoles(workspaceMode)
  server.useRoles(roles)
  // Ownership and share lists (docs/plans/multiplayer-sharing.md §3.4): the access
  // policy consults them on every resource call, and the event stream is filtered
  // to what each connected principal may see.
  const shares = new ShareManager({
    db: getDatabase(),
    canonicalSessionId: (sessionId) => opts.controlPlane.canonicalSessionId(sessionId),
    taskContents: taskShareContents,
    containingTasks: tasksContaining,
    sessionExists: (sessionId) => opts.controlPlane.isKnownSession(sessionId),
  })
  server.useResourceAccess(shares)
  // Provider seats and the turn ledger (Step 2 plan): every turn runs on its
  // author's own login, and the host records whose it was. The workspace service
  // VAULT_NOT_CONFIGURED to every seat call.
  const seats = new SeatManager({ db: getDb() })
  const turnLedger = new TurnLedger(getDb())
  // A record this host left `running` names a turn the previous process never settled.
  const interruptSweep = markOwnRunningSessionRecordsInterrupted(LOCAL_ORGANIZATION_ID).catch((error) => {
    log.warn('session_records_interrupt_sweep_failed', { error: String(error) })
  })
  phaseDone('db_opened')
  // The transcript mirror (cloud-service-model.md §6): a runner ships each
  // session's history rows to its organization's workspace service. On a host
  // that mirrors nowhere, and on the service itself, a touch does nothing.
  const transcriptMirror = new TranscriptMirror({
    loadSession: (provider, sessionId, projectPath) => opts.controlPlane.loadSession(provider, sessionId, projectPath),
  })
  const touchTranscript = (sessionId: string): void => {
    const source = opts.controlPlane.sessionTranscriptSource(sessionId)
    if (source) transcriptMirror.touch(source.agentSessionId, source)
  }
  opts.controlPlane.useSeats(seats, turnLedger)
  const seatConnector = new SeatConnector({ seats })
  const clientEvents = new ClientEventRegistry((clientId, event) => {
    const principal = ws?.principalOf(clientId)
    return !principal || eventVisibleTo(principal, event, shares)
  })
  const events = new HostEventPublisher(clientEvents)
  // Who is here (docs/plans/multiplayer-presence.md): one entry per connected
  // client, named from its principal at admission. The host room is one
  // organization's — the whole host, or each organization of the workspace
  // service — and goes to the admitted clients in it (the audience filter keeps
  // it from guests); a session's room goes to that session's watchers, who are the room.
  const presence = new PresenceManager({ describeSession: (sessionId) => opts.controlPlane.sessionActivityFor(sessionId) })
  const publishHostPresence = (organizationId?: string): void => {
    const rooms = organizationId ? [organizationId] : presence.organizations()
    for (const room of rooms) {
      void presence.hostSnapshot(room).then((snapshot) => events.publish(presence.clientsIn(room), 'host.presenceChanged', snapshot))
    }
  }
  const publishSessionPresence = (sessionId: string): void => {
    const watchers = opts.controlPlane.clientsWatching(sessionId)
    if (!watchers.length) return
    events.publish(watchers, 'session.presenceChanged', presence.sessionSnapshot(sessionId, watchers, opts.controlPlane.activeTurnFor(sessionId)))
  }
  // Streamed browser frames bypass the typed-event envelope: the transport
  // registers a per-client binary delivery here, the browser registry publishes
  // only to the clients watching each page.
  const browserFrames = new BrowserFrameChannel()
  const codeIntel = new CodeIntelManager()
  const domainEventUnsubscribes = [
    codeIntel.onStatusChanged((status) => events.broadcast('codeIntel.statusChanged', status)),
    onAutomationsChanged((event) => events.broadcast('automation.changed', event)),
    onAnnotationsChanged((change) => events.broadcast('annotations.changed', change)),
    onTasksChanged(() => events.broadcast('tasks.invalidated', {})),
    onWorkspaceProjectsChanged(() => events.broadcast('workspaceProjects.changed', {})),
    onOutboxChanged(() => events.broadcast('outbox.changed', {})),
  ]
  // A pull request merged on the code host announces nothing to Solus, so the
  // host asks on the workspace's behalf and turns what it finds into the same
  // event an in-Solus merge sends.
  const prReconciler = new PrReconciler({
    announce: (projectRoot, detail) => events.broadcast('pr.lifecycleChanged', { projectRoot, detail }),
    isSessionBusy: (sessionId) => opts.controlPlane.isSessionBusy(sessionId),
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
    shares,
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
    shares,
  })
  await opts.registerHostHandlers?.(server)
  phaseDone('host_handlers_registered')
  registerFolioHandlers(server, { shares })
  registerSharingHandlers(server, { shares })
  const sharedPrompts = workspaceMode ? new SharedPromptRelay(shares) : undefined
  server.register('sharedSessionAvailable', (args, ctx) => sharedPrompts ? sharedPrompts.available(ctx.principal, args[0]) : false)
  server.register('sharedSessionPrompt', (args, ctx) => {
    if (!sharedPrompts) throw new Error('Shared prompts use Solus cloud.')
    return sharedPrompts.prompt(ctx.principal, sharedPromptRequestSchema.parse(args[0]))
  })
  registerSeatHandlers(server, { seats, connector: seatConnector })
  registerPresenceHandlers(server, { presence, onHostChanged: (clientId) => publishHostPresence(presence.organizationOf(clientId)), onSessionChanged: publishSessionPresence })
  registerReviewHandlers(server, opts.controlPlane, events)
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
  server.register('promptSession', async (args, ctx) => {
    const [sessionId, prompt, delivery] = args
    if (!sessionId.trim()) throw new Error('promptSession requires a session id')
    if (!prompt.trim()) throw new Error('promptSession requires a non-empty prompt')
    return opts.controlPlane.promptSession(sessionId, prompt, delivery === 'steer' ? 'steer' : 'queue', { actor: turnActorFor(ctx.principal) })
  })
  server.register('stopSession', async (args) => {
    const [sessionId] = args
    if (!sessionId.trim()) throw new Error('stopSession requires a session id')
    return opts.controlPlane.stopSession(sessionId)
  })
  // Local, in-process automation scheduler. Fires time-based triggers while the
  // app is open and catches up missed fires on launch (local-only by design).
  startMetricsRollover(() => getServerSettings().metricsRetentionDays)
  registerObservabilityHandlers(server, { controlPlane: opts.controlPlane })
  registerProjectConfigHandlers(server)
  registerTasksHandlers(server, { shares })
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
    isSessionBusy: (sessionId) => opts.controlPlane.isSessionBusy(sessionId),
  })
  const checksHandlers = registerChecksHandlers(server, { events })
  // The clients one member is connected on; a seat's facts go to them and nobody else.
  const clientsForSeatUser = (seatUserId: string): string[] =>
    [...ws.sessions.values()].filter((session) => seatUserFor(session.principal) === seatUserId).map((session) => session.clientId)
  registerUsageHandlers(server, {
    controlPlane: opts.controlPlane,
    events,
    seats,
    clientsForSeatUser,
  })
  registerSkillsHandlers(server, { controlPlane: opts.controlPlane })
  registerPinnedSessionsHandlers(server)
  registerSessionReadStateHandlers(server, { events })
  registerSavedPromptsHandlers(server)
  phaseDone('domain_handlers_registered')
  const hostUpdates = new UpdateStatusService({
    currentVersion: packageJson.version,
    install: isManagedHost() ? 'cloud' : detectInstallKind(),
    latest: (target) => fetchLatestRelease(target, packageJson.version),
    providerVersion: readProviderVersion,
    publish: (status) => { events.broadcast('host.updateStatusChanged', status) },
  })
  let activeSetupSteps = 0
  const supervisor = opts.updateSupervisor
  server.setUpdateTrial(supervisor?.support.operation?.phase === 'restarting')
  const remoteUpdates = new RemoteUpdateService({
    status: () => hostUpdates.status,
    publish: (support) => hostUpdates.setServerUpdate(support),
    blockNewTurns: (blocked) => { opts.controlPlane.setUpdatePending(blocked); setAutomationUpdatesPaused(blocked) },
    hasWork: () => activeSetupSteps > 0 || hasAutomationWork() || opts.controlPlane.hasWorkForUpdate(),
    send: (message) => { if (!supervisor) throw new Error('No update supervisor.'); supervisor.send(message) },
  }, supervisor?.support ?? { supported: false, reason: 'Start a supported installation through solus start or solus-server to enable remote updates.', operation: null })
  const stopSupervisor = supervisor?.subscribe((message) => {
    if (message.type === 'solus:update-status') {
      server.setUpdateTrial(message.support.operation?.phase === 'restarting')
      remoteUpdates.apply(message.support)
    }
    if (message.type === 'solus:stop-for-update' && remoteUpdates.canStop(message.operationId)) supervisor.shutdown()
  })
  phaseDone('update_services_ready')
  startAutomationScheduler()
  server.register('hostInstallUpdate', () => { remoteUpdates.install(); return structuredClone(hostUpdates.status) })
  server.register('hostCancelUpdate', () => { remoteUpdates.cancel(); return structuredClone(hostUpdates.status) })
  server.register('hostUpdateStatus', () => structuredClone(hostUpdates.status))
  server.register('hostCheckForUpdates', () => hostUpdates.check())
  hostUpdates.start()
  registerSetupHandlers(server, { events,
    assertNewWorkAllowed: () => opts.controlPlane.assertNewWorkAllowed(),
    onActiveStepsChanged: (count) => { activeSetupSteps = count },
    onProviderInstalled: (agent) => hostUpdates.providerInstalled(agent),
    seats,
  })
  // Browser pages are server-owned so an agent addresses the same page the user
  // sees, and keeps addressing it after the pane closes. A headless host still
  // registers the domain: it can discover targets and hold pages, and reports
  // `no-surface` rather than pretending to drive one.
  const browserRegistry = registerBrowserHandlers(server, { events, frames: browserFrames })

  server.register('getServerCapabilities', (_args, ctx) => probeServerCapabilities({
    headless: !opts.windowDeps,
    desktopHandlers: hasDesktopHandlers,
    version: packageJson.version,
    principal: ctx.principal,
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

    // A device subscribes only while the system channel is on, so the host
    // applies the event switches; the channel switch is applied by the device.
    const { notifications } = getHostConfig().config
    for (const entry of created) {
      if (!notifications.events[notificationEventForAttentionKind(entry.kind)]) continue
      void pushNotifications.sendToOfflineDevices(entry, isDeviceOnline, getInstallationId()).catch((err) => {
        log.warn('web_push_fanout_failed', { error: err instanceof Error ? err.message : String(err) })
      })
    }
  })
  setVoiceModelStatusListener((status) => events.broadcast('voice.modelStatusChanged', status))

  // One publish per watching client. Two panes on one renderer are one client
  // and receive one payload; desktop and web are two, with the same payload.
  opts.controlPlane.on('event', (sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }) => {
    // A broadcast event is a change to the session's history; one aimed at a single client is not.
    if (!to) touchTranscript(sessionId)
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
    // A turn started or settled: the room's "whose turn" line follows the status,
    // and so does the roster row of everyone who has the session focused.
    publishSessionPresence(event.sessionId)
    if (presence.isSessionFocused(event.sessionId)) publishHostPresence()
    // A settled turn is mirrored at once, so the cloud copy is whole when the session goes quiet.
    touchTranscript(event.sessionId)
    if (event.agentSessionId && !isSessionBusyStatus(event.status)) void transcriptMirror.flushNow(event.agentSessionId)
  })
  opts.controlPlane.on('watchers-changed', (sessionId: string) => publishSessionPresence(sessionId))

  // Personal Uplink: the tunnel listener, the link to the control plane, and the
  // verifier for its grants. All three exist on every host; only a linked host uses them.
  // The workspace service has none of them (cloud-service-model.md §15): its one
  // verifier trusts the cloud issuer for `WORKSPACE_AUDIENCE`, and it never links.
  let tunnelPort = 0
  const isTunnelRequest = (incoming: IncomingMessage): boolean =>
    tunnelPort !== 0 && incoming.socket.localPort === tunnelPort
  // One verifier per link: it follows the link record, and a host with no link
  // treats every grant as a stranger's.
  let grantVerifier: HostGrantVerifier | null = workspaceGrantVerifier(workspaceMode)
  let runnerDelivery: RunnerDelivery | null = null
  const followLink = (link: UplinkLinkConfig | null): void => {
    if (workspaceMode) return
    grantVerifier = grantVerifierForLink(link)
    runnerDelivery?.linkChanged()
  }
  let uplinkManager: UplinkLinkManager
  const uplinkConnector = new CloudflaredConnector({
    resolveBinary: resolveCloudflaredBinary,
    onObservation: (observation) => uplinkManager.handleConnectorObservation(observation),
  })
  uplinkManager = new UplinkLinkManager({
    installationId: getInstallationId,
    hostLabel: hostDisplayName,
    os: hostOperatingSystem,
    proxiedPort: () => tunnelPort,
    connector: uplinkConnector,
    onLinkChanged: followLink,
    // The connector registers after `uplinkLink` has answered: the Access tab's
    // status line follows this instead of waiting for a reload.
    onStatusChanged: (status) => events.broadcast('host.uplinkStatusChanged', status),
    managedLink: readManagedLinkEnv,
  })
  followLink(uplinkManager.currentLink())
  // A linked host shared with an organization delivers its cloud-owned writes and
  // its session records to the organization's workspace service (§16).
  useIntegrationExecutor({ link: () => uplinkManager.currentLink(), hostToken: () => uplinkManager.hostToken() })
  if (!workspaceMode) {
    runnerDelivery = startRunnerCloud({
      uplinkManager,
      transcriptMirror,
      interruptSweep,
    })
    domainEventUnsubscribes.push(startSharedPromptRunner(runnerDelivery, opts.controlPlane))
  }

  const { server: http, requestListener } = buildHttpServer({
    isVerifyingUpdate: () => server.isVerifyingUpdate,
    host,
    port,
    staticDir: opts.staticDir,
    name: hostDisplayName,
    getHost: () => host,
    getPort: () => actualPort,
    requireAuth: () => requireAuth,
    isTrustedRequester: isTrustedRequesterAddress,
    isTunnelRequest,
    // No pairing door on a managed host or the workspace service: a grant is the only credential there.
    isManagedHost: credentialAlwaysRequired,
    isWorkspaceMode: workspaceMode,
    verifyHostGrant: (grant, verifyOptions) => grantVerifier
      ? grantVerifier.verify(grant, verifyOptions)
      : Promise.resolve({ ok: false, reason: 'not-linked' }),
    resolveShareSecret: workspaceMode ? (secret) => shares.resolveLinkSecret(secret) : undefined,
    runner: {
      ...runnerRoutes(shares),
      applyMirror: async (runner, request) => {
        const result = await applyRunnerMirror(runner, request)
        const changed = new Set<string>()
        for (const item of request.items) {
          if (item.domain !== 'transcripts' || item.seq > result.lastSeq) continue
          const parsed = transcriptMirrorPayloadSchema.safeParse(item.payload)
          if (parsed.success) changed.add(parsed.data.sessionId)
        }
        for (const sessionId of changed) events.broadcast('session.transcriptChanged', { sessionId })
        return result
      },
    },
    sharedPrompts,
    transcribeAudio: opts.transcribeAudio,
  })
  const responseReceiptBudget = new ResponseReceiptBudget()
  // Everyone who can see the resource learns of the change; a removed guest link
  // ends its sockets at once, a removed member fails on their next call (§3.4).
  domainEventUnsubscribes.push(shares.onChanged((change) => {
    const { guestsRevoked, organizationId, ...payload } = change
    const recipients = clientEvents.routableClientIds().filter(clientId => {
      const principal = ws.principalOf(clientId)
      return principal ? organizationOf(principal) === organizationId : organizationId === 'local'
    })
    void events.publish(recipients, 'share.changed', payload)
    if (!guestsRevoked) return
    ws.disconnectWhere((principal) => principal.kind === 'guest'
      && organizationOf(principal) === organizationId
      && principal.share.resource.kind === change.resource.kind
      && shares.canonical(principal.share.resource).id === change.resource.id, 'share-link-revoked')
  }))
  // A seat changes for one member; only that member's clients hear it.
  domainEventUnsubscribes.push(seats.onChanged((event) => {
    events.publish(clientsForSeatUser(event.userId), 'host.seatChanged', event)
  }))
  // Seats of members who ran nothing for thirty days are removed (plan §3.7).
  const seatSweepTimer = setInterval(() => {
    if (!workspaceMode) seats.sweep().catch((err) => log.warn('seat_sweep_failed', { error: err instanceof Error ? err.message : String(err) }))
  }, 24 * 60 * 60_000)
  seatSweepTimer.unref()
  let ws = attachWebSocketTransport(http, server, {
    clientEvents,
    browserFrames,
    requireAuth: () => requireAuth,
    isTrustedRequester: isTrustedRequesterAddress,
    isTunnelRequest,
    responseBudget: responseReceiptBudget,
    onClientConnected: ({ clientId }) => {
      checksHandlers.handleClientConnected(clientId)
      handlePresenceConnected(clientId)
    },
    onClientDisconnected: ({ clientId }) => {
      checksHandlers.handleClientDisconnected(clientId)
      handlePresenceDisconnected(clientId)
    },
    onClientExpired: ({ clientId }) => {
      opts.controlPlane.handleClientExpired(clientId)
      void browserRegistry.dropClient(clientId)
    },
  })
  // A client is in the rooms of the sessions it watches for exactly as long as
  // its socket is up: gone from every avatar stack the moment it drops, back the
  // moment it returns, even though the control plane keeps its watch through the
  // grace period so its stream can be recovered.
  function handlePresenceConnected(clientId: string): void {
    const principal = ws.principalOf(clientId)
    if (!principal) return
    const deviceLabel = [...ws.sessions.values()].find((session) => session.clientId === clientId)?.deviceLabel ?? 'Web'
    const joined = presence.join(clientId, principal, deviceLabel)
    // The newcomer gets the room whether or not it is new: a reconnect has lost
    // its copy. Everyone else hears only about a new face.
    const room = presence.organizationOf(clientId)
    if (joined) publishHostPresence(room)
    else if (room !== undefined) void presence.hostSnapshot(room).then((snapshot) => events.publish(clientId, 'host.presenceChanged', snapshot))
    for (const sessionId of opts.controlPlane.sessionsWatchedBy(clientId)) publishSessionPresence(sessionId)
  }
  function handlePresenceDisconnected(clientId: string): void {
    const room = presence.organizationOf(clientId)
    const left = presence.leave(clientId)
    if (!left) return
    publishHostPresence(room)
    const rooms = new Set(opts.controlPlane.sessionsWatchedBy(clientId))
    if (left.composingSessionId) rooms.add(left.composingSessionId)
    for (const sessionId of rooms) publishSessionPresence(sessionId)
  }
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
  // The workspace service has no tunnel and no link to resume (cloud-service-model.md §15).
  if (!workspaceMode) {
    tunnelPort = await bindTunnelListener(tunnelHttp, uplinkManager.currentLink()?.proxiedPort ?? DEFAULT_TUNNEL_LISTENER_PORT)
    void uplinkManager.resume().catch((err) => {
      log.warn('uplink_resume_failed', { error: err instanceof Error ? err.message : String(err) })
    }).finally(() => runnerDelivery?.start())
  }

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
        name: hostDisplayName(),
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
    const nextRequireAuth = next.requireAuth || credentialAlwaysRequired
    if (next.host === host && nextRequireAuth === requireAuth) return
    host = next.host
    requireAuth = nextRequireAuth
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
        handlePresenceConnected(clientId)
      },
      onClientDisconnected: ({ clientId }) => {
        checksHandlers.handleClientDisconnected(clientId)
        handlePresenceDisconnected(clientId)
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
    getServerInfo: () => ({
      host,
      port: actualPort,
      allowLan: !isLoopbackHost(host),
      remoteAccess: getServerSettings().remoteAccess,
      requireAuth,
      trustLocalNetwork: getServerSettings().trustLocalNetwork,
      hostKind,
      roles: [...roles],
    }),
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
        hostUpdates.stop()
        remoteUpdates.stop()
        stopSupervisor?.()
        codeIntel.dispose()
        for (const unsubscribe of domainEventUnsubscribes) unsubscribe()
        if (sessionIndexPollTimer) clearTimeout(sessionIndexPollTimer)
        sessionIndexPollTimer = null
        clearInterval(seatSweepTimer)
        await seatConnector.stopAll()
        await lanDiscovery.close()
        transcriptMirror.dispose()
        await runnerDelivery?.stop()
        await uplinkConnector.stop()
        checksHandlers.handleTransportClosed()
        try { ws.close() } catch (err) { log.warn('ws_close_failed', { error: err instanceof Error ? err.message : String(err) }) }
        await new Promise<void>((resolve) => http.close(() => resolve()))
        await new Promise<void>((resolve) => tunnelHttp.close(() => resolve()))
        await closeDatabase()
        lock?.release()
      })()
      return shutdownPromise
    },
  }
}
