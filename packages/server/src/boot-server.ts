import { installWorkspaceToolOperations, type RemoteToolOperations } from './data/workspace/tool-context'
import { solusApiSettings } from './host/solus-api-settings'
import { createWorkspaceOperations } from './data/workspace/service'
import { AccountReads, useAccountReads } from './vault/account-reads'
import { ANY_ORGANIZATION, principalFor, recordScopeOf, scopeAdmits } from './admission/principal'
import type { ShareResource } from '@solus/contracts/sharing'
import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import { userKey } from '@solus/contracts/user'
import { workOrganizationId } from './data/works/works'
import { taskOrganizationId } from './data/tasks/task-store'
import { transcriptDestination } from './sync/mirror/transcript-mirror'
import { appendMirror } from './sync/mirror/mirror-log'
import { RemoteUpdateService } from './updates/remote-update-service'
import type { ServerUpdateSupport, SupervisorMessage } from '@solus/contracts/server-update'
import { UpdateStatusService } from './updates/update-status-service'
import { ModelProfilesService, downloadModelProfiles } from './updates/model-profiles-service'
import { detectInstallKind } from './updates/install-kind'
import { fetchLatestRelease } from './updates/release-sources'
import { readProviderVersion } from './updates/provider-versions'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { createServer as createNodeHttpServer, type IncomingMessage, type Server as HttpServer } from 'http'
import { SolusServer } from './transport/server'
import { buildHttpServer, type HttpServerOptions } from './transport/http'
import { AccessTokenVerifier, type TokenVerdict } from './admission/access-tokens'
import { CloudflaredConnector, resolveCloudflaredBinary } from './transport/uplink/connector'
import { readStoredTunnel, splitLegacyLinkRecord, UplinkLinkManager } from './transport/uplink/link'
import { HostRegistrar, readStoredRegistration } from './host/host-registration'
import { RunnerDelivery } from './sync/runner-delivery'
import type { TurnOrganizationDeps } from './execution/sessions/turn-organization'
import { Delegations, establishWith } from './sync/delegations'
import { remoteWorkspaceOperations } from './sync/remote-operations'
import { useOrganizationAttachment } from './host/organization-attachment'
import { applyRunnerMirror, applyRunnerOutbox, applyRunnerSessionRecords } from './sync/runner-intake'
import { insightsEligible, useInsightsPolicy } from './sync/mirror/insight-mirror'
import { HostOrganizations } from './host/organizations'
import { hasLeftOrganization, removeDepartedMembers } from './host/departed-members'
import { ManagedHostActivity } from './host/managed-host-activity'
import { LiveActivityRelay } from './host/live-activity-relay'
import { activityLeases } from './execution/activity-leases'
import { adoptProvisionedRegistration, applyHostCategory, hostCategory, provisionedOrganizationId } from './host/host-category'
import { getInsightsOptIn, hostUserSettings } from './host/settings'
import { adoptHostUser, followHostAccount } from './host/host-user-rows'
import { registerOrganizationHandlers } from './transport/handlers/organization-handlers'
import { enrollHostCategorySchema, type EnrollHostCategory } from '@solus/contracts/uplink'
import { TranscriptMirror, listOwnInterruptedSessions } from './sync/mirror/transcript-mirror'
import { applyApiMode, isApiMode, apiModeConfig, apiModeCredential } from './host/api-mode'
import type { HostCredential } from './host/host-credential'
import { SOLUS_API_AUDIENCE, directoryResponseSchema, hostAudience, hostReachAudience, type HostKind, type HostRegistration } from '@solus/contracts/uplink'
import { registerUplinkHandlers } from './transport/handlers/uplink-handlers'
import { registerSharingHandlers } from './transport/handlers/sharing-handlers'
import { registerCloudUploadHandlers } from './transport/solus-api/cloud-uploads'
import { ShareManager } from './sharing/share-manager'
import { profileTargetFor, registerSeatHandlers } from './transport/handlers/seat-handlers'
import { registerIntegrationHandlers } from './transport/handlers/integration-handlers'
import { IntegrationStore } from './integrations/integration-store'
import { IntegrationCatalog } from './integrations/catalog'
import { IntegrationGateway } from './integrations/gateway'
import { hostIntegrationSecrets, IntegrationConnectionStore } from './integrations/connection-store'
import { IntegrationConnections } from './integrations/connections'
import { IntegrationOAuth, type IntegrationConnectionEvents } from './integrations/oauth'
import { setIntegrationGateway } from './integrations/integration-tools'
import { AgentProfileManager, hostProfileHomes, type AgentProfileTarget } from './execution/seats/agent-profile'
import { profileIntegrations } from './integrations/profile-integrations'
import { CloudIntegrationCredentials } from './integrations/cloud-credentials'
import { installSkill, listInstalledSkills, removeSkill } from './skills/skills-provider'
import { publishPresenceRoom, registerPresenceHandlers } from './transport/handlers/presence-handlers'
import { PresenceManager } from './presence/presence-manager'
import { SeatManager, memberHomeDirectory, seatKey } from './execution/seats/seat-manager'
import { ActingIdentities, useActingIdentities, withActorScope } from './execution/seats/acting-identity'
import { actorFor, credentialUserFor, HOST_ACTOR, memberSeat, seatFor } from './admission/actor'
import { MemberFolders, useMemberFolders } from './host/member-folders'
import { setupProjectsRoot } from './workspace'
import { fetchLogin } from './providers/github/auth'
import { loadToken } from './providers/github/token-store'
import { solusGitHelper } from './providers/github/git-credential'
import { SeatConnector } from './execution/seats/seat-connect'
import { AgentAuthFlows } from './execution/seats/agent-auth'
import { attentionVisibleTo, eventVisibleTo } from './sharing/event-audience'
import { getDb } from './db'
import { closeDatabase, getDatabase } from './db/database'
import { assignSessionOrganization, getSessionRecord, markOwnRunningSessionRecordsInterrupted, onSessionRecordChanged, useSessionIndexState } from './data/sessions/session-records'
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
import { ensureBackgroundSessionTitle, type BackgroundSessionTitleRequest } from './execution/sessions/background-session-title'
import { registerFolioHandlers } from './transport/handlers/folio-handlers'
import { registerReviewHandlers } from './transport/handlers/review-handlers'
import { ReviewGuideJobs } from './review/guide-jobs'
import { publishGuideStatus } from './review/guide-events'
import { localGuideSource, prGuideSource } from './review/guide-sources'
import { registerAutomationHandlers } from './transport/handlers/automation-handlers'
import { startAutomationScheduler, stopAutomationScheduler } from './execution/automations/automation-scheduler'
import { hasAutomationWork, setAutomationUpdatesPaused, setAutomationBackgroundSessionDispatcher, setAutomationWorktreeCreator } from './execution/automations/automation-runner'
import { nextAutomationDueAt, onAutomationsChanged, pauseAutomationsOf } from './data/automations/automations-store'
import { setRemoteHosts, setSessionController, setSessionOrchestration } from './execution/agents/tools/session-tools'
import { RemoteHosts } from './execution/orchestration/remote-hosts'
import { LocalClientDoor, type LocalClient } from './transport/local-client'
import { IntroducedHosts } from './execution/orchestration/introduced-hosts'
import type { AccountReach, ReachActor, ReachRequest } from './execution/orchestration/remote-hosts'
import { reachableUrls } from './transport/endpoints'
import { orchestrateSessions } from './execution/orchestration/orchestrate-sessions'
import { onAnnotationsChanged } from './annotations/annotation-events'
import { onWorkDeleted, onWorksChanged } from './data/works/work-events'
import { onWorkReviewsChanged } from './data/works/work-reviews'
import { registerWorkReviewHandlers } from './transport/handlers/work-review-handlers'
import { registerNotificationHubHandlers } from './transport/handlers/notification-hub-handlers'
import { publishNotificationChanges } from './notifications/hub-events'
import { publishTaskSnoozeChanges } from './transport/events/task-snooze-events'
import { hostPrObserver } from './notifications/pr-observer'
import { registerWorkLiveHandlers } from './transport/handlers/work-live-handlers'
import { WorkLiveManager } from './work-live/work-live-manager'
import { installWorkLiveBridge } from './data/works/work-live-bridge'
import { registerConnectionsHandlers } from './transport/handlers/connections-handlers'
import { registerAuthHandlers } from './transport/handlers/auth-handlers'
import { registerSettingsHandlers } from './transport/handlers/settings-handlers'
import { isLanDiscoveryDisabled, startLanDiscoveryService, type LanDiscoveryService } from './transport/lan-discovery'
import { registerGoogleHandlers } from './transport/handlers/google-handlers'
import { registerProviderHandlers } from './transport/handlers/provider-handlers'
import { PrSync } from './prs/pr-sync'
import { PrWatcher } from './prs/pr-watcher'
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
import { registerLiveActivityHandlers } from './transport/handlers/live-activity-handlers'
import { registerProjectConfigHandlers } from './transport/handlers/project-config-handlers'
import { onWorkspaceProjectsChanged } from './projects/workspace-projects'
import { onProjectsChanged } from './project-config/projects-manifest'
import { registerTasksHandlers } from './transport/handlers/tasks-handlers'
import { setVoiceModelStatusListener } from './model-downloader'
import { createLogger, isDebugEnabled } from './logger'
import { getInstallationId, issueSessionToken, revokeDevice } from './admission/auth'
import { probeHostCapabilities, registerSetupHandlers } from './transport/handlers/setup-handlers'
import packageJson from '../../../package.json'
import { dataDir, solusDir } from './platform/paths'
import { onTasksChanged } from './data/tasks/task-store'
import { emitSessionTasksChanged } from './data/tasks/task-sessions'
import { onSessionPullRequestsChanged } from './data/sessions/session-pull-requests'
import { onPullRequestWatchesChanged, stopSessionPullRequestWatches } from './data/sessions/pull-request-watches'
import { onSessionReadStateChanged, onSessionStateChanged } from './data/sessions/session-states'
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
import { activityFor } from './data/activity/activity'
import { WorktreeMover } from './execution/sessions/worktree-move'
import { WorktreeOffers } from './execution/sessions/worktree-offers'
import { setWorktreeMover } from './execution/agents/tools/worktree-tools'

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
}

