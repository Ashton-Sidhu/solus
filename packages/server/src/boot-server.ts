import { setAgentQueueController } from './execution/agents/tools/queue-tools'
import { installWorkspaceToolOperations, type RemoteToolOperations } from './data/workspace/tool-context'
import { solusApiSettings } from './host/solus-api-settings'
import { createWorkspaceOperations } from './data/workspace/service'
import { heldPersonToken, useDelegatedTokens, useIntegrationExecutor } from './vault/account-integrations'
import { ANY_ORGANIZATION, principalFor, recordScopeOf, scopeAdmits } from './admission/principal'
import type { ShareResource } from '@solus/contracts/sharing'
import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import { workOrganizationId } from './data/works/works'
import { taskOrganizationId } from './data/tasks/task-store'
import { SharedPromptRelay, sharedPromptRequestSchema } from './sharing/shared-prompt'
import { startSharedPromptRunner } from './sharing/shared-prompt-runner'
import { RemoteUpdateService } from './updates/remote-update-service'
import type { ServerUpdateSupport, SupervisorMessage } from '@solus/contracts/server-update'
import { UpdateStatusService } from './updates/update-status-service'
import { ModelProfilesService, downloadModelProfiles } from './updates/model-profiles-service'
import { detectInstallKind } from './updates/install-kind'
import { fetchLatestRelease } from './updates/release-sources'
import { readProviderVersion } from './updates/provider-versions'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { createServer as createNodeHttpServer, type IncomingMessage, type Server as HttpServer } from 'http'
import { SolusServer } from './transport/server'
import { buildHttpServer, type HttpServerOptions } from './transport/http'
import { AccessTokenVerifier } from './admission/access-tokens'
import { CloudflaredConnector, resolveCloudflaredBinary } from './transport/uplink/connector'
import { readStoredLink, UplinkLinkManager } from './transport/uplink/link'
import { RunnerDelivery } from './sync/runner-delivery'
import { Delegations } from './sync/delegations'
import { remoteWorkspaceOperations } from './sync/remote-operations'
import { onSessionRecordBound } from './execution/sessions/turn-organization'
import { useOrganizationAttachment } from './host/organization-attachment'
import { applyRunnerMirror, applyRunnerOutbox, applyRunnerSessionRecords } from './sync/runner-intake'
import { PublicationCoordinator } from './sync/publication'
import { insightsEligible, useInsightsPolicy } from './sync/mirror/insight-mirror'
import { HostOrganizations } from './host/organizations'
import { hasLeftOrganization, removeDepartedMembers } from './host/departed-members'
import { ManagedHostActivity } from './host/managed-host-activity'
import { activityLeases } from './execution/activity-leases'
import { adoptProvisionedLink, applyHostCategory, hostCategory } from './host/host-category'
import { getInsightsOptIn, hostUserSettings } from './host/settings'
import { adoptHostUser, followHostAccount } from './host/host-user-rows'
import { registerOrganizationHandlers } from './transport/handlers/organization-handlers'
import { enrollHostCategorySchema, type EnrollHostCategory } from '@solus/contracts/uplink'
import { TranscriptMirror, listOwnInterruptedSessions } from './sync/mirror/transcript-mirror'
import { applyApiMode, isApiMode, apiModeConfig } from './host/api-mode'
import { SOLUS_API_AUDIENCE, hostAudience, type HostKind, type UplinkLinkConfig } from '@solus/contracts/uplink'
import { registerUplinkHandlers } from './transport/handlers/uplink-handlers'
import { registerSharingHandlers } from './transport/handlers/sharing-handlers'
import { registerCloudUploadHandlers } from './transport/solus-api/cloud-uploads'
import { ShareManager } from './sharing/share-manager'
import { taskShareContents, tasksContaining } from './data/tasks/task-sharing'
import { registerSeatHandlers } from './transport/handlers/seat-handlers'
import { AgentProfileManager, hostProfileHomes } from './execution/seats/agent-profile'
import { publishPresenceRoom, registerPresenceHandlers } from './transport/handlers/presence-handlers'
import { PresenceManager } from './presence/presence-manager'
import { SeatManager, seatKey } from './execution/seats/seat-manager'
import { actorFor, HOST_ACTOR, memberSeat, seatFor } from './admission/actor'
import { GitIdentityManager } from './git/git-identity-manager'
import { MemberFolders, useMemberFolders } from './host/member-folders'
import { setupProjectsRoot } from './workspace'
import { fetchLogin } from './providers/github/auth'
import { loadToken } from './providers/github/token-store'
import { withCredentialScope } from './vault/credential-scope'
import { SeatConnector } from './execution/seats/seat-connect'
import { attentionVisibleTo, eventVisibleTo } from './sharing/event-audience'
import { getDb } from './db'
import { closeDatabase, getDatabase } from './db/database'
import { getSessionRecord, markOwnRunningSessionRecordsInterrupted, recordSessionId, useLiveRecordIds, useSessionIndexState } from './data/sessions/session-records'
import { sessionIndexComplete } from './db/session-indexer'
import { assertRpcAccess } from './admission/access-policy'
import { LOCAL_ORGANIZATION_ID } from './admission/principal'
import { resolveRoles, type SolusRole } from './host/roles'
import { hostOperatingSystem } from './platform/host-operating-system'
import { hostDisplayName } from './platform/host-display-name'
import { getServerSettings, setRemoteAccess, setTrustLocalNetwork } from './host/settings'
import { isLoopbackHost, resolveEffectiveServerOptions } from './transport/bind-policy'
import { isTrustedRequesterAddress } from './transport/trusted-requesters'
import { readHostLinkEnv } from './host/host-link-env'
import { attachWebSocketTransport } from './transport/websocket'
import { ResponseReceiptBudget } from './transport/response-receipt-cache'
import { ClientEventRegistry } from './transport/events/client-event-registry'
import { HostEventPublisher } from './transport/events/host-event-publisher'
import { BrowserFrameChannel } from './browser/browser-frame-channel'
import { initDeviceDomain } from './devices/device-domain'
import { runDeviceCommand } from './devices/device-process'
import { spawnHelper } from './devices/device-helpers'
import { SshDeviceHost, isLocalSshTarget } from './devices/ssh-device-host'
import { registerDeviceHandlers } from './transport/handlers/device-handlers'
import type { SessionRuntime } from './execution/session-runtime'
import type { AgentMetadata, NormalizedEvent, EnrichedError, SessionIndexUpdatedEvent } from '@solus/contracts/types'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { AgentId, IpcContext } from '@solus/contracts/types'
import { DEFAULT_SERVER_PORT, isSessionBusyStatus } from '@solus/contracts/types'
import { registerWindowHandlers, type WindowDeps } from './transport/handlers/window-handlers'
import { enrichAgentMetadata, registerSessionHandlers, type SessionDeps } from './transport/handlers/session-handlers'
import { registerWorktreeHandlers } from './transport/handlers/worktree-handlers'
import { registerGitPublishHandlers } from './transport/handlers/git-publish-handlers'
import { registerFilesystemHandlers } from './transport/handlers/filesystem-handlers'
import { registerCodeIntelHandlers } from './transport/handlers/code-intel-handlers'
import { CodeIntelManager } from './code-intel/code-intel-manager'
import { registerHistoryHandlers } from './transport/handlers/history-handlers'
import { registerFolioHandlers } from './transport/handlers/folio-handlers'
import { registerReviewHandlers } from './transport/handlers/review-handlers'
import { registerAutomationHandlers } from './transport/handlers/automation-handlers'
import { registerWatchHandlers } from './transport/handlers/watch-handlers'
import { onWatchesChanged } from './watches/watches-store'
import { WatchService } from './watches/watch-service'
import { startAutomationScheduler, stopAutomationScheduler } from './execution/automations/automation-scheduler'
import { hasAutomationWork, setAutomationUpdatesPaused, setAutomationBackgroundSessionDispatcher, setAutomationWorktreeCreator } from './execution/automations/automation-runner'
import { nextAutomationDueAt, onAutomationsChanged, pauseAutomationsOf } from './data/automations/automations-store'
import { setSessionController, setSessionOrchestration } from './execution/agents/tools/session-tools'
import { orchestrateSessions } from './execution/orchestration/orchestrate-sessions'
import { onAnnotationsChanged } from './annotations/annotation-events'
import { onWorkDeleted, onWorksChanged } from './data/works/work-events'
import { onWorkReviewsChanged } from './data/works/work-reviews'
import { registerWorkReviewHandlers } from './transport/handlers/work-review-handlers'
import { registerNotificationHubHandlers } from './transport/handlers/notification-hub-handlers'
import { publishNotificationChanges } from './notifications/hub-events'
import { hostPrObserver } from './notifications/pr-observer'
import { registerWorkLiveHandlers } from './transport/handlers/work-live-handlers'
import { WorkLiveManager } from './work-live/work-live-manager'
import { installWorkLiveBridge } from './data/works/work-live-bridge'
import { registerConnectionsHandlers } from './transport/handlers/connections-handlers'
import { registerSettingsHandlers } from './transport/handlers/settings-handlers'
import { isLanDiscoveryDisabled, startLanDiscoveryService, type LanDiscoveryService } from './transport/lan-discovery'
import { registerGoogleHandlers } from './transport/handlers/google-handlers'
import { registerProviderHandlers } from './transport/handlers/provider-handlers'
import { PrSync } from './prs/pr-sync'
import { registerCloudflareHandlers } from './transport/handlers/cloudflare-handlers'
import { registerAtlassianHandlers } from './transport/handlers/atlassian-handlers'
import { setOAuthCompletedListener as setAtlassianOAuthCompletedListener } from './atlassian/oauth'
import { setConnectionConnectNeededListener } from './connections/connection-tools'
import { setHostConfigChangedListener } from './execution/agents/tools/config-tools'
import { registerBrowserHandlers } from './transport/handlers/browser-handlers'
import { registerChecksHandlers } from './transport/handlers/checks-handlers'
import { registerUsageHandlers } from './transport/handlers/usage-handlers'
import { registerSkillsHandlers } from './transport/handlers/skills-handlers'
import { registerPinnedSessionsHandlers } from './transport/handlers/pinned-sessions-handlers'
import { registerSessionReadStateHandlers } from './transport/handlers/session-read-state-handlers'
import { registerProjectConfigHandlers } from './transport/handlers/project-config-handlers'
import { onWorkspaceProjectsChanged } from './projects/workspace-projects'
import { registerTasksHandlers } from './transport/handlers/tasks-handlers'
import { setVoiceModelStatusListener } from './model-downloader'
import { createLogger, isDebugEnabled } from './logger'
import { getInstallationId } from './admission/auth'
import { probeServerCapabilities, registerSetupHandlers } from './transport/handlers/setup-handlers'
import packageJson from '../../../package.json'
import { dataDir, solusDir } from './platform/paths'
import { onTasksChanged } from './data/tasks/task-store'
import { emitSessionTasksChanged } from './data/tasks/task-sessions'
import { onSessionPullRequestsChanged } from './data/sessions/session-pull-requests'
import { onSessionStateChanged } from './data/sessions/session-states'
import { deliveryBacklog, dropQueuedFor, onOutboxChanged } from './sync/outbox/outbox-store'
import { registerOutboxHandlers } from './transport/handlers/outbox-handlers'
import { registerTaskOutboxApplier } from './data/tasks/task-applier'
import { registerSessionOutboxApplier } from './data/sessions/session-applier'
import { registerWorkOutboxApplier } from './data/works/work-applier'
import { agentTargetFromMetadata } from './execution/agents/agent-targets'
import { registerAttachmentHandlers } from './transport/handlers/attachment-handlers'
import { registerAssetHandlers } from './transport/handlers/asset-handlers'
import { registerCapabilityHandlers } from './transport/handlers/capability-handlers'
import { registerObservabilityHandlers } from './transport/handlers/observability-handlers'
import { InsightPull } from './sync/insight-pull'
import { startMetricsRollover, stopMetricsRollover } from './data/insights/rollover'
import { onTurnRowWritten } from './data/insights/span-table'
import { projectSessionEvent, serializedBytes } from './data/sessions/result-projection'

const log = createLogger('main', 'server-boot')

export interface BootOptions {
  sessionRuntime: SessionRuntime
  /**
   * What kind of machine this process is (organization-scope §3.1): the desktop
   * app's own execution host is `personal`; the standalone server declares
   * `self-hosted`. A managed host is `managed` whatever is passed.
   */
  hostCategory?: EnrollHostCategory
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
  /**
   * The owner's own access token for this host, where the process holds the owner's
   * account session (the desktop). Its owner works here without a token of their own,
   * so this is how the host starts acting for them (plans/010-standard-oauth.md).
   */
  ownerAccessToken?: (hostId: string) => Promise<string | null>
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

/** The link this machine starts with: the environment's, which is read once and stripped, else the one stored on disk. */
function adoptStartupLink(): void {
  const provisioned = readHostLinkEnv()
  adoptProvisionedLink(provisioned ? provisioned.link : readStoredLink())
}

/** What this process is to its clients: a person's machine, one the cloud provisioned, or the cloud's own workspace service. */
function resolveHostKind(apiMode: boolean): HostKind {
  if (apiMode) return 'cloud'
  return hostCategory() === 'managed' ? 'managed' : 'personal'
}

/** The workspace service serves the collaboration plane and nothing else, whatever SOLUS_ROLES says. */
function resolveServerRoles(apiMode: boolean): ReadonlySet<SolusRole> {
  return apiMode ? new Set<SolusRole>(['collaboration']) : resolveRoles()
}

/** One verifier per link: a host with no link treats every token as a stranger's. */
function tokenVerifierForLink(link: UplinkLinkConfig | null): AccessTokenVerifier | null {
  return link ? new AccessTokenVerifier({ issuer: link.issuer, jwksUrl: link.jwksUrl, audience: hostAudience(link.hostId) }) : null
}

/** The Solus API's one verifier: the account plane's issuer, for `SOLUS_API_AUDIENCE`; null on a host, whose verifier follows its link. */
function workspaceTokenVerifier(apiMode: boolean): AccessTokenVerifier | null {
  return apiMode ? new AccessTokenVerifier({ ...apiModeConfig(), audience: SOLUS_API_AUDIENCE }) : null
}

/**
 * What a host does for its organization's Solus API once it is linked
 * (cloud-service-model.md §4–§6, §16; plans/010-standard-oauth.md): the delivery of
 * its streams, each with the delegated token of the person whose work it is, and
 * the mirror of turns its previous process left unsettled. Those rows wait in the
 * log until their person's token can carry them.
 */
function startRunnerCloud(deps: {
  uplinkManager: UplinkLinkManager
  delegations: Delegations
  linker: () => string | null
  transcriptMirror: TranscriptMirror
  interruptSweep: Promise<unknown>
}): RunnerDelivery {
  const delivery = new RunnerDelivery({
    link: () => deps.uplinkManager.currentLink(),
    delegations: deps.delegations,
    linker: deps.linker,
  })
  void deps.interruptSweep.then(listOwnInterruptedSessions).then((sessions) => {
    for (const session of sessions) deps.transcriptMirror.touch(session.sessionId, session)
  }).catch((error) => {
    log.warn('transcript_mirror_interrupted_sweep_failed', { error: String(error) })
  })
  return delivery
}

/** The workspace service's runner routes (cloud-service-model.md §16); `buildHttpServer` mounts them in API mode only. */
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
  // Before the database, the listeners, or any child process: a provisioned
  // machine's link leaves the environment first (managed-hosts.md §1, §2), and the
  // link — that one, or the one stored since — says whether Solus provisioned this
  // machine, which decides that no credential-free door opens on it.
  adoptStartupLink()
  // The environment may name the category for a test run of the standalone server; the boot's own declaration otherwise.
  const declaredCategory = enrollHostCategorySchema.safeParse(process.env.SOLUS_HOST_CATEGORY)
  applyHostCategory(declaredCategory.success ? declaredCategory.data : opts.hostCategory ?? 'personal')
  // And the workspace service refuses to start half-configured (cloud-service-model.md §15).
  applyApiMode()
  const apiMode = isApiMode()
  const apiSettings = solusApiSettings(apiMode, getInstallationId())
  const hostKind = resolveHostKind(apiMode)
  // A managed host and the workspace service demand a credential on every listener, whatever the bind policy says.
  const credentialAlwaysRequired = hostKind !== 'personal'
  const settings = getServerSettings()
  const initial = resolveEffectiveServerOptions({ host: opts.host, requireAuth: opts.requireAuth, remoteAccess: settings.remoteAccess })
  let host = initial.host
  let requireAuth = initial.requireAuth || credentialAlwaysRequired
  const port = opts.port ?? WEB_UI_PORT
  let actualPort = port