export interface BootedServer {
  server: SolusServer
  events: HostEventPublisher
  http: HttpServer
  host: string
  port: number
  /**
   * The door of an account client in this process (the desktop's main process): it
   * presents its token for this host, as a remote client does at the ticket door
   * (docs/adr/0001-standard-authentication.md §2.2 rule 10).
   */
  localClient: LocalClient
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

/** The registration this machine starts with: the environment's, which is read once and stripped, else the one stored on disk. */
function adoptStartupRegistration(): void {
  splitLegacyLinkRecord()
  const provisioned = readHostLinkEnv()
  adoptProvisionedRegistration(provisioned ? provisioned.registration : readStoredRegistration())
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

/** One verifier per registration: a host with none treats every token as a stranger's. */
function tokenVerifierFor(registration: HostRegistration | null): AccessTokenVerifier | null {
  return registration ? new AccessTokenVerifier({ issuer: registration.issuer, jwksUrl: registration.jwksUrl, audience: hostAudience(registration.hostId), reachAudience: hostReachAudience(registration.hostId) }) : null
}

/** The Solus API's one verifier: the account plane's issuer, for `SOLUS_API_AUDIENCE`; null on a host, whose verifier follows its registration. */
function workspaceTokenVerifier(apiMode: boolean): AccessTokenVerifier | null {
  return apiMode ? new AccessTokenVerifier({ ...apiModeConfig(), audience: SOLUS_API_AUDIENCE }) : null
}

/**
 * What a host does for its organization's Solus API once it is registered
 * (cloud-service-model.md §4–§6, §16; plans/010-standard-oauth.md): the delivery of
 * its streams, each with the delegated token of the person whose work it is, and
 * the mirror of turns its previous process left unsettled. Those rows wait in the
 * log until their person's token can carry them.
 */
function startRunnerCloud(deps: {
  registrar: HostRegistrar
  delegations: Delegations
  owner: () => string | null
  transcriptMirror: TranscriptMirror
  interruptSweep: Promise<string[] | void>
}): RunnerDelivery {
  const delivery = new RunnerDelivery({
    registration: () => deps.registrar.current(),
    delegations: deps.delegations,
    owner: deps.owner,
  })
  // The sweep's `interrupted` reaches the Solus API as any record change does.
  void deps.interruptSweep.then((sessionIds) => delivery.reportStoredSessions(sessionIds ?? [])).catch((error) => {
    log.warn('session_records_interrupt_report_failed', { error: String(error) })
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
  adoptStartupRegistration()
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
      case 'session': return (await getSessionRecord(ANY_ORGANIZATION, resource.id))?.organizationId ?? null
      case 'work': return workOrganizationId(resource.id)
      case 'task': return taskOrganizationId(resource.id)
    }
  }
  const shares = new ShareManager({
    db: getDatabase(),
    sessionExists: (sessionId) => opts.sessionRuntime.isKnownSession(sessionId),
    organizationOfResource: organizationOfResource,
    // Only a session on this host moves from Local here; a Local work or task moves by its upload to the Solus API.
    assignOrganization: async (resource, organizationId) => resource.kind === 'session'
      ? (await assignSessionOrganization(resource.id, organizationId))?.organizationId ?? null
      : organizationOfResource(resource),
    hasLeftOrganization: (organizationId, userId) => hasLeftOrganization(hostOrganizations.current(), organizationId, userId),
    // A member reaches this host with a host access token, which needs the registration (host-sharing.md §4.3), never the link.
    membersReachable: () => apiMode || registrar.current() !== null,
  })
  server.useResourceAccess(shares)
  /** The host's share rows for a mirrored session, appended for its organization; nothing for a session nobody mirrors. */
  const mirrorShareRows = async (resource: ShareResource): Promise<void> => {
    const destination = await transcriptDestination(resource.id)
    if (!destination) return
    appendMirror(destination, 'shares', [{ key: `${resource.kind}:${resource.id}`, payload: { resource, rows: await shares.mirroredRows(resource) } }])
  }
  const workspaceOperations = createWorkspaceOperations(shares)
  // An organization run's tools read and write its Solus API (organization-vms §3), once the link and its run authorities exist below.
  let remoteToolOperations: RemoteToolOperations | undefined
  const stopWorkspaceToolOperations = installWorkspaceToolOperations(workspaceOperations, apiSettings.serviceId, (run) => remoteToolOperations?.(run) ?? null)
  // This host's standing in its organizations (organization-scope §3.1, §6.1): the
  // control plane's answer, asked for once the link is known below, and the one
  // place a policy is held against — by the Insights producer, the turn
  // admission, and the clients.
  useSessionIndexState(sessionIndexComplete)
  const hostOrganizationsDeps: { registration: () => HostRegistration | null; credential: () => HostCredential | null } = { registration: () => null, credential: () => null }
  const hostOrganizations = new HostOrganizations({ registration: () => hostOrganizationsDeps.registration(), credential: () => hostOrganizationsDeps.credential() })
  useInsightsPolicy({
    syncAllInsights: (organizationId) => hostOrganizations.organization(organizationId)?.policy.syncAllInsights ?? null,
    optedIn: (organizationId) => getInsightsOptIn().includes(organizationId),
    attached: (organizationId) => hostOrganizations.organization(organizationId)?.shared === true,
  })
  // Provider seats (Step 2 plan): every turn runs on its author's own login.
  // The workspace service
  // VAULT_NOT_CONFIGURED to every seat call.
  const seats = new SeatManager({ db: getDb() })
  // Who every process acts as (plans/019-acting-identity.md): a member's run in
  // their own home, with their own GitHub connection.
  const identities = new ActingIdentities({
    memberToken: () => loadToken(),
    fetchLogin: async (accessToken) => (await fetchLogin(accessToken)).login,
    memberHome: (seat) => memberHomeDirectory(seats.seatsRoot, seat),
    gitHelper: () => solusGitHelper(['--member-home']),
    now: Date.now,
  })
  useActingIdentities(identities)
  // The credential files the previous design kept per process; nothing reads them now.
  rmSync(join(dataDir(), 'git-credentials'), { recursive: true, force: true })
  // Every member folder on this host — projects, seats, homes, dispatch checkouts — is named after its member.
  useMemberFolders(new MemberFolders({ db: getDb(), roots: () => [setupProjectsRoot(), join(seats.seatsRoot, 'claude'), join(seats.seatsRoot, 'codex'), join(seats.seatsRoot, 'home')] }))
  // A record this host left `running` names a turn the previous process never settled.
  const interruptSweep = markOwnRunningSessionRecordsInterrupted().catch((error) => {
    log.warn('session_records_interrupt_sweep_failed', { error: String(error) })
  })
  phaseDone('db_opened')
  // The transcript mirror (cloud-service-model.md §6): a runner ships each
  // session's history rows to its organization's workspace service. On a host
  // that mirrors nowhere, and on the service itself, a touch does nothing.
  const transcriptMirror = new TranscriptMirror({
    loadSession: (provider, sessionId, projectPath) => opts.sessionRuntime.history.loadSession(provider, sessionId, projectPath),
    shareRows: (sessionId) => shares.mirroredRows({ kind: 'session', id: sessionId }),
  })
  const touchTranscript = (sessionId: string): void => {
    const source = opts.sessionRuntime.sessionTranscriptSource(sessionId)
    if (source) transcriptMirror.touch(sessionId, source)
  }
  opts.sessionRuntime.useSeats(seats)
  const seatConnector = new SeatConnector({ seats })
  const agentAuth = new AgentAuthFlows({ seats })
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
  const presence = new PresenceManager({ describeSession: (sessionId) => opts.sessionRuntime.watchers.sessionActivityFor(sessionId) })
  const publishHostPresence = (organizationId?: string): void => {
    const rooms = organizationId ? [organizationId] : presence.organizations()
    for (const room of rooms) void publishPresenceRoom(presence, events, room)
  }
  const publishSessionPresence = (sessionId: string): void => {
    const watchers = opts.sessionRuntime.watchers.clientsWatching(sessionId)
    if (!watchers.length) return
    events.publishToRoom({ kind: 'session', id: sessionId }, watchers, 'session.presenceChanged', presence.sessionSnapshot(sessionId, watchers, opts.sessionRuntime.watchers.activeTurnFor(sessionId)))
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
    onAnnotationsChanged((change) => events.broadcast('annotations.changed', change)),
    onWorksChanged((change) => events.broadcast('works.changed', change)),
    onWorkDeleted((change) => events.prepareBroadcast('works.changed', change)),
    onWorkReviewsChanged((change) => events.broadcast('workReviews.changed', change)),
    // A client with no socket principal is the desktop's own IPC connection: the local owner.
    publishNotificationChanges(events, () => clientEvents.routableClientIds(), (clientId) => ws?.principalOf(clientId) ?? principalFor({ kind: 'credential-free' })),
    publishTaskSnoozeChanges(events, () => clientEvents.routableClientIds(), (clientId) => ws?.principalOf(clientId) ?? principalFor({ kind: 'credential-free' })),
    installWorkLiveBridge(workLive.bridge()),
    // A deleted work's room ends; its clients hear the delete as `works.changed`.
    onWorkDeleted(async (change) => async () => { workLive.forget(change.workId); return 0 }),
    stopWorkspaceToolOperations,
    // A session that moved from Local into an organization by any path takes its share rows with it.
    onSessionRecordChanged((record) => {
      if (record.organizationId !== LOCAL_ORGANIZATION_ID) void shares.followRecordOrganization({ kind: 'session', id: record.sessionId }, record.organizationId)
    }),
    onTasksChanged((taskId) => {
      // A task's links reach sessions and works: room members are checked again.
      events.forgetRoomAdmissions()
      void events.broadcast('tasks.invalidated', taskId ? { taskId } : {})
    }),
    // A task reads the pull requests of its sessions, so a session's change is
    // also a change of each task the session belongs to.
    onSessionStateChanged((sessionId) => events.broadcast('session.stateChanged', { sessionId })),
    onSessionReadStateChanged((sessionId, viewedAt) => events.broadcast('session.readStateChanged', { sessionId, viewedAt })),
    // A link carries whether it is watched (docs/plans/pr-watch.md).
    onPullRequestWatchesChanged((sessionId) => events.broadcast('session.pullRequestsChanged', { sessionId })),
    onSessionPullRequestsChanged((sessionId) => {
      events.broadcast('session.pullRequestsChanged', { sessionId })
      void emitSessionTasksChanged(ANY_ORGANIZATION, sessionId).catch((error) => {
        log.warn('session_pull_request_tasks_notify_failed', { sessionId, error: String(error) })
      })
    }),
    onWorkspaceProjectsChanged(() => events.broadcast('workspaceProjects.changed', {})),
    onProjectsChanged(() => events.broadcast('projects.changed', {})),
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
    isSessionBusy: (sessionId) => opts.sessionRuntime.statuses.isSessionBusy(sessionId),
    observeNeedingAttention: (repo, viewer, pullRequests) => prObserver.observe(repo, viewer, pullRequests),
  })
  prSync.start()
  // Watched pull requests wake their sessions with news (docs/plans/pr-watch.md).
  const prWatcher = new PrWatcher({
    wake: async (sessionId, text, actor) => {
      await opts.sessionRuntime.dispatch.promptSession(sessionId, text, 'queue', { via: 'pull-request-watch', actor })
    },
  })
  void prWatcher.start().catch((error) => log.warn('pr_watcher_start_failed', { error: String(error) }))
  const hasDesktopHandlers = !!opts.windowDeps && !!opts.registerHostHandlers

  // Register handlers. Each group only registers what its deps support — the
  // headless server (no Electron window) skips window/file groups.
  if (opts.windowDeps) registerWindowHandlers(server, opts.windowDeps)

  // Every exchange between sessions — agent tools, a person answering from a
  // card, delivery of results — goes through the one orchestrator.
  const orchestrator = orchestrateSessions(opts.sessionRuntime)
  // Every turn and every new session, from a client or an agent, passes one admission
  // (`PromptDispatch.admitTurn`). The delegations join it once the link exists.
  const turnAdmission: TurnOrganizationDeps = {
    hostOrganizations,
    adoptSession: (sessionId, organizationId, ownerUserId, options) => shares.adoptForOrganization({ kind: 'session', id: sessionId }, organizationId, ownerUserId, options),
  }
  opts.sessionRuntime.dispatch.admission = turnAdmission
  const sessionDeps: SessionDeps = {
    sessionRuntime: opts.sessionRuntime,
    orchestrator,
    agentIdFromContext: opts.agentIdFromContext,
    shares,
  }
  registerSessionHandlers(server, sessionDeps)
  registerSettingsHandlers(server, {
    sessionRuntime: opts.sessionRuntime,
    onHostConfigChanged: (snapshot) => events.broadcast('config.changed', snapshot),
  })

  // One worktree mover for the user's move, the agent's tool, and an offer's Switch.
  const sessionCheckouts = opts.sessionRuntime.sessionCheckouts
  const worktreeMover = new WorktreeMover({
    checkouts: opts.sessionRuntime.checkouts,
    getGitContext: (sessionId) => sessionCheckouts.getGitContext(sessionId),
    trackWorktreeMove: (sessionId, controller) => sessionCheckouts.trackWorktreeMove(sessionId, controller),
    moveSessionCheckout: (sessionId, checkout) => sessionCheckouts.moveSessionCheckout(sessionId, checkout),
    recordActivity: (subject, actor, kind) => opts.sessionRuntime.recordActivity(subject, actor, kind),
    nameWorktreeBranch: (...args) => sessionCheckouts.nameWorktreeBranch(...args),
  })
  setWorktreeMover(worktreeMover, (sessionId) => opts.sessionRuntime.actorOfSession(sessionId))
  const worktreeOffers = new WorktreeOffers({
    mover: worktreeMover,
    recordActivity: (sessionId, actor, kind) => opts.sessionRuntime.recordActivity({ kind: 'session', id: sessionId }, actor, kind),
    sessionActivity: (sessionId) => activityFor(ANY_ORGANIZATION, { kind: 'session', id: sessionId }),
    hostActor: HOST_ACTOR,
  })
  opts.sessionRuntime.on('event', (sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }) => {
    if (!to) worktreeOffers.observe(sessionId, event)
  })
  registerWorktreeHandlers(server, { sessionRuntime: opts.sessionRuntime, events, worktreeMover, worktreeOffers })
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
    exchangeProgress: (exchangeId) => orchestrator.progressOf(exchangeId),
  })
  opts.sessionRuntime.on('background-session-created', (request: BackgroundSessionTitleRequest) => {
    void ensureBackgroundSessionTitle(opts.sessionRuntime, events, request).catch((error) => {
      log.warn('background_session_title_failed', { sessionId: request.sessionId, error: String(error) })
    })
  })
  await opts.registerHostHandlers?.(server)
  phaseDone('host_handlers_registered')
  registerFolioHandlers(server, { shares })
  registerWorkReviewHandlers(server, { shares })
  registerNotificationHubHandlers(server, { shares })
  registerWorkLiveHandlers(server, { live: workLive, shares })
  registerSharingHandlers(server, { shares })
  registerCloudUploadHandlers(server, { shares })
  // Integrations (docs/plans/mcp-integrations.md): the gateway's tool cache is
  // warmed at boot, without blocking it, because a run reads it synchronously.
  const integrations = new IntegrationStore()
  const integrationGateway = new IntegrationGateway(integrations)
  setIntegrationGateway(integrationGateway)
  integrationGateway.onToolsChanged((integrationId) => { void events.broadcast('integration.changed', { integrationId, change: 'tools' }) })
  integrationGateway.onConnectNeeded((request) => { void events.broadcast('integration.connectNeeded', request) })
  // A connection is one person's (§4.1): its events go to the clients whose
  // principal reads that person's credentials. A client with no socket principal
  // is the desktop's own IPC connection, the local owner.
  const clientsForCredentialUser = (credentialUserId: string | null): string[] => clientEvents.routableClientIds().filter((clientId) => {
    const credentialUser = credentialUserFor(actorFor(ws?.principalOf(clientId) ?? principalFor({ kind: 'credential-free' })))
    return (credentialUser ? userKey(credentialUser) : null) === credentialUserId
  })
  const integrationConnectionEvents: IntegrationConnectionEvents = {
    connectionChanged: (credentialUserId, event) => {
      // A sign-in or a disconnect changes the header a session must send, and the tools it sees.
      integrationGateway.invalidate(event.integrationId)
      if (event.connection?.status === 'connected') void integrationGateway.warmFor(event.integrationId, credentialUserId)
      void events.publish(clientsForCredentialUser(credentialUserId), 'integration.connectionChanged', event)
    },
    authFinished: (credentialUserId, event) => { void events.publish(clientsForCredentialUser(credentialUserId), 'host.integrationAuthFinished', event) },
  }
  const integrationConnectionStore = new IntegrationConnectionStore()
  const integrationOAuth = new IntegrationOAuth({ connections: integrationConnectionStore, integrations, secrets: hostIntegrationSecrets, events: integrationConnectionEvents })
  // Every read of a person's account (docs/adr/0001-standard-authentication.md §3.4):
  // with the person's delegated token as the bearer, from this host's delegations, or
  // the Solus API's in API mode. A person's connection may live in their account
  // (plans/020 §5): this host reads an access token per call, and holds nothing else.
  const accountReadsOfServer = new AccountReads({
    origin: () => apiMode ? apiModeConfig().issuer : hostOrganizationsDeps.registration()?.directoryUrl ?? null,
    delegations: () => delegations,
  })
  useAccountReads(accountReadsOfServer)
  const cloudCredentials = new CloudIntegrationCredentials({
    reads: accountReadsOfServer,
    userFor: (credentialUserId) => credentialUserId ?? hostOrganizations.owner()?.userId ?? null,
  })
  const integrationConnections = new IntegrationConnections({ store: integrationConnectionStore, integrations, secrets: hostIntegrationSecrets, oauth: integrationOAuth, events: integrationConnectionEvents, cloud: cloudCredentials })
  integrationGateway.useCredentials(integrationConnections)
  // The agent profile (plans/020-agent-profile.md): one owner applies a person's
  // files, registry skills, and MCP servers to their seats, or to the host's own
  // homes on a host they own; a pull reads it from their account.
  const profileSeat = (target: AgentProfileTarget): Seat => target.kind === 'owner' ? HOST_LOGIN_SEAT : memberSeat(target.userId, target.name)
  const profiles = new AgentProfileManager({
    sourceHomes: hostProfileHomes,
    homeFor: (target, provider) => seats.homeFor(profileSeat(target), provider),
    now: Date.now,
    skills: { list: listInstalledSkills, install: installSkill, remove: removeSkill },
    skillHomesFor: (target) => target.kind === 'member' ? { claudeHome: seats.homeFor(profileSeat(target), 'claude-code'), codexHome: seats.homeFor(profileSeat(target), 'codex') } : undefined,
    agentIds: () => opts.sessionRuntime.getBackendIds(),
    integrations: profileIntegrations({ store: integrations, gateway: integrationGateway, connections: integrationConnections, events }),
    integrationOwnerFor: (target) => target.kind === 'member'
      ? { organizationId: target.organizationId, ownerUserId: target.userId }
      : { organizationId: provisionedOrganizationId() ?? LOCAL_ORGANIZATION_ID, ownerUserId: null },
    account: {
      reads: accountReadsOfServer,
      userFor: (target) => target.kind === 'member' ? target.userId : hostOrganizations.owner()?.userId ?? null,
      reconcile: (owner, cloudConnections) => integrationConnections.reconcile(owner, cloudConnections).then(() => undefined),
    },
  })
  registerSeatHandlers(server, { seats, connector: seatConnector, profiles, agentAuth })
  /**
   * The organization a member's personal records belong to on this host, for a pull
   * no principal asked for: the organization this host acts for them in, else the
   * one it was provisioned for. A member of none has no profile here yet.
   */
  const memberProfileTarget = (userId: string): AgentProfileTarget | null => {
    const held = delegations?.holders().find((holder) => holder.userId === userId && holder.scope !== 'personal')?.scope
    const organizationId = (held && held !== 'personal' ? held.organizationId : null) ?? provisionedOrganizationId()
    return organizationId ? { kind: 'member', userId, organizationId } : null
  }
  registerIntegrationHandlers(server, {
    store: integrations,
    catalog: new IntegrationCatalog(),
    gateway: integrationGateway,
    events,
    connectionStore: integrationConnectionStore,
    connections: integrationConnections,
    oauth: integrationOAuth,
    secrets: hostIntegrationSecrets,
    getServerInfo: () => ({ host, port: actualPort }),
    profile: {
      saved: async (principal, integration) => {
        const target = profileTargetFor(principal)
        if (target) await profiles.integrationSaved(target, integration).catch((error) => log.warn('agent_profile_publish_failed', { error: error instanceof Error ? error.message : String(error) }))
      },
      removing: async (principal, integration) => {
        const target = profileTargetFor(principal)
        if (target) await profiles.integrationRemoving(target, integration)
      },
    },
  })
  withActorScope(HOST_ACTOR, () => {
    for (const integration of integrations.all(ANY_ORGANIZATION)) void integrationGateway.warm(integration.id)
  })
  registerPresenceHandlers(server, { presence, onHostChanged: (clientId) => publishHostPresence(presence.organizationOf(clientId)), onSessionChanged: publishSessionPresence })
  const guides = new ReviewGuideJobs((event) => publishGuideStatus(events, event), { pr: prGuideSource, local: localGuideSource })
  registerReviewHandlers(server, opts.sessionRuntime, events, guides)
  registerAutomationHandlers(server)
  // Isolated automations use the same headless SessionRuntime lifecycle as normal
  // background sessions, so their live transcript can be opened mid-run.
  setAutomationBackgroundSessionDispatcher((o) => opts.sessionRuntime.dispatch.startAutomationSession(o))
  setAutomationWorktreeCreator((prompt, cwd, abortSignal, preferences) => (
    opts.sessionRuntime.checkouts.createNamed(cwd, prompt, opts.sessionRuntime, abortSignal, preferences)
  ))
  // Push every automation mutation (saves, deletes, run transitions — incl.
  // background scheduler fires) to all connected clients so the UI stays live.
  setSessionOrchestration(orchestrator)
  const introducedHosts = new IntroducedHosts(fetch, Date.now, {
    installationId: getInstallationId,
    name: hostDisplayName,
    // The introduced host keeps the first one that answers as this host.
    urls: () => reachableUrls(host, actualPort),
    issueToken: issueSessionToken,
    revokeDevice,
  })
  // An account client in this process (the desktop) presents its token here; the host acts from what it presents.
  const localClient = new LocalClientDoor({
    hostId: () => registrar.current()?.hostId ?? null,
    needsRegistration: () => !apiMode && registrar.needsRegistration(),
    register: async (request) => { await registrar.register(request) },
    verify: (token) => verifyHostAccessToken(token),
    delegations: () => apiMode ? null : delegations,
    organizationIds: () => hostOrganizations.organizations().map((entry) => entry.organizationId),
    onEstablished: () => runnerDelivery?.retryWaiting(),
    // The signed-in account is the host's user; signed out, the local user is (ADR 0001 rule 8).
    onOwnerIdentity: (owner) => { if (!apiMode) void followHostAccount(getDatabase(), owner) },
  })
  // A registered host that is not linked is reached on the local network (ADR 0001 §2.2 rule 9).
  // Account reach (docs/plans/host-reach.md §3): the person's directory, and an
  // eight-hour host-reach token for one host, both with this host's delegation for them.
  const accountReach = (actor: ReachActor): AccountReach | null => {
    const held = delegations
    if (apiMode || !held) return null
    return {
      hosts: async () => {
        const response = await accountReadsOfServer.fetch(actor.userId, actor.scope, '/v1/hosts')
        if ('refused' in response || !response.ok) return null
        const parsed = directoryResponseSchema.safeParse(await response.json().catch(() => null))
        return parsed.success ? parsed.data.hosts : null
      },
      accessToken: async (hostId) => {
        try {
          return await held.accessToken(actor.userId, actor.scope, { kind: 'host-reach', hostId })
        } catch (error) {
          log.info('host_reach_token_unavailable', { hostId, error: error instanceof Error ? error.message : String(error) })
          return null
        }
      },
    }
  }
  const remoteHosts = new RemoteHosts(accountReach, introducedHosts, () => registrar.current()?.hostId ?? null, () => lanDiscovery.discoverServers())
  setRemoteHosts(remoteHosts)
  setSessionController({
    // A turn reaches other hosts for its own person (host-reach.md §3.2): the owner through
    // their personal delegation and the introduced hosts; a member only through the
    // organization they work in here; anyone else not at all.
    reachRequestFor: (sessionId): ReachRequest | null => {
      const actor = opts.sessionRuntime.activeRunRequests.get(sessionId)?.actor
      const principal = actor?.principal
      if (!actor?.user || principal?.kind === 'local-owner' || principal?.kind === 'remote-owner') {
        const owner = delegations?.holders().find((holder) => holder.scope === 'personal')
        return { account: owner ? { userId: owner.userId, scope: 'personal' } : null, isOwner: true }
      }
      if (principal?.kind === 'org-member') return { account: { userId: principal.userId, scope: { organizationId: principal.organizationId } }, isOwner: false }
      return null
    },
    listAgentTargets: async () => Promise.all(
      opts.sessionRuntime
        .getBackendIds()
        .map((id) => opts.sessionRuntime.getMetadataFor(id))
        .filter((metadata): metadata is AgentMetadata => metadata !== undefined)
        .map(async (metadata) => agentTargetFromMetadata(await enrichAgentMetadata(metadata))),
    ),
    getSessionInfo: (sessionId) => opts.sessionRuntime.history.getSessionInfo(sessionId),
    loadSessionTail: (provider, sessionId, projectPath, limit) => opts.sessionRuntime.history.loadSession(provider, sessionId, projectPath, limit),
    liveStatus: (sessionId) => opts.sessionRuntime.statuses.liveSessionStatus(sessionId),
    pendingInputEvents: (sessionId) => opts.sessionRuntime.inputRequests.pendingInputEventsForSession(sessionId),
    loadPlanContent: (provider, sessionId, projectPath, planToolUseId) =>
      opts.sessionRuntime.history.loadPlanContent(provider, sessionId, projectPath, planToolUseId),
    listPlans: (provider, projectPath, allProjects) => opts.sessionRuntime.history.listPlans(provider, projectPath, allProjects),
    invalidatePlanCaches: (sessionId) => opts.sessionRuntime.history.invalidatePlanCaches(sessionId),
  })
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
    // A person's Stop also ends what would wake the agent later
    // (docs/plans/pr-watch.md §7). A host stop, as when a plan is accepted, does not.
    await stopSessionPullRequestWatches(sessionId)
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
    isWorktreeInUse: (path) => opts.sessionRuntime.sessionCheckouts.listGitContexts().some((context) => context.worktreePath === path),
    isSessionBusy: (sessionId) => opts.sessionRuntime.statuses.isSessionBusy(sessionId),
    prSync,
    guides,
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
  registerSessionReadStateHandlers(server)
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
    blockNewTurns: (blocked) => { opts.sessionRuntime.setUpdatePending(blocked); setAutomationUpdatesPaused(blocked) },
    hasWork: () => activeSetupSteps > 0 || hasAutomationWork() || opts.sessionRuntime.hasWorkForUpdate(),
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
  registerSetupHandlers(server, { events, checkouts: opts.sessionRuntime.checkouts,
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

  registerCapabilityHandlers(server, (principal) => probeHostCapabilities({
    headless: !opts.windowDeps,
    desktopHandlers: hasDesktopHandlers,
    version: packageJson.version,
    principal,
  }))

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
    let clients = opts.sessionRuntime.watchers.clientsWatching(sessionId)
    if (to?.only) clients = clients.filter((clientId) => clientId === to.only)
    if (to?.except) clients = clients.filter((clientId) => clientId !== to.except)
    // The watchers are the session's room: each is checked on its first event, not on every token.
    if (clients.length) events.publishToRoom({ kind: 'session', id: sessionId }, clients, 'session.eventReceived', { sessionId, event: projectedEvent })
  })
  opts.sessionRuntime.on('error', (sessionId: string, error: EnrichedError) => {
    const clients = opts.sessionRuntime.watchers.clientsWatching(sessionId)
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
    if (event.agentSessionId && !isSessionBusyStatus(event.status)) void transcriptMirror.flushNow(event.sessionId)
  })
  opts.sessionRuntime.on('watchers-changed', (sessionId: string) => publishSessionPresence(sessionId))

  // Personal Uplink: the tunnel listener, the link to the control plane, and the
  // verifier for its grants. All three exist on every host; only a linked host uses them.
  // The workspace service has none of them (cloud-service-model.md §15): its one
  // verifier trusts the cloud issuer for `SOLUS_API_AUDIENCE`, and it never links.
  let tunnelPort = 0
  const isTunnelRequest = (incoming: IncomingMessage): boolean =>
    tunnelPort !== 0 && incoming.socket.localPort === tunnelPort
  // One verifier per registration: it follows the registration record, and a host
  // with none treats every grant as a stranger's. The link plays no part.
  let tokenVerifier: AccessTokenVerifier | null = workspaceTokenVerifier(apiMode)
  const verifyHostAccessToken = (token: string): Promise<TokenVerdict> => tokenVerifier
    ? tokenVerifier.verify(token)
    : Promise.resolve({ ok: false, reason: 'not-linked' })
  let runnerDelivery: RunnerDelivery | null = null
  let delegations: Delegations | null = null
  // A registration again under the same host id is a new generation with a new OAuth client.
  const registrationKey = (registration: HostRegistration | null) => registration ? `${registration.hostId}:${registration.generation}` : null
  let registeredKey = registrationKey(readStoredRegistration())
  let uplinkManager: UplinkLinkManager
  const followRegistration = (registration: HostRegistration | null): void => {
    if (apiMode) return
    tokenVerifier = tokenVerifierFor(registration)
    // A provisioned machine's registration names the organization it was made for (organization-scope §3, R9).
    adoptProvisionedRegistration(registration)
    // Another registration is another OAuth client: nothing the old one held acts for anyone now.
    if (registrationKey(registration) !== registeredKey) delegations?.clear()
    registeredKey = registrationKey(registration)
    runnerDelivery?.registrationChanged()
    hostOrganizations.registrationChanged()
    // A tunnel belongs to the registration it was made for.
    uplinkManager?.registrationChanged(registration)
    // The owner's client in this process presents a token for the new registration, or registers the host again.
    localClient.registrationChanged()
  }
  // What `uplinkStatus` answers: the registration, and apart from it, the link.
  const uplinkStatus = () => ({ registration: registrar.status(), link: uplinkManager.status() })
  const broadcastUplinkStatus = () => { if (uplinkManager) events.broadcast('host.uplinkStatusChanged', uplinkStatus()) }
  const registrar = new HostRegistrar({
    installationId: getInstallationId,
    hostLabel: hostDisplayName,
    os: hostOperatingSystem,
    owner: () => hostOrganizations.owner(),
    onRegistrationChanged: followRegistration,
    onStatusChanged: broadcastUplinkStatus,
    provisionedLink: readHostLinkEnv,
  })
  const uplinkConnector = new CloudflaredConnector({
    resolveBinary: resolveCloudflaredBinary,
    onObservation: (observation) => uplinkManager.handleConnectorObservation(observation),
  })
  uplinkManager = new UplinkLinkManager({
    registration: () => registrar.current(),
    controlToken: () => registrar.controlToken(),
    proxiedPort: () => tunnelPort,
    connector: uplinkConnector,
    // The connector registers after `uplinkLink` has answered: the Access tab's
    // status line follows this instead of waiting for a reload.
    onStatusChanged: broadcastUplinkStatus,
    provisionedLink: readHostLinkEnv,
  })
  followRegistration(registrar.current())
  // The attachment is stored with the registration (organization-vms §4): a deleted host is personal again.
  useOrganizationAttachment(() => registrar.attachedAt())
  // A registered host shared with an organization delivers its cloud-owned writes and
  // its session records to the organization's workspace service (§16).
  hostOrganizationsDeps.registration = () => registrar.current()
  hostOrganizationsDeps.credential = () => registrar.credential()
  // A managed machine holds itself awake while it has work, and tells the control plane when to wake it (plan 004 item 3).
  const managedHostActivity = new ManagedHostActivity({
    isBusy: () => opts.sessionRuntime.statuses.hasWorkToKeepAwake(),
    nextDueAt: nextAutomationDueAt,
    lastForegroundAt: () => activityLeases.lastForegroundAt(),
    registration: () => registrar.current(),
    credential: () => registrar.credential(),
  })
  // The phone's Live Activity while the phone is suspended: this host reports its rows to the control plane.
  const liveActivityRelay = new LiveActivityRelay({
    statusOf: (sessionId) => opts.sessionRuntime.statuses.liveSessionStatus(sessionId),
    registration: () => registrar.current(),
    credential: () => registrar.credential(),
  })
  registerLiveActivityHandlers(server, liveActivityRelay)
  opts.sessionRuntime.on('session-status', (event: HostEventMap['session.statusChanged']) => liveActivityRelay.sessionStatusChanged(event))
  if (!apiMode) {
    // The host's user (plans/012 §1): its `local` id is minted once, and the rows
    // written before it had one move to it, before any client connects. The Solus
    // API has no host user.
    await adoptHostUser(getDatabase(), hostUserSettings())
    // How this host acts for people (docs/adr/0001-standard-authentication.md §3.4): a
    // refused refresh means the person may no longer work here in that scope — a
    // sign-out ended the client grant, or a removal or detach — and it ends everything
    // there: their runs stop, their automations pause, and what their work left
    // undelivered is dropped. A personal delegation carries only account reads; the
    // owner's own work runs on none, so nothing else stops.
    const hostDelegations = new Delegations({
      registration: () => registrar.current(),
      credential: () => registrar.credential(),
      onRevoked: (userId, scope, refusal) => {
        // The owner's client in this process presents again once the delegation is gone: another grant of theirs that is still signed in makes it again.
        queueMicrotask(() => localClient.standingChanged(hostOrganizations.owner()?.userId ?? null))
        // Credentials the delegation brought, and sessions opened with them, end with it (ADR 0001 rule 5).
        cloudCredentials.clear()
        void integrationGateway.close()
        if (scope === 'personal') {
          log.info('delegation_revoked', { userId, scope, refusal })
          return
        }
        const { organizationId } = scope
        identities.revoke(userId)
        const sessions = hostDelegations.sessionsActingFor(userId, scope)
        for (const sessionId of sessions) opts.sessionRuntime.stopSession(sessionId, HOST_ACTOR)
        const dropped = dropQueuedFor({ organizationId, actorUserId: userId })
        void pauseAutomationsOf(userId, organizationId).then((paused) => {
          log.info('delegation_revoked', { userId, organizationId, refusal, stoppedSessions: sessions.length, droppedRows: dropped, pausedAutomations: paused.length })
        })
      },
    })
    delegations = hostDelegations
    // Insights across hosts (docs/plans/insights-across-hosts.md): the owner's turns other hosts ran.
    insightPull = new InsightPull({
      userId: () => hostOrganizations.owner()?.userId ?? null,
      hostId: () => registrar.current()?.hostId ?? null,
      organizations: () => hostOrganizations.organizations().map((entry) => entry.organizationId).filter(insightsEligible),
      onChange: (state) => events.broadcast('metrics.insightPullChanged', state),
      source: async (userId, organizationId) => {
        const client = hostDelegations.apiClient(userId, { organizationId })
        return {
          listInsights: (query) => client.request('listInsights', { query }),
          getInsightSpans: (insightId) => client.request('getInsightSpans', { id: insightId }),
        }
      },
    })
    runnerDelivery = startRunnerCloud({
      registrar,
      delegations: hostDelegations,
      owner: () => hostOrganizations.owner()?.userId ?? null,
      transcriptMirror,
      interruptSweep,
    })
    // A standing change (a share made, a policy edited) is the moment to ask for grants
    // again; a standing that shows the machine attached is recorded before the next
    // organization work is admitted (organization-vms §4).
    domainEventUnsubscribes.push(hostOrganizations.onChanged((standing) => {
      // Registered: the host's user becomes the owner's account, and its rows follow (U5).
      if (standing?.owner) void followHostAccount(getDatabase(), standing.owner)
      if (standing?.organizations.some((entry) => entry.shared)) registrar.markAttached()
      // The registration status names the account it belongs to.
      broadcastUplinkStatus()
      // The owner's client in this process presents its token again when a delegation is missing.
      localClient.standingChanged(standing?.owner?.userId ?? null)
    }))
    // Organization runs on an attached machine (organization-vms §3, §4): the host acts
    // for the person behind each turn, and its tools use the Solus API as them.
    const delivery = runnerDelivery
    turnAdmission.delegations = hostDelegations
    turnAdmission.markAttached = () => { registrar.markAttached() }
    remoteToolOperations = (sessionId) => {
      const actor = hostDelegations.actorOf(sessionId)
      if (!actor) return null
      return remoteWorkspaceOperations(hostDelegations.apiClient(actor.userId, { organizationId: actor.organizationId }), (sessionRecordId) => delivery.deliverSessionReport(sessionRecordId))
    }
  } else {
    // The Solus API reads a person's account as a host does (ADR 0001 §6.2): it exchanges
    // the API token their client presented, for the organization the request names, with
    // its service credential. A refusal ends nothing else here: the next request makes a
    // new delegation, or reads nothing.
    const credential = apiModeCredential()
    if (credential) {
      delegations = new Delegations({
        registration: () => null,
        credential: () => credential,
        onRevoked: (userId, scope, refusal) => log.info('delegation_revoked', { userId, scope: scope === 'personal' ? scope : scope.organizationId, refusal }),
      })
    } else {
      log.warn('api_account_reads_off', { reason: 'SOLUS_API_CLIENT_KEY is not set' })
    }
  }
  registerOrganizationHandlers(server, {
    hostOrganizations,
    forgetResource: (resource) => shares.forget(resource),
    events,
    registeredHostId: () => registrar.current()?.hostId ?? null,
    apiUrl: () => registrar.current()?.apiUrl ?? null,
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
    deviceHub: devices.hubProxy,
    // No pairing door on a managed host or the workspace service: a grant is the only credential there.
    pairingDisabled: credentialAlwaysRequired,
    isApiMode: apiMode,
    verifyAccessToken: verifyHostAccessToken,
    // The Solus API acts for a person only in one organization: it makes no personal delegation.
    establishDelegation: delegations ? establishWith(delegations, apiMode) : undefined,
    // Every host admits its own guests (docs/plans/host-sharing.md §4.1).
    resolveShareSecret: (secret) => shares.resolveLinkSecret(secret),
    runner: {
      ...runnerRoutes(shares),
      applyMirror: (runner, request) => applyRunnerMirror(runner, request, (sessionId) => events.broadcast('session.transcriptChanged', { sessionId }), shares),
    },
    transcribeAudio: opts.transcribeAudio,
    completeIntegrationOAuth: (params) => integrationOAuth.complete(params),
  })
  const responseReceiptBudget = new ResponseReceiptBudget()
  // Everyone who can see the resource learns of the change; a removed guest link
  // ends its sockets at once, a removed member fails on their next call (§3.4).
  domainEventUnsubscribes.push(shares.onChanged((change) => {
    // A share list changed: room members are checked again on their next event,
    // and live rooms drop or downgrade the people who lost access.
    events.forgetRoomAdmissions()
    // A mirrored session's rows follow its transcript up (host-sharing.md §2).
    if (change.resource.kind === 'session') void mirrorShareRows(change.resource)
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
      && principal.share.resource.id === change.resource.id, 'share-link-revoked')
  }))
  // A seat changes for one member; only that member's clients hear it.
  domainEventUnsubscribes.push(seats.onChanged((event) => {
    events.publish(clientsForSeat(event.seat), 'host.seatChanged', event)
    // A member's seat just connected: their profile follows them here (plans/020 §4).
    if (event.state === 'connected' && event.seat.kind === 'user' && event.seat.userId.kind === 'account') {
      const target = memberProfileTarget(event.seat.userId.accountId)
      if (target) void profiles.pullQuietly(target)
    }
  }))
  // Boot, and every few minutes after: every person with a seat here, and the owner
  // of a linked host, gets their account's profile without a client's nudge.
  domainEventUnsubscribes.push(profiles.startPeriodic(() => {
    const targets: AgentProfileTarget[] = seats.memberUserIds().map(memberProfileTarget).filter((target) => target !== null)
    if (hostOrganizations.owner()) targets.push({ kind: 'owner' })
    return targets
  }))
  domainEventUnsubscribes.push(agentAuth.onFinished((event) => {
    events.publish(clientsForSeat(event.seat), 'host.agentAuthFinished', event)
  }))
  // Seats of members who ran nothing for thirty days are removed (plan §3.7).
  const seatSweepTimer = setInterval(() => {
    if (!apiMode) seats.sweep().catch((err) => log.warn('seat_sweep_failed', { error: err instanceof Error ? err.message : String(err) }))
  }, 24 * 60 * 60_000)
  seatSweepTimer.unref()
  // Engine.IO answers `/ws` upgrades; the device hub proxy answers its own.
  http.on('upgrade', (request, socket, head) => {
    devices.hubProxy.handleUpgrade(request, socket, head)
  })
  let ws = attachWebSocketTransport(http, server, {
    clientEvents,
    browserFrames,
    verifyAccessToken: verifyHostAccessToken,
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
    },
    onClientExpired: ({ clientId }) => {
      opts.sessionRuntime.watchers.handleClientExpired(clientId)
      void browserRegistry.dropClient(clientId)
      devices.dropClient(clientId)
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
    if (principal.kind === 'runner') return
    const deviceLabel = [...ws.sessions.values()].find((session) => session.clientId === clientId)?.deviceLabel ?? 'Web'
    const joined = presence.join(clientId, principal, deviceLabel)
    // The newcomer gets the room whether or not it is new: a reconnect has lost
    // its copy. Everyone else hears only about a new face.
    const room = presence.organizationOf(clientId)
    if (joined) publishHostPresence(room)
    else if (room !== undefined) void publishPresenceRoom(presence, events, room, [clientId])
    for (const sessionId of opts.sessionRuntime.watchers.sessionsWatchedBy(clientId)) publishSessionPresence(sessionId)
  }
  function handlePresenceDisconnected(clientId: string): void {
    const room = presence.organizationOf(clientId)
    const left = presence.leave(clientId)
    if (!left) return
    publishHostPresence(room)
    const rooms = new Set(opts.sessionRuntime.watchers.sessionsWatchedBy(clientId))
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
    else if (!devices.hubProxy.handleUpgrade(request, socket, head)) socket.destroy()
  })
  // The workspace service has no tunnel and no link to resume (cloud-service-model.md §15).
  if (!apiMode) {
    tunnelPort = await bindTunnelListener(tunnelHttp, readStoredTunnel()?.proxiedPort ?? DEFAULT_TUNNEL_LISTENER_PORT)
    void registrar.resume().then((remote) => uplinkManager.resume(remote)).catch((err) => {
      log.warn('uplink_resume_failed', { error: err instanceof Error ? err.message : String(err) })
    }).finally(() => {
      runnerDelivery?.start()
      hostOrganizations.start()
      managedHostActivity.start()
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
      verifyAccessToken: verifyHostAccessToken,
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
      },
      onClientExpired: ({ clientId }) => {
        opts.sessionRuntime.watchers.handleClientExpired(clientId)
        void browserRegistry.dropClient(clientId)
        devices.dropClient(clientId)
      },
    })
    lock = acquireLock(host, actualPort)
    if (!lock) log.warn('lock_acquisition_failed_after_rebind')
    log.info('server_rebound', { host, port: actualPort, requireAuth })
  }

  // Every admitted socket may present the person's account token: renewal and `accountPresent` keep their delegation (ADR 0001 §6 item 5).
  registerAuthHandlers(server, delegations ? { verify: verifyHostAccessToken, establish: establishWith(delegations, apiMode) } : null)
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
    tunnelUrl: () => {
      const status = uplinkManager.status()
      return status.linked && status.state.observed === 'online' ? `https://${status.tunnel.hostname}` : null
    },
    mirrorOrigin: async (resource) => {
      if (resource.kind !== 'session' || !(await transcriptDestination(resource.id))) return null
      return registrar.current()?.directoryUrl ?? null
    },
    getActiveSessions: () => [...ws.sessions.values()].map(s => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      deviceId: s.deviceId,
      connectedAt: s.connectedAt,
    })),
    discoverLanServers: () => lanDiscovery.discoverServers(),
    introducedHosts,
    disconnectRemoteHost: (hostId) => remoteHosts.disconnect(hostId),
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
  registerUplinkHandlers(server, { registrar, manager: uplinkManager, status: uplinkStatus })

  log.info('server_listening', { host, port: actualPort })
  console.log(`\n  Solus web UI → http://localhost:${actualPort}\n`)

  let shutdownPromise: Promise<void> | null = null

  return {
    server,
    events,
    http,
    host,
    port: actualPort,
    localClient,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = (async () => {
        remoteHosts.close()
        stopAutomationScheduler()
        stopMetricsRollover()
        prSync.stop()
        prWatcher.stop()
        hostUpdates.stop()
        modelProfiles.stop()
        remoteUpdates.stop()
        stopSupervisor?.()
        codeIntel.dispose()
        devices.runs.dispose()
        await devices.manager.dispose()
        await devices.bridge.stop()
        for (const unsubscribe of domainEventUnsubscribes) unsubscribe()
        if (sessionIndexPollTimer) clearTimeout(sessionIndexPollTimer)
        sessionIndexPollTimer = null
        clearInterval(seatSweepTimer)
        await seatConnector.stopAll()
        await integrationGateway.close()
        agentAuth.stopAll()
        await lanDiscovery.close()
        transcriptMirror.dispose()
        hostOrganizations.stop()
        await managedHostActivity.stop()
        liveActivityRelay.stop()
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