  const server = new SolusServer()
  const roles = resolveServerRoles(apiMode)
  server.useRoles(roles)
  // Ownership and share lists (docs/plans/multiplayer-sharing.md §3.4): the access
  // policy consults them on every resource call, and the event stream is filtered
  // to what each connected principal may see.
  // A resource's canonical organization (organization-scope §3): what the share
  // manager holds a member's scope against, and what its rows are written under.
  const organizationOfResource = async (resource: ShareResource): Promise<string | null> => {
    switch (resource.kind) {
      // The record is keyed by the provider thread id, not the Solus id a share names.
      case 'session': return (await getSessionRecord(ANY_ORGANIZATION, recordSessionId(resource.id)))?.organizationId ?? null
      case 'work': return workOrganizationId(resource.id)
      case 'task': return taskOrganizationId(resource.id)
    }
  }
  const shares = new ShareManager({
    db: getDatabase(),
    canonicalSessionId: (sessionId) => opts.sessionRuntime.canonicalSessionId(sessionId),
    taskContents: taskShareContents,
    containingTasks: tasksContaining,
    sessionExists: (sessionId) => opts.sessionRuntime.isKnownSession(sessionId),
    organizationOfResource: organizationOfResource,
    hasLeftOrganization: (organizationId, userId) => hasLeftOrganization(hostOrganizations.current(), organizationId, userId),
  })
  server.useResourceAccess(shares)
  const workspaceOperations = createWorkspaceOperations(shares)
  // An organization run's tools read and write its Solus API (organization-vms §3), once the link and its run authorities exist below.
  let remoteToolOperations: RemoteToolOperations | undefined
  const stopWorkspaceToolOperations = installWorkspaceToolOperations(workspaceOperations, apiSettings.serviceId, (run) => remoteToolOperations?.(run) ?? null)
  // This host's standing in its organizations (organization-scope §3.1, §6.1): the
  // control plane's answer, asked for once the link is known below, and the one
  // place a policy is held against — by the Insights producer, the turn
  // admission, and the clients.
  // A session that just started has a record before the lineage names it: the runtime's live thread id resolves it.
  useLiveRecordIds((sessionId) => opts.sessionRuntime.sessionTranscriptSource(sessionId)?.agentSessionId ?? null)
  useSessionIndexState(sessionIndexComplete)
  const hostOrganizationsDeps: { link: () => UplinkLinkConfig | null; hostToken: () => string | null } = { link: () => null, hostToken: () => null }
  const hostOrganizations = new HostOrganizations({ link: () => hostOrganizationsDeps.link(), hostToken: () => hostOrganizationsDeps.hostToken() })
  useInsightsPolicy({
    syncAllInsights: (organizationId) => hostOrganizations.organization(organizationId)?.policy.syncAllInsights ?? null,
    optedIn: (organizationId) => getInsightsOptIn().includes(organizationId),
    attached: (organizationId) => hostOrganizations.organization(organizationId)?.shared === true,
  })
  let publications: PublicationCoordinator | null = null
  // Provider seats (Step 2 plan): every turn runs on its author's own login.
  // The workspace service
  // VAULT_NOT_CONFIGURED to every seat call.
  // Who each member's Git work acts as (plans/011-cloud-coding-primitives.md stage 1).
  const gitIdentities = new GitIdentityManager({
    memberToken: (userId) => withCredentialScope(userId, () => loadToken()),
    fetchLogin: async (accessToken) => (await fetchLogin(accessToken)).login,
    credentialsDir: join(dataDir(), 'git-credentials'),
    now: Date.now,
  })
  const seats = new SeatManager({ db: getDb(), gitIdentities })
  // Every member folder on this host — projects, seats, dispatch checkouts, Git credentials — is named after its member.
  useMemberFolders(new MemberFolders({ db: getDb(), roots: () => [setupProjectsRoot(), join(seats.seatsRoot, 'claude'), join(seats.seatsRoot, 'codex')] }))
  // A record this host left `running` names a turn the previous process never settled.
  const interruptSweep = markOwnRunningSessionRecordsInterrupted().catch((error) => {
    log.warn('session_records_interrupt_sweep_failed', { error: String(error) })
  })
  phaseDone('db_opened')
  // The transcript mirror (cloud-service-model.md §6): a runner ships each
  // session's history rows to its organization's workspace service. On a host
  // that mirrors nowhere, and on the service itself, a touch does nothing.
  const transcriptMirror = new TranscriptMirror({
    loadSession: (provider, sessionId, projectPath) => opts.sessionRuntime.loadSession(provider, sessionId, projectPath),
    activitySubjectId: (sessionId) => opts.sessionRuntime.sessionActivitySubject(sessionId).id,
  })
  const touchTranscript = (sessionId: string): void => {
    const source = opts.sessionRuntime.sessionTranscriptSource(sessionId)
    if (source) transcriptMirror.touch(source.agentSessionId, source)
  }
  opts.sessionRuntime.useSeats(seats)
  const seatConnector = new SeatConnector({ seats })
  const clientEvents = new ClientEventRegistry((clientId, event) => {
    const principal = ws?.principalOf(clientId)
    return !principal || eventVisibleTo(principal, event, shares)
  })
  const events = new HostEventPublisher(clientEvents)
  // Works people edit live (work review plan, phase 3b): a room per open work;
  // its updates go to that room only, never to everyone with access.
  const workLive = new WorkLiveManager({ publish: (clientIds, type, payload) => { void events.publishToRoom({ kind: 'work', id: payload.workId }, clientIds, type, payload) } })
  // Who is here (docs/plans/multiplayer-presence.md): one entry per connected
  // client, named from its principal at admission. The host room is one
  // organization's — the whole host, or each organization of the workspace
  // service — and goes to the admitted clients in it (the audience filter keeps
  // it from guests, and a guest on a work's link gets that work's people); a
  // session's room goes to that session's watchers, who are the room.
  const presence = new PresenceManager({ describeSession: (sessionId) => opts.sessionRuntime.sessionActivityFor(sessionId) })
  const publishHostPresence = (organizationId?: string): void => {
    const rooms = organizationId ? [organizationId] : presence.organizations()
    for (const room of rooms) void publishPresenceRoom(presence, events, room)
  }
  const publishSessionPresence = (sessionId: string): void => {
    const watchers = opts.sessionRuntime.clientsWatching(sessionId)
    if (!watchers.length) return
    events.publishToRoom({ kind: 'session', id: sessionId }, watchers, 'session.presenceChanged', presence.sessionSnapshot(sessionId, watchers, opts.sessionRuntime.activeTurnFor(sessionId)))
  }
  // Streamed browser frames bypass the typed-event envelope: the transport
  // registers a per-client binary delivery here, the browser registry publishes
  // only to the clients watching each page.
  const browserFrames = new BrowserFrameChannel()
  // Native devices: one manager owns inventory, previews and control; video
  // rides its own binary channel to subscribed clients only (plan 016, D2).
  const devices = initDeviceDomain({
    publish: (state) => events.broadcast('device.stateChanged', { state }),
    surfaceRequested: (payload) => events.broadcast('device.surfaceRequested', payload),
    makeSshHost: (config) => new SshDeviceHost(config, { run: runDeviceCommand, spawn: spawnHelper }),
    isLocalSshTarget: (config) => isLocalSshTarget(config, runDeviceCommand),
  })
  void devices.manager.start().catch((err) => log.warn('device_domain_start_failed', { error: err instanceof Error ? err.message : String(err) }))
  const codeIntel = new CodeIntelManager()
  const domainEventUnsubscribes = [
    codeIntel.onStatusChanged((status) => events.broadcast('codeIntel.statusChanged', status)),
    onAutomationsChanged((event) => events.broadcast('automation.changed', event)),
    onWatchesChanged((event) => events.broadcast('watch.changed', event)),
    onAnnotationsChanged((change) => events.broadcast('annotations.changed', change)),
    onWorksChanged((change) => events.broadcast('works.changed', change)),
    onWorkDeleted((change) => events.prepareBroadcast('works.changed', change)),
    onWorkReviewsChanged((change) => events.broadcast('workReviews.changed', change)),
    // A client with no socket principal is the desktop's own IPC connection: the local owner.
    publishNotificationChanges(events, () => clientEvents.routableClientIds(), (clientId) => ws?.principalOf(clientId) ?? principalFor({ kind: 'credential-free' })),
    installWorkLiveBridge(workLive.bridge()),
    // A deleted work's room ends; its clients hear the delete as `works.changed`.
    onWorkDeleted(async (change) => async () => { workLive.forget(change.workId); return 0 }),
    stopWorkspaceToolOperations,
    onTasksChanged((taskId) => {
      // A task's links reach sessions and works: room members are checked again.
      events.forgetRoomAdmissions()
      void events.broadcast('tasks.invalidated', taskId ? { taskId } : {})
    }),
    // A task reads the pull requests of its sessions, so a session's change is
    // also a change of each task the session belongs to.
    onSessionStateChanged((sessionId) => events.broadcast('session.stateChanged', { sessionId })),
    onSessionPullRequestsChanged((sessionId) => {
      events.broadcast('session.pullRequestsChanged', { sessionId })
      void emitSessionTasksChanged(ANY_ORGANIZATION, sessionId).catch((error) => {
        log.warn('session_pull_request_tasks_notify_failed', { sessionId, error: String(error) })
      })
    }),
    onWorkspaceProjectsChanged(() => events.broadcast('workspaceProjects.changed', {})),
    onTurnRowWritten((change) => events.broadcast('metrics.turnsChanged', change)),
    onOutboxChanged(({ courierListChanged }) => {
      if (courierListChanged) events.broadcast('outbox.changed', {})
    }),
  ]
  // A pull request changed on the code host announces nothing to Solus, so PR
  // sync asks on the workspace's behalf and turns what it finds into the same
  // event an in-Solus write sends (docs/plans/pr-sync.md).
  // Pull request assignments and review requests reach the host user's hub from
  // PR sync's own needs-review read; no second poller asks the code host.
  const prObserver = hostPrObserver()
  const prSync = new PrSync({
    publish: (change) => events.broadcast('pr.changed', change),
    isSessionBusy: (sessionId) => opts.sessionRuntime.isSessionBusy(sessionId),
    observeNeedingAttention: (repo, viewer, pullRequests) => prObserver.observe(repo, viewer, pullRequests),
  })
  prSync.start()
  const hasDesktopHandlers = !!opts.windowDeps && !!opts.registerHostHandlers

  // Register handlers. Each group only registers what its deps support — the
  // headless server (no Electron window) skips window/file groups.
  if (opts.windowDeps) registerWindowHandlers(server, opts.windowDeps)

  // Every exchange between sessions — agent tools, a person answering from a
  // card, delivery of results — goes through the one orchestrator.
  const orchestrator = orchestrateSessions(opts.sessionRuntime)
  const sessionDeps: SessionDeps = {
    sessionRuntime: opts.sessionRuntime,
    orchestrator,
    agentIdFromContext: opts.agentIdFromContext,
    shares,
    hostOrganizations,
    reservedOrganization: (sessionId) => publications?.reservedOrganization({ kind: 'session', id: sessionId }) ?? null,
  }
  registerSessionHandlers(server, sessionDeps)
  registerSettingsHandlers(server, {
    sessionRuntime: opts.sessionRuntime,
    onHostConfigChanged: (snapshot) => events.broadcast('config.changed', snapshot),
  })

  registerWorktreeHandlers(server, { sessionRuntime: opts.sessionRuntime, events, gitIdentities })
  registerGitPublishHandlers(server)
  // Browsing a host's filesystem must work headless — that is the whole point
  // of pairing a server that has no window.
  registerFilesystemHandlers(server)
  registerCodeIntelHandlers(server, { codeIntel })
  registerAttachmentHandlers(server)
  registerAssetHandlers(server)
  registerHistoryHandlers(server, {
    sessionRuntime: opts.sessionRuntime,
    events,
    agentIdFromContext: opts.agentIdFromContext,
  })
  await opts.registerHostHandlers?.(server)
  phaseDone('host_handlers_registered')
  registerFolioHandlers(server, { shares })
  registerWorkReviewHandlers(server, { shares })
  registerNotificationHubHandlers(server, { shares })
  registerWorkLiveHandlers(server, { live: workLive, shares })
  registerSharingHandlers(server, { shares })
  registerCloudUploadHandlers(server, { shares })
  const sharedPrompts = apiMode ? new SharedPromptRelay(shares) : undefined
  server.register('sharedSessionAvailable', (args, ctx) => sharedPrompts ? sharedPrompts.available(ctx.principal, args[0]) : false)
  server.register('sharedSessionPrompt', (args, ctx) => {
    if (!sharedPrompts) throw new Error('Shared prompts use Solus cloud.')
    return sharedPrompts.prompt(ctx.principal, sharedPromptRequestSchema.parse(args[0]))
  })
  const profiles = new AgentProfileManager({ sourceHomes: hostProfileHomes, homeFor: (target, provider) => seats.homeFor(target.kind === 'owner' ? HOST_LOGIN_SEAT : memberSeat(target.userId, target.name), provider), now: Date.now })
  registerSeatHandlers(server, { seats, connector: seatConnector, profiles })
  registerPresenceHandlers(server, { presence, onHostChanged: (clientId) => publishHostPresence(presence.organizationOf(clientId)), onSessionChanged: publishSessionPresence })
  registerReviewHandlers(server, opts.sessionRuntime, events)
  registerAutomationHandlers(server)
  registerWatchHandlers(server)
  // Watches wait on this host and wake their session through the control plane.
  const watches = new WatchService({ dispatchWake: (wake) => opts.sessionRuntime.dispatchWake(wake) })
  // Isolated automations use the same headless SessionRuntime lifecycle as normal
  // background sessions, so their live transcript can be opened mid-run.
  setAutomationBackgroundSessionDispatcher((o) => opts.sessionRuntime.startAutomationSession(o))
  setAutomationWorktreeCreator((prompt, cwd, abortSignal, preferences) => (
    opts.sessionRuntime.checkouts.createNamed(cwd, prompt, opts.sessionRuntime, abortSignal, preferences)
  ))
  // Push every automation mutation (saves, deletes, run transitions — incl.
  // background scheduler fires) to all connected clients so the UI stays live.
  setSessionOrchestration(orchestrator)
  setAgentQueueController({
    read: (id) => opts.sessionRuntime.agentQueue(id),
    change: (id, mutation) => opts.sessionRuntime.changeAgentQueue(id, mutation),
  })
  setSessionController({
    listAgentTargets: async () => Promise.all(
      opts.sessionRuntime
        .getBackendIds()
        .map((id) => opts.sessionRuntime.getMetadataFor(id))
        .filter((metadata): metadata is AgentMetadata => metadata !== undefined)
        .map(async (metadata) => agentTargetFromMetadata(await enrichAgentMetadata(metadata))),
    ),
    getSessionInfo: (sessionId) => opts.sessionRuntime.getSessionInfo(sessionId),
    loadSessionTail: (provider, sessionId, projectPath, limit) => opts.sessionRuntime.loadSession(provider, sessionId, projectPath, limit),
    liveStatus: (sessionId) => opts.sessionRuntime.liveSessionStatus(sessionId),
    pendingInputEvents: (sessionId) => opts.sessionRuntime.pendingInputEventsForSession(sessionId),
    loadPlanContent: (provider, sessionId, projectPath, planToolUseId) =>
      opts.sessionRuntime.loadPlanContent(provider, sessionId, projectPath, planToolUseId),
    listPlans: (provider, projectPath, allProjects) => opts.sessionRuntime.listPlans(provider, projectPath, allProjects),
    invalidatePlanCaches: (sessionId) => opts.sessionRuntime.invalidatePlanCaches(sessionId),
  })
  server.register('sessionMessagesSentBy', (args) => orchestrator.exchangesSentBy(args[0]))
  // A person deciding on a plan a session it sent work to wrote, from that card.
  // The decision drives the other session, so the caller must be allowed to.
  server.register('decideSessionPlan', async (args, ctx) => {
    const [sessionCtx, targetSessionId, decision, comment] = args
    await assertRpcAccess('stopSession', ctx.principal, [targetSessionId], shares)
    return orchestrator.decidePlan(sessionCtx.session.sessionId, targetSessionId, decision === 'approve' ? 'approve' : 'request_changes', ctx.actor, comment)
  })
  server.register('stopSession', async (args, ctx) => {
    const [sessionId] = args
    if (!sessionId.trim()) throw new Error('stopSession requires a session id')
    return opts.sessionRuntime.stopSession(sessionId, ctx.actor)
  })
  server.register('stopBackgroundTasks', async (args) => {
    const [sessionId] = args
    if (!sessionId.trim()) throw new Error('stopBackgroundTasks requires a session id')
    return opts.sessionRuntime.stopBackgroundTasks(sessionId)
  })
  // Local, in-process automation scheduler. Fires time-based triggers while the
  // app is open and catches up missed fires on launch (local-only by design).
  startMetricsRollover(() => getServerSettings().metricsRetentionDays)
  // Set below once this host can act for its owner at the Solus API.
  let insightPull: InsightPull | null = null
  registerObservabilityHandlers(server, { sessionRuntime: opts.sessionRuntime, insightPull: () => insightPull })
  registerProjectConfigHandlers(server)
  registerTasksHandlers(server, { shares })
  registerOutboxHandlers(server)
  // Any host can own tasks (and their works), so the owner-side appliers
  // register unconditionally.
  registerTaskOutboxApplier()
  registerSessionOutboxApplier()
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
    checkouts: opts.sessionRuntime.checkouts,
    dispatcher: opts.sessionRuntime,
    events,
    isWorktreeInUse: (path) => opts.sessionRuntime.listGitContexts().some((context) => context.worktreePath === path),
    isSessionBusy: (sessionId) => opts.sessionRuntime.isSessionBusy(sessionId),
    prSync,
  })
  registerChecksHandlers(server)
  // The clients that run on one seat; a seat's facts go to them and nobody else.
  const clientsForSeat = (seat: Seat): string[] =>
    [...ws.sessions.values()].filter((session) => seatKey(seatFor(actorFor(session.principal))) === seatKey(seat)).map((session) => session.clientId)
  registerUsageHandlers(server, {
    sessionRuntime: opts.sessionRuntime,
    events,
    seats,
    clientsForSeat,
  })
  registerSkillsHandlers(server, { sessionRuntime: opts.sessionRuntime, seats })
  registerPinnedSessionsHandlers(server)
  registerSessionReadStateHandlers(server, { events })
  phaseDone('domain_handlers_registered')
  const hostUpdates = new UpdateStatusService({
    currentVersion: packageJson.version,
    install: hostCategory() === 'managed' ? 'cloud' : detectInstallKind(),
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
    blockNewTurns: (blocked) => { opts.sessionRuntime.setUpdatePending(blocked); setAutomationUpdatesPaused(blocked); watches.setPaused(blocked) },
    hasWork: () => activeSetupSteps > 0 || hasAutomationWork() || watches.hasWork() || opts.sessionRuntime.hasWorkForUpdate(),
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
  // Restore receipts before scheduled work or client admission can add requests.
  const interruptedSessions = await interruptSweep
  orchestrator.recover()
  if (interruptedSessions) orchestrator.reportChildrenInterruptedByRestart(interruptedSessions)
  startAutomationScheduler()
  watches.start()
  server.register('hostInstallUpdate', () => { remoteUpdates.install(); return structuredClone(hostUpdates.status) })
  server.register('hostCancelUpdate', () => { remoteUpdates.cancel(); return structuredClone(hostUpdates.status) })
  server.register('hostUpdateStatus', () => structuredClone(hostUpdates.status))
  server.register('hostCheckForUpdates', () => hostUpdates.check())
  hostUpdates.start()
  const modelProfiles = new ModelProfilesService({
    cachePath: join(solusDir(), 'model-profiles.json'),
    download: downloadModelProfiles,
    publish: (status) => { events.broadcast('host.modelProfilesChanged', status) },
  })
  server.register('modelProfilesStatus', () => modelProfiles.status)
  server.register('modelProfilesRefresh', () => modelProfiles.refresh())
  modelProfiles.start()
  registerSetupHandlers(server, { gitIdentities, events, checkouts: opts.sessionRuntime.checkouts,
    assertNewWorkAllowed: () => opts.sessionRuntime.assertNewWorkAllowed(),
    onActiveStepsChanged: (count) => { activeSetupSteps = count },
    onProviderInstalled: (agent) => hostUpdates.providerInstalled(agent),
    seats,
  })
  registerDeviceHandlers(server, {
    domain: devices,
    testSshHost: async (config) => (await isLocalSshTarget(config, runDeviceCommand)
      ? { ok: false, isLocal: true, checks: [{ name: 'ssh', ok: false, detail: 'This target is this Solus host. Its devices already appear under This machine.' }] }
      : new SshDeviceHost(config, { run: runDeviceCommand, spawn: spawnHelper }).test()),
  })
  // Browser pages are server-owned so an agent addresses the same page the user
  // sees, and keeps addressing it after the pane closes. A headless host still
  // registers the domain: it can discover targets and hold pages, and reports
  // `no-surface` rather than pretending to drive one.
  const browserRegistry = registerBrowserHandlers(server, { events, frames: browserFrames, checkouts: opts.sessionRuntime.checkouts })
  opts.sessionRuntime.checkouts.onChange((change) => {
    void events.broadcast('git.checkoutChanged', change)
  })

  server.register('getServerCapabilities', (_args, ctx) => probeServerCapabilities({
    headless: !opts.windowDeps,
    desktopHandlers: hasDesktopHandlers,
    version: packageJson.version,
    principal: ctx.principal,
  }))
  registerCapabilityHandlers(server)

  // Attention: expose the active per-session entries and push every change. Each
  // client receives the full list of the sessions it can open (plan 004 item 5).
  server.register('listAttention', async (_args, ctx) => attentionVisibleTo(ctx.principal, opts.sessionRuntime.attention.list(), shares))

  // Filtering is async; the chain keeps each client's snapshots in the order the changes happened.
  let attentionDelivery = Promise.resolve()
  opts.sessionRuntime.attention.onChange((entries) => {
    attentionDelivery = attentionDelivery.then(() => Promise.all(clientEvents.routableClientIds().map(async (clientId) => {
      const principal = ws?.principalOf(clientId)
      const visible = principal ? await attentionVisibleTo(principal, entries, shares) : entries
      await events.publish(clientId, 'attention.snapshotChanged', { entries: visible })
    }))).then(() => {}, (error) => { log.warn('attention_publish_failed', { error: String(error) }) })
  })
  setVoiceModelStatusListener((status) => events.broadcast('voice.modelStatusChanged', status))

  // One publish per watching client. Two panes on one renderer are one client
  // and receive one payload; desktop and web are two, with the same payload.
  opts.sessionRuntime.on('event', (sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }) => {
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
    let clients = opts.sessionRuntime.clientsWatching(sessionId)
    if (to?.only) clients = clients.filter((clientId) => clientId === to.only)
    if (to?.except) clients = clients.filter((clientId) => clientId !== to.except)
    // The watchers are the session's room: each is checked on its first event, not on every token.
    if (clients.length) events.publishToRoom({ kind: 'session', id: sessionId }, clients, 'session.eventReceived', { sessionId, event: projectedEvent })
  })
  opts.sessionRuntime.on('error', (sessionId: string, error: EnrichedError) => {
    const clients = opts.sessionRuntime.clientsWatching(sessionId)
    if (clients.length) events.publishToRoom({ kind: 'session', id: sessionId }, clients, 'session.errorReceived', { sessionId, error })
  })
  opts.sessionRuntime.on('session-index-updated', (event: SessionIndexUpdatedEvent) => {
    events.broadcast('session.indexChanged', event)
  })
  // Global session-status feed: agent-conversation cards track sessions no
  // client is watching.
  opts.sessionRuntime.on('session-status', (event: HostEventMap['session.statusChanged']) => {
    events.broadcast('session.statusChanged', event)
    // A turn started or settled: the room's "whose turn" line follows the status,
    // and so does the roster row of everyone who has the session focused.
    publishSessionPresence(event.sessionId)
    if (presence.isSessionFocused(event.sessionId)) publishHostPresence()
    // A settled turn is mirrored at once, so the cloud copy is whole when the session goes quiet.
    touchTranscript(event.sessionId)
    if (event.agentSessionId && !isSessionBusyStatus(event.status)) void transcriptMirror.flushNow(event.agentSessionId)
  })
  opts.sessionRuntime.on('watchers-changed', (sessionId: string) => publishSessionPresence(sessionId))

  // Personal Uplink: the tunnel listener, the link to the control plane, and the
  // verifier for its grants. All three exist on every host; only a linked host uses them.
  // The workspace service has none of them (cloud-service-model.md §15): its one
  // verifier trusts the cloud issuer for `SOLUS_API_AUDIENCE`, and it never links.
  let tunnelPort = 0
  const isTunnelRequest = (incoming: IncomingMessage): boolean =>
    tunnelPort !== 0 && incoming.socket.localPort === tunnelPort
  // One verifier per link: it follows the link record, and a host with no link
  // treats every grant as a stranger's.
  let tokenVerifier: AccessTokenVerifier | null = workspaceTokenVerifier(apiMode)
  let runnerDelivery: RunnerDelivery | null = null
  let delegations: Delegations | null = null
  // A link again under the same host id is a new generation with a new OAuth client.
  const linkKey = (link: UplinkLinkConfig | null) => link ? `${link.hostId}:${link.connectionGeneration}` : null
  let linkedKey = linkKey(readStoredLink())
  const followLink = (link: UplinkLinkConfig | null): void => {
    if (apiMode) return
    tokenVerifier = tokenVerifierForLink(link)
    // A provisioned machine's link names the organization it was made for (organization-scope §3, R9).
    adoptProvisionedLink(link)
    // Another link is another OAuth client: nothing the old one held acts for anyone now.
    if (linkKey(link) !== linkedKey) delegations?.clear()
    linkedKey = linkKey(link)
    // Unlinked: the owner's Local rows go back to the host's `local` user (U5).
    if (!link) void followHostAccount(getDatabase(), null)
    runnerDelivery?.linkChanged()
    hostOrganizations.linkChanged()
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
    provisionedLink: readHostLinkEnv,
  })
  followLink(uplinkManager.currentLink())
  // The attachment is stored with the link (organization-vms §4): an unlink resets the machine to personal.
  useOrganizationAttachment(() => uplinkManager.attachedAt())
  // A linked host shared with an organization delivers its cloud-owned writes and
  // its session records to the organization's workspace service (§16).
  useIntegrationExecutor({ link: () => uplinkManager.currentLink(), hostToken: () => uplinkManager.hostToken() })
  hostOrganizationsDeps.link = () => uplinkManager.currentLink()
  hostOrganizationsDeps.hostToken = () => uplinkManager.hostToken()
  // A managed machine holds itself awake while it has work, and tells the control plane when to wake it (plan 004 item 3).
  const managedHostActivity = new ManagedHostActivity({
    isBusy: () => opts.sessionRuntime.hasWorkToKeepAwake(),
    nextDueAt: nextAutomationDueAt,
    lastForegroundAt: () => activityLeases.lastForegroundAt(),
    link: () => uplinkManager.currentLink(),
    hostToken: () => uplinkManager.hostToken(),
  })
  if (!apiMode) {
    // The host's user (plans/012 §1): its `local` id is minted once, and the rows
    // written before it had one move to it, before any client connects. The Solus
    // API has no host user.
    await adoptHostUser(getDatabase(), hostUserSettings())
    // How this host acts for people in organizations (plans/010-standard-oauth.md): a
    // refused refresh means the person may no longer work here there, and removal
    // ends everything — their runs stop, their automations pause, and what their
    // work left undelivered is dropped.
    const hostDelegations = new Delegations({
      link: () => uplinkManager.currentLink(),
      client: () => uplinkManager.oauthClient(),
      personToken: async (userId) => {
        const held = heldPersonToken(userId)
        if (held) return held
        const hostId = uplinkManager.currentLink()?.hostId
        return hostId && userId === hostOrganizations.owner()?.userId ? await opts.ownerAccessToken?.(hostId) ?? null : null
      },
      onRevoked: (userId, organizationId) => {
        gitIdentities.revoke(userId)
        const sessions = hostDelegations.sessionsActingFor(userId, organizationId)
        for (const sessionId of sessions) opts.sessionRuntime.stopSession(sessionId, HOST_ACTOR)
        const dropped = dropQueuedFor({ organizationId, actorUserId: userId })
        void pauseAutomationsOf(userId, organizationId).then((paused) => {
          log.info('delegation_revoked', { userId, organizationId, stoppedSessions: sessions.length, droppedRows: dropped, pausedAutomations: paused.length })
        })
      },
    })
    delegations = hostDelegations
    // Insights across hosts (docs/plans/insights-across-hosts.md): the owner's turns other hosts ran.
    insightPull = new InsightPull({
      userId: () => hostOrganizations.owner()?.userId ?? null,
      hostId: () => uplinkManager.currentLink()?.hostId ?? null,
      organizations: () => hostOrganizations.organizations().map((entry) => entry.organizationId).filter(insightsEligible),
      onChange: (state) => events.broadcast('metrics.insightPullChanged', state),
      source: async (userId, organizationId) => {
        await hostDelegations.ensure(userId, organizationId)
        const client = hostDelegations.apiClient(userId, organizationId)
        return {
          listInsights: (query) => client.request('listInsights', { query }),
          getInsightSpans: (insightId) => client.request('getInsightSpans', { id: insightId }),
        }
      },
    })
    useDelegatedTokens(async (userId) => {
      const held = hostDelegations.holders().find((holder) => holder.userId === userId)
      return held ? hostDelegations.accessToken(held.userId, held.organizationId) : null
    })
    runnerDelivery = startRunnerCloud({
      uplinkManager,
      delegations: hostDelegations,
      linker: () => hostOrganizations.owner()?.userId ?? null,
      transcriptMirror,
      interruptSweep,
    })
    domainEventUnsubscribes.push(startSharedPromptRunner(runnerDelivery, opts.sessionRuntime, () => uplinkManager.currentLink()?.hostId ?? null))
    // Publication (organization-scope §7): started from Share or Move; each delivery pass ends in `resume`, which commits what the service received.
    const coordinator = new PublicationCoordinator({
      delivery: runnerDelivery,
      transcriptMirror,
      // A publication names the record (the provider thread id); the runtime's live session is found through it.
      transcriptSource: (recordId) => opts.sessionRuntime.sessionTranscriptSource(opts.sessionRuntime.sessionIdForRecord(recordId)),
      hostId: () => uplinkManager.currentLink()?.hostId ?? null,
      onChanged: (publication) => events.broadcast('publication.changed', publication),
    })
    publications = coordinator
    domainEventUnsubscribes.push(runnerDelivery.onCycle(() => coordinator.resume()))
    // A standing change (a share made, a policy edited) is the moment to ask for grants
    // again; a standing that shows the machine attached is recorded before the next
    // organization work is admitted (organization-vms §4).
    domainEventUnsubscribes.push(hostOrganizations.onChanged((standing) => {
      // Linked: the host's user becomes the owner's account, and its rows follow (U5).
      if (standing?.owner) void followHostAccount(getDatabase(), standing.owner)
      if (standing?.organizations.some((entry) => entry.shared)) uplinkManager.markAttached()
      runnerDelivery?.retryWaiting()
    }))
    // Organization runs on an attached machine (organization-vms §3, §4): the host acts
    // for the person behind each turn, and its tools use the Solus API as them.
    const delivery = runnerDelivery
    domainEventUnsubscribes.push(onSessionRecordBound((sessionId, recordId) => hostDelegations.bindRecord(sessionId, recordId)))
    sessionDeps.delegations = hostDelegations
    sessionDeps.markAttached = () => { uplinkManager.markAttached() }
    remoteToolOperations = ({ recordId, solusSessionId }) => {
      const actor = (solusSessionId ? hostDelegations.actorOf(solusSessionId) : null) ?? hostDelegations.actorOf(recordId)
      if (!actor) return null
      return remoteWorkspaceOperations(hostDelegations.apiClient(actor.userId, actor.organizationId), (sessionRecordId) => delivery.deliverSessionReport(sessionRecordId))
    }
  }
  registerOrganizationHandlers(server, {
    hostOrganizations,
    publications,
    forgetResource: (resource) => shares.forget(resource),
    events,
    linkHostId: () => uplinkManager.currentLink()?.hostId ?? null,
    apiUrl: () => uplinkManager.currentLink()?.apiUrl ?? null,
    delivery: () => ({ backlog: deliveryBacklog(), error: runnerDelivery?.currentStatus().error ?? null }),
  })

  const { server: http, requestListener } = buildHttpServer({
    solusApi: { operations: workspaceOperations, ...apiSettings },
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
    pairingDisabled: credentialAlwaysRequired,
    isApiMode: apiMode,
    verifyAccessToken: (token) => tokenVerifier
      ? tokenVerifier.verify(token)
      : Promise.resolve({ ok: false, reason: 'not-linked' }),
    resolveShareSecret: apiMode ? (secret) => shares.resolveLinkSecret(secret) : undefined,
    runner: {
      ...runnerRoutes(shares),
      applyMirror: (runner, request) => applyRunnerMirror(runner, request, (sessionId) => events.broadcast('session.transcriptChanged', { sessionId })),
    },
    sharedPrompts,
    transcribeAudio: opts.transcribeAudio,
  })
  const responseReceiptBudget = new ResponseReceiptBudget()
  // Everyone who can see the resource learns of the change; a removed guest link
  // ends its sockets at once, a removed member fails on their next call (§3.4).
  domainEventUnsubscribes.push(shares.onChanged((change) => {
    // A share list changed: room members are checked again on their next event,
    // and live rooms drop or downgrade the people who lost access.
    events.forgetRoomAdmissions()
    void workLive.revalidate((principal, resource) => shares.roleFor(principal, resource))
    const { guestsRevoked, organizationId, organizationSharedBy, ...payload } = change
    // A session opened to the organization is news to everyone in it (plan 004 step 12).
    if (organizationSharedBy && change.resource.kind === 'session') {
      void opts.sessionRuntime.recordActivity({ kind: 'session', id: change.resource.id }, organizationSharedBy, { kind: 'shared', with: 'organization' })
    }
    const recipients = clientEvents.routableClientIds().filter(clientId => {
      const principal = ws.principalOf(clientId)
      return principal ? scopeAdmits(recordScopeOf(principal), organizationId) : organizationId === LOCAL_ORGANIZATION_ID
    })
    void events.publish(recipients, 'share.changed', payload)
    if (!guestsRevoked) return
    ws.disconnectWhere((principal) => principal.kind === 'guest'
      && scopeAdmits(recordScopeOf(principal), organizationId)
      && principal.share.resource.kind === change.resource.kind
      && shares.canonical(principal.share.resource).id === change.resource.id, 'share-link-revoked')
  }))
  // A seat changes for one member; only that member's clients hear it.
  domainEventUnsubscribes.push(seats.onChanged((event) => {
    events.publish(clientsForSeat(event.seat), 'host.seatChanged', event)
  }))
  // Seats of members who ran nothing for thirty days are removed (plan §3.7).
  const seatSweepTimer = setInterval(() => {
    if (!apiMode) seats.sweep().catch((err) => log.warn('seat_sweep_failed', { error: err instanceof Error ? err.message : String(err) }))
  }, 24 * 60 * 60_000)
  seatSweepTimer.unref()
  let ws = attachWebSocketTransport(http, server, {
    clientEvents,
    browserFrames,
    deviceFrames: devices.frames,
    requireAuth: () => requireAuth,
    isTrustedRequester: isTrustedRequesterAddress,
    isTunnelRequest,
    responseBudget: responseReceiptBudget,
    onClientConnected: ({ clientId }) => {
      handlePresenceConnected(clientId)
    },
    onClientDisconnected: ({ clientId }) => {
      prSync.dropConnection(clientId)
      handlePresenceDisconnected(clientId)
      workLive.disconnected(clientId)
      void devices.manager.cancelInput(clientId)
    },
    onClientExpired: ({ clientId }) => {
      opts.sessionRuntime.handleClientExpired(clientId)
      void browserRegistry.dropClient(clientId)
      void devices.manager.dropClient(clientId)
    },
  })
  // A member the organization standing no longer lists loses their seats and sockets (plan 004 item 10).
  // The workspace service never reads a standing, so this never fires there.
  domainEventUnsubscribes.push(hostOrganizations.onChanged((standing) => {
    removeDepartedMembers(standing, { seats, disconnectWhere: (predicate, reason) => ws.disconnectWhere(predicate, reason) })
      .catch((err) => log.warn('departed_members_failed', { error: err instanceof Error ? err.message : String(err) }))
  }))
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
    else if (room !== undefined) void publishPresenceRoom(presence, events, room, [clientId])
    for (const sessionId of opts.sessionRuntime.sessionsWatchedBy(clientId)) publishSessionPresence(sessionId)
  }
  function handlePresenceDisconnected(clientId: string): void {
    const room = presence.organizationOf(clientId)
    const left = presence.leave(clientId)
    if (!left) return
    publishHostPresence(room)
    const rooms = new Set(opts.sessionRuntime.sessionsWatchedBy(clientId))
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
      await opts.sessionRuntime.refreshSessionIndexes()
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
  if (!apiMode) {
    tunnelPort = await bindTunnelListener(tunnelHttp, uplinkManager.currentLink()?.proxiedPort ?? DEFAULT_TUNNEL_LISTENER_PORT)
    void uplinkManager.resume().catch((err) => {
      log.warn('uplink_resume_failed', { error: err instanceof Error ? err.message : String(err) })
    }).finally(() => {
      runnerDelivery?.start()
      hostOrganizations.start()
      managedHostActivity.start()
      publications?.resume()
    })
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
    prSync.dropClients()
    try { ws.close() } catch (err) { log.warn('ws_close_failed_during_rebind', { error: err instanceof Error ? err.message : String(err) }) }
    await new Promise<void>((resolve) => http.close(() => resolve()))
    actualPort = await listenWithRetries(actualPort)
    ws = attachWebSocketTransport(http, server, {
      clientEvents,
      browserFrames,
      deviceFrames: devices.frames,
      requireAuth: () => requireAuth,
      isTrustedRequester: isTrustedRequesterAddress,
      isTunnelRequest,
      responseBudget: responseReceiptBudget,
      onClientConnected: ({ clientId }) => {
        handlePresenceConnected(clientId)
      },
      onClientDisconnected: ({ clientId }) => {
        prSync.dropConnection(clientId)
        handlePresenceDisconnected(clientId)
        workLive.disconnected(clientId)
        void devices.manager.cancelInput(clientId)
      },
      onClientExpired: ({ clientId }) => {
        opts.sessionRuntime.handleClientExpired(clientId)
        void browserRegistry.dropClient(clientId)
        void devices.manager.dropClient(clientId)
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
        watches.stop()
        stopMetricsRollover()
        prSync.stop()
        hostUpdates.stop()
        modelProfiles.stop()
        remoteUpdates.stop()
        stopSupervisor?.()
        codeIntel.dispose()
        await devices.manager.dispose()
        await devices.bridge.stop()
        for (const unsubscribe of domainEventUnsubscribes) unsubscribe()
        if (sessionIndexPollTimer) clearTimeout(sessionIndexPollTimer)
        sessionIndexPollTimer = null
        clearInterval(seatSweepTimer)
        await seatConnector.stopAll()
        await lanDiscovery.close()
        transcriptMirror.dispose()
        hostOrganizations.stop()
        await managedHostActivity.stop()
        await runnerDelivery?.stop()
        await uplinkConnector.stop()
        prSync.dropClients()
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
