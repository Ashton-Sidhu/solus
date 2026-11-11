import { configureOtel } from './otel'
import { getHostConfig } from './host/settings'
import { startWorkStorage } from './sync/works/work-storage-runtime'
import { installWorkspaceToolOperations, type RemoteToolOperations } from './data/workspace/tool-context'
import { solusApiSettings } from './host/solus-api-settings'
import { createWorkspaceOperations } from './data/workspace/service'
import { refreshingSessionIndexOnList } from './transport/solus-api/session-index-refresh'
import { AccountReads, PresentedTokens, useAccountReads } from './vault/account-reads'
import { useVault, Vault } from './vault/vault'
import { ANY_ORGANIZATION, CREDENTIAL_FREE_PRINCIPAL, recordScopeOf, scopeAdmits, type Principal } from './admission/principal'
import type { ShareResource } from '@solus/contracts/sharing'
import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import { workOrganizationId } from './data/works/works'
import { transcriptDestination } from './sync/mirror/transcript-mirror'
import { appendDelivery, deliveryBacklog, dropQueuedFor, retryUnsupportedKinds } from './sync/delivery-queue'
import { RemoteUpdateService } from './updates/remote-update-service'
import type { ServerUpdateSupport, SupervisorMessage } from '@solus/contracts/server-update'
import { UpdateStatusService } from './updates/update-status-service'
import { ModelProfilesService, downloadModelProfiles } from './updates/model-profiles-service'
import { detectInstallKind } from './updates/install-kind'
import { fetchLatestRelease } from './updates/release-sources'
import { readProviderVersion } from './updates/provider-versions'
import { rmSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { createServer as createNodeHttpServer, type IncomingMessage, type Server as HttpServer } from 'http'
import { SolusServer } from './transport/server'
import { buildHttpServer } from './transport/http'
import { answerSocketRequest } from './transport/solus-api/router'
import { AccessTokenVerifier, type TokenVerdict } from './admission/access-tokens'
import { CloudflaredConnector, resolveCloudflaredBinary } from './transport/uplink/connector'
import { createHostSelfTest } from './transport/uplink/self-test'
import { readStoredTunnel, registerAndLink, splitLegacyLinkRecord, UplinkLinkManager, type WebhookDrainReason } from './transport/uplink/link'
import { HostRegistrar, readStoredRegistration } from './host/host-registration'
import { createWebhookServices } from './execution/webhooks/webhook-runtime'
import { createWebhookService } from './execution/webhooks/webhook-service'
import { onWebhookChanged, onWebhookDelivery } from './execution/webhooks/webhook-events'
import { registerWebhookHandlers } from './transport/handlers/webhook-handlers'
import { setWebhookToolServices } from './execution/agents/tools/webhook-tools'
import { takeSecretRef } from './execution/sessions/secret-requests'
import { readDelivery } from './data/webhooks/webhook-store'
import { sweepExpiredReceipts } from './data/receipts/operation-receipts'
import { mirrorWebhook, mirrorWebhookDelivery } from './sync/mirror/webhook-mirror'
import { RunnerDelivery } from './sync/runner-delivery'
import { unattendedOrganizationRefusal, type TurnOrganizationDeps } from './execution/sessions/turn-organization'
import { Delegations, type DelegationScope } from './sync/delegations'
import { remoteWorkspaceOperations } from './sync/remote-operations'
import { useOrganizationAttachment } from './host/organization-attachment'
import { applyRunnerDelivery } from './sync/runner-intake'
import { insightsEligible, useInsightsPolicy } from './sync/mirror/insight-mirror'
import { HostOrganizations } from './host/organizations'
import { HostPolicyStore, PolicyRefusedError, hostPolicies, useHostPolicyStore } from './host/policy/host-policy-store'
import { loadMachinePolicy } from './host/policy/mdm-policy'
import { removeDepartedMembers } from './host/departed-members'
import { ManagedHostActivity } from './host/managed-host-activity'
import { LiveActivityRelay } from './host/live-activity-relay'
import { activityLeases } from './execution/activity-leases'
import { adoptProvisionedRegistration, applyHostCategory, hostCategory, provisionedOrganizationId } from './host/host-category'
import { getInsightsOptIn, hostUserSettings } from './host/settings'
import { followHostAccount } from './host/host-user-rows'
import { registerOrganizationHandlers } from './transport/handlers/organization-handlers'
import { enrollHostCategorySchema, type EnrollHostCategory } from '@solus/contracts/uplink'
import { TranscriptMirror, listOwnInterruptedSessions } from './sync/mirror/transcript-mirror'
import { applyApiMode, isApiMode, apiModeConfig } from './host/api-mode'
import type { HostCredential } from './host/host-credential'
import { SOLUS_API_AUDIENCE, directoryResponseSchema, hostAudience, type HostKind, type HostRegistration } from '@solus/contracts/uplink'
import { registerUplinkHandlers } from './transport/handlers/uplink-handlers'
import { registerSharingHandlers } from './transport/handlers/sharing-handlers'
import { registerCloudUploadHandlers } from './transport/solus-api/cloud-uploads'
import { ShareManager, type ShareChange } from './sharing/share-manager'
import { GUEST_VISIT_TTL_MS } from './admission/doors'
import { profileTargetFor, registerSeatHandlers } from './transport/handlers/seat-handlers'
import { registerIntegrationHandlers } from './transport/handlers/integration-handlers'
import { registerMcpAppHandlers } from './transport/handlers/mcp-app-handlers'
import { IntegrationApps } from './integrations/mcp-apps'
import { ClaudeAppProcesses, useClaudeAppCapture } from './execution/agents/claude/claude-mcp-apps'
import { IntegrationStore } from './integrations/integration-store'
import { IntegrationCatalog } from './integrations/catalog'
import { installConnectIntegrationTool } from './integrations/connect-integration-tool'
import { createIntegration } from './integrations/integration-create'
import type { Integration } from '@solus/contracts/integration-types'
import { IntegrationGateway } from './integrations/gateway'
import { hostIntegrationClients, IntegrationConnectionStore } from './integrations/connection-store'
import { IntegrationConnections } from './integrations/connections'
import { IntegrationOAuth, type IntegrationConnectionEvents } from './integrations/oauth'
import { setIntegrationGateway } from './integrations/integration-tools'
import { AgentProfileManager, hostProfileHomes, type AgentProfileTarget } from './execution/seats/agent-profile'
import { profileIntegrations } from './integrations/profile-integrations'
import { listInstalledSkills } from './skills/skills-provider'
import { RegistrySkillCache } from './skills/registry-skill-cache'
import { publishPresenceRoom, registerPresenceHandlers } from './transport/handlers/presence-handlers'
import { PresenceManager } from './presence/presence-manager'
import { SeatManager, memberHomeDirectory, seatKey } from './execution/seats/seat-manager'
import { CodexBackend } from './execution/agents/codex/codex-backend'
import { ActingIdentities, hostSecretFilesFolder, identityFor, useActingIdentities } from './execution/seats/acting-identity'
import { actorFor, HOST_ACTOR, memberSeat, seatFor } from './admission/actor'
import { currentHostUser, hostUserKey, useHostUser } from './host/host-user'
import { MemberFolders, useMemberFolders } from './host/member-folders'
import { memberUsers as installedMemberUsers, WorkspacePreparingError } from './host/member-users'
import { useMemberSwitch } from './cli-env'
import { syncBundledPlugins } from './execution/agents/plugins'
import { setupProjectsRoot } from './workspace'
import { fetchLogin } from './providers/github/auth'
import { githubCredentials } from './providers/github/credentials'
import { withUserScope } from './vault/acting-scope'
import { solusGitHelper } from './providers/github/git-credential'
import { SeatConnector } from './execution/seats/seat-connect'
import { AgentAuthFlows } from './execution/seats/agent-auth'
import { attentionVisibleTo, eventVisibleTo } from './sharing/event-audience'
import { getDb } from './db'
import { closeDatabaseForShutdown, getDatabase } from './db/database'
import { assignSessionOrganization, markOwnRunningSessionRecordsInterrupted, onSessionRecordChanged, ownPublishedSessionIds, useSessionIndexState } from './data/sessions/session-records'
import { isLeadSession } from './data/sessions/lead-sessions'
import { sessionIndexComplete } from './db/session-indexer'
import { assertRpcAccess } from './admission/access-policy'
import { LOCAL_ORGANIZATION_ID } from './admission/principal'
import { resolveRoles, type SolusRole } from './host/roles'
import { hostOperatingSystem } from './platform/host-operating-system'
import { hostDisplayName } from './platform/host-display-name'
import { effectiveRemoteAccess, effectiveTrustLocalNetwork, getServerSettings, setRemoteAccess, setTrustLocalNetwork } from './host/settings'
import { capabilityDeniedMessage } from '@solus/contracts/policy'
import type { HostStanding } from './host/organizations'
import { isLoopbackHost, resolveEffectiveServerOptions } from './transport/bind-policy'
import { isTrustedRequesterAddress } from './transport/trusted-requesters'
import { readHostLinkEnv } from './host/host-link-env'
import { attachWebSocketTransport, isHostSocketPath } from './transport/websocket'
import { ResponseReceiptBudget } from './transport/response-receipt-cache'
import { ClientEventRegistry } from './transport/events/client-event-registry'
import { HostEventPublisher } from './transport/events/host-event-publisher'
import { BrowserFrameChannel } from './browser/browser-frame-channel'
import { configureDevices, initDeviceDomain } from './devices/device-domain'
import { runDeviceCommand } from './devices/device-process'
import { spawnHelper } from './devices/device-helpers'
import { SshDeviceHost, sshDeviceTarget } from './devices/ssh-device-host'
import { SshClient } from './platform/ssh'
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
import { advertisedRoutes, readTailscaleExitNode } from './transport/endpoints'
import { orchestrateSessions } from './execution/orchestration/orchestrate-sessions'
import { onAnnotationsChanged } from './annotations/annotation-events'
import { onWorkDeleted, onWorksChanged } from './data/works/work-events'
import { onWorkReviewsChanged } from './data/works/work-reviews'
import { registerWorkReviewHandlers } from './transport/handlers/work-review-handlers'
import { registerNotificationHubHandlers } from './transport/handlers/notification-hub-handlers'
import { publishNotificationChanges } from './notifications/hub-events'
import { publishTaskSnoozeChanges } from './transport/events/task-snooze-events'
import { PersonConnections } from './transport/events/person-connections'
import { publishSessionViewChanges } from './transport/events/session-view-events'
import { StreamedProse } from './transport/events/streamed-prose'
import { hostPrObserver } from './notifications/pr-observer'
import { registerWorkLiveHandlers } from './transport/handlers/work-live-handlers'
import { WorkLiveManager } from './work-live/work-live-manager'
import { installWorkLiveBridge } from './data/works/work-live-bridge'
import { registerConnectionsHandlers } from './transport/handlers/connections-handlers'
import { registerRemoteMachinesHandlers } from './transport/handlers/remote-machines-handlers'
import { ForwardedHosts } from './remote-machines/forwarded-hosts'
import { installPlaceFromEnv, SshProvisioner } from './remote-machines/ssh-provisioner'
import { listWslDistros, machineClient, WslClient } from './remote-machines/wsl'
import { registerAuthHandlers } from './transport/handlers/auth-handlers'
import { registerSettingsHandlers } from './transport/handlers/settings-handlers'
import { isLanDiscoveryDisabled, startLanDiscoveryService, type LanDiscoveryService } from './transport/lan-discovery'
import { registerGoogleHandlers } from './transport/handlers/google-handlers'
import { registerProviderHandlers } from './transport/handlers/provider-handlers'
import { PrSync } from './prs/pr-sync'
import { PrWatcher } from './prs/pr-watcher'
import { registerAtlassianHandlers } from './transport/handlers/atlassian-handlers'
import { setOAuthCompletedListener as setAtlassianOAuthCompletedListener } from './atlassian/oauth'
import { setConnectionConnectNeededListener } from './connections/connection-tools'
import { setConfigToolHost } from './execution/agents/tools/config-tools'
import { PersonalRequests } from './transport/events/agent-personal-requests'
import { registerBrowserHandlers } from './transport/handlers/browser-handlers'
import { registerChecksHandlers } from './transport/handlers/checks-handlers'
import { registerUsageHandlers } from './transport/handlers/usage-handlers'
import { registerHostResourceHandlers } from './transport/handlers/host-resource-handlers'
import { HostResourceReader } from './host/host-resources'
import { ResourceMonitor, resolveResourceMonitorPath } from './host/resource-monitor'
import { ResourceTelemetry } from './host/resource-telemetry'
import { registerSkillsHandlers } from './transport/handlers/skills-handlers'
import { registerPinnedSessionsHandlers } from './transport/handlers/pinned-sessions-handlers'
import { registerHostListHandlers } from './transport/handlers/host-list-handlers'
import { registerSessionReadStateHandlers } from './transport/handlers/session-read-state-handlers'
import { registerLiveActivityHandlers } from './transport/handlers/live-activity-handlers'
import { registerProjectConfigHandlers } from './transport/handlers/project-config-handlers'
import { onWorkspaceProjectsChanged } from './projects/workspace-projects'
import { onProjectsChanged } from './project-config/projects-manifest'
import { registerTasksHandlers } from './transport/handlers/tasks-handlers'
import { setVoiceModelStatusListener } from './model-downloader'
import { createLogger, isDebugEnabled } from './logger'
import { acquireLock } from './host/server-lock'
import { getInstallationId, issueSessionToken, revokeDevice } from './admission/auth'
import { hostIdentity } from './host/host-identity'
import { probeHostCapabilities, registerSetupHandlers } from './transport/handlers/setup-handlers'
import packageJson from '../../../package.json'
import { appVersion, dataDir, solusDir } from './platform/paths'
import { onTasksChanged } from './data/tasks/task-store'
import { onTaskSourcesChanged, stopTaskSourcePolling } from './data/tasks/task-sources'
import { emitSessionTasksChanged } from './data/tasks/task-sessions'
import { onSessionPullRequestsChanged } from './data/sessions/session-pull-requests'
import { emitSessionArtifactsChanged, onSessionArtifactsChanged } from './data/sessions/session-artifacts'
import { onPullRequestWatchesChanged, stopSessionPullRequestWatches } from './data/sessions/pull-request-watches'
import { onSessionReadStateChanged, onSessionStateChanged } from './data/sessions/session-states'
import { onOutboxChanged } from './sync/outbox/outbox-store'
import { registerOutboxHandlers } from './transport/handlers/outbox-handlers'
import { registerTaskOutboxApplier } from './data/tasks/task-applier'
import { registerWorkOutboxApplier } from './data/works/work-applier'
import { agentTargetFromMetadata } from './execution/agents/agent-targets'
import { registerAttachmentHandlers } from './transport/handlers/attachment-handlers'
import { registerSuggestionHandlers } from './transport/handlers/suggestion-handlers'
import { SessionSuggestions } from './sharing/session-suggestions'
import { registerAssetHandlers } from './transport/handlers/asset-handlers'
import { registerCapabilityHandlers } from './transport/handlers/capability-handlers'
import { registerObservabilityHandlers } from './transport/handlers/observability-handlers'
import { InsightPull } from './sync/insight-pull'
import { startMetricsRollover, stopMetricsRollover } from './data/insights/rollover'
import { onTurnRowWritten } from './data/insights/span-table'
import { projectSessionEvent, serializedBytes } from './data/sessions/result-projection'
import { activityFor } from './data/activity/activity'
import { WorktreeMover } from './execution/sessions/worktree-move'
import { markAwaitedTasks } from './execution/sessions/background-work'
import { WorktreeOffers } from './execution/sessions/worktree-offers'
import { setProjectToolHost } from './execution/agents/tools/project-tools'
import { setWorktreeMover } from './execution/agents/tools/worktree-tools'
import { installToolAccess } from './admission/workspace-tool-authority'

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

const systemErrorSchema = z.object({ code: z.string().optional() })

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
  return registration ? new AccessTokenVerifier({ issuer: registration.issuer, jwksUrl: registration.jwksUrl, audience: hostAudience(registration.hostId) }) : null
}

/** The Solus API's one verifier: the account plane's issuer, for `SOLUS_API_AUDIENCE`; null on a host, whose verifier follows its registration. */
function workspaceTokenVerifier(apiMode: boolean): AccessTokenVerifier | null {
  return apiMode ? new AccessTokenVerifier({ ...apiModeConfig(), audience: SOLUS_API_AUDIENCE }) : null
}

/**
 * What a host does for its organization's Solus API once it is registered
 * (cloud-service-model.md §4–§6, §16; plans/010-standard-oauth.md): the delivery of
 * its queue, each row with the delegated token of the person whose work it is, its
 * session records once at boot, and the mirror of turns its previous process left
 * unsettled. Those rows wait in the queue until their person's token can carry them.
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
  // Every own organization session's record goes once at boot, the sweep's `interrupted` among them.
  void deps.interruptSweep.then(ownPublishedSessionIds).then((sessionIds) => delivery.reportStoredSessions(sessionIds)).catch((error) => {
    log.warn('session_records_boot_report_failed', { error: String(error) })
  })
  void deps.interruptSweep.then(listOwnInterruptedSessions).then((sessions) => {
    for (const session of sessions) deps.transcriptMirror.touch(session.sessionId, session)
  }).catch((error) => {
    log.warn('transcript_mirror_interrupted_sweep_failed', { error: String(error) })
  })
  return delivery
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
  // The machine's MDM policy is read before anything listens; one this host cannot enforce stops the boot (plans/030 §5.1).
  let standingSource: () => HostStanding | null = () => null
  const policyStore = new HostPolicyStore({ mdm: await loadMachinePolicy(), standing: () => standingSource() })
  useHostPolicyStore(policyStore)
  const remoteBindOptions = () => {
    const rule = hostPolicies().hostSetting('remoteAccess')
    return rule?.value === false
      ? { remoteAllowed: false, refusal: capabilityDeniedMessage(rule.source, 'remote access').replace(/\.$/, '') }
      : {}
  }
  const initial = resolveEffectiveServerOptions({ host: opts.host, requireAuth: opts.requireAuth, remoteAccess: effectiveRemoteAccess(), ...remoteBindOptions() })
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
  const shares = new ShareManager({
    db: getDatabase(),
    sessionExists: (sessionId) => opts.sessionRuntime.isKnownSession(sessionId),
    // Only a session on this host moves from Local here; a Local work moves by its upload to the Solus API.
    assignOrganization: async (resource, organizationId) => {
      switch (resource.kind) {
        case 'session': return (await assignSessionOrganization(resource.id, organizationId))?.organizationId ?? null
        case 'work': return workOrganizationId(resource.id)
      }
    },
    // A member reaches this host with a host access token, which needs the registration (host-sharing.md §4.3), never the link.
    membersReachable: () => apiMode || registrar.current() !== null,
  })
  // An agent tool reads a record only when the turn's person may open it (plans/031 item 7).
  installToolAccess((principal, resource) => shares.roleFor(principal, resource))
  server.useResourceAccess(shares)
  /** The host's share rows for a mirrored session, appended for its organization; nothing for a session nobody mirrors. */
  const mirrorShareRows = async (resource: ShareResource): Promise<void> => {
    const destination = await transcriptDestination(resource.id)
    if (!destination) return
    appendDelivery(destination, 'shares', [{ key: `${resource.kind}:${resource.id}`, payload: { resource, rows: await shares.mirroredRows(resource) } }])
  }
  const workspaceOperations = createWorkspaceOperations(shares)
  // An organization run's tools read and write its Solus API (organization-vms §3), once the link and its run authorities exist below.
  let remoteToolOperations: RemoteToolOperations | undefined
  const stopWorkspaceToolOperations = installWorkspaceToolOperations(workspaceOperations, apiSettings.serviceId, (run) => remoteToolOperations?.(run) ?? null)
  // This host's standing in its organizations (organization-scope §3.1, §6.1): the
  // control plane's answer, asked for once the link is known below. Its policies and
  // the machine's MDM policy are read only through the host policy store (plans/030 §6.1).
  useSessionIndexState(sessionIndexComplete)
  const hostOrganizationsDeps: { registration: () => HostRegistration | null; credential: () => HostCredential | null; registrationRefused: () => void } = { registration: () => null, credential: () => null, registrationRefused: () => {} }
  const hostOrganizations = new HostOrganizations({
    registration: () => hostOrganizationsDeps.registration(),
    credential: () => hostOrganizationsDeps.credential(),
    onRegistrationRefused: () => hostOrganizationsDeps.registrationRefused(),
    cachePath: join(solusDir(), 'organization-standing.json'),
  })
  standingSource = () => hostOrganizations.current()
  policyStore.standingChanged()
  hostOrganizations.onChanged(() => policyStore.standingChanged())
  useInsightsPolicy({
    syncAllInsights: (organizationId) => hostPolicies().forWork(organizationId).syncsAllInsights(),
    optedIn: (organizationId) => getInsightsOptIn().includes(organizationId),
    attached: (organizationId) => hostOrganizations.organization(organizationId)?.shared === true,
  })
  // Provider seats (Step 2 plan): every turn runs on its author's own login.
  // The workspace service
  // VAULT_NOT_CONFIGURED to every seat call.
  const seats = new SeatManager({ db: getDb() })
  // On a managed host each member runs as their own Linux user, which the host
  // object makes and lists in the users file (docs/plans/member-isolation.md §4);
  // boot-core read it.
  const memberUsers = installedMemberUsers()
  // A member with no user yet starts nothing: never as the server's own user.
  const memberUserOf = (seat: Parameters<typeof seatKey>[0]) => {
    const user = memberUsers?.userOf(seatKey(seat))
    if (!user) throw new WorkspacePreparingError()
    return user
  }
  // Who every process acts as (plans/019-acting-identity.md): a member's run in
  // their own home, with their own GitHub connection.
  const identities = new ActingIdentities({
    memberToken: () => githubCredentials().accountToken(),
    fetchLogin: async (accessToken) => (await fetchLogin(accessToken)).login,
    // Where each member is their own user, the users file names their home (kept) and their secrets folder (memory).
    memberHome: (seat) => memberUsers ? memberUserOf(seat).home : memberHomeDirectory(seats.seatsRoot, seat),
    memberSecrets: memberUsers ? (seat) => memberUserOf(seat).secrets : undefined,
    gitHelper: () => solusGitHelper(['--member-home']),
    memberUser: memberUsers ? (seat) => ({ uid: memberUserOf(seat).uid }) : undefined,
    now: Date.now,
  })
  useActingIdentities(identities)
  // The credential files the previous design kept per process; nothing reads them now.
  rmSync(join(dataDir(), 'git-credentials'), { recursive: true, force: true })
  // The secret files request_secret saved for the last process's runs: no timer of this process removes them.
  rmSync(hostSecretFilesFolder(), { recursive: true, force: true })
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
  // WORKAROUND(openai/codex#54472): Codex history is read through the seat that last ran the thread.
  // A host built without Codex (the Lab's and the e2e suite's mock registry) has no reader to give seats.
  const codexBackend = opts.sessionRuntime.getBackendIds().includes('codex') ? opts.sessionRuntime.backendFor('codex') : null
  if (codexBackend instanceof CodexBackend) codexBackend.useReaderSeats(seats)
  const seatConnector = new SeatConnector({ seats })
  const agentAuth = new AgentAuthFlows({ seats })
  // A client with no socket principal is the desktop's own IPC connection: the
  // local owner, who still does not hear another person's personal events.
  const clientEvents = new ClientEventRegistry((clientId, event) =>
    eventVisibleTo(ws?.principalOf(clientId) ?? CREDENTIAL_FREE_PRINCIPAL, event, shares))
  const events = new HostEventPublisher(clientEvents)
  // Works people edit live (work review plan, phase 3b): a room per open work;
  // its updates go to that room only, never to everyone with access.
  const workLive = new WorkLiveManager({ publish: (clientIds, type, payload) => { void events.publishToRoom({ kind: 'work', id: payload.workId }, clientIds, type, payload) } })
  const workStorageRuntime = await startWorkStorage({ database: getDatabase, cloud: apiMode, flushLive: workId => workLive.flushPersisted(workId) })
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
  const ssh = new SshClient({ run: runDeviceCommand, spawn: spawnHelper })
  // Machines added over SSH, and the forwards to the ones with no account (docs/plans/host-routes.md D6, D7).
  // A WSL distro of this Windows host is added the same way, through `wsl.exe` (docs/plans/windows.md §13.6).
  const machines = machineClient(ssh, new WslClient({ run: runDeviceCommand, spawn: spawnHelper }))
  const installPlace = installPlaceFromEnv(process.env.SOLUS_SSH_INSTALL_PLACE)
  const sshProvisioner = new SshProvisioner(machines, installPlace)
  // A distro gets the release of this host's own version, so the two never skew.
  const wslProvisioner = new SshProvisioner(machines, { ...installPlace, version: installPlace.version ?? appVersion() })
  const forwardedHosts = new ForwardedHosts({
    ssh: machines,
    selfInstallationId: getInstallationId,
    remotePort: (target, authSecret) => sshProvisioner.remotePort(target, authSecret),
    onChange: (hosts) => events.broadcast('host.forwardedHostsChanged', { hosts }),
  })
  forwardedHosts.start()
  const devices = initDeviceDomain({
    publish: (state) => events.broadcast('device.stateChanged', { state }),
    surfaceRequested: (payload) => events.broadcast('device.surfaceRequested', payload),
    makeSshHost: (config) => new SshDeviceHost(config, { run: runDeviceCommand, spawn: spawnHelper }),
    isLocalSshTarget: (config) => ssh.resolvesToThisMachine(sshDeviceTarget(config)),
  })
  void devices.manager.start().catch((err) => log.warn('device_domain_start_failed', { error: err instanceof Error ? err.message : String(err) }))
  const codeIntel = new CodeIntelManager()
  // A client with no socket principal is the desktop's own IPC connection: the local owner.
  const personConnections = new PersonConnections(() => clientEvents.routableClientIds(), (clientId) => ws?.principalOf(clientId) ?? CREDENTIAL_FREE_PRINCIPAL)
  const domainEventUnsubscribes = [
    codeIntel.onStatusChanged((status) => events.broadcast('codeIntel.statusChanged', status)),
    onAutomationsChanged((event) => events.broadcast('automation.changed', event)),
    onWebhookChanged((event) => events.broadcast('webhook.changed', event)),
    onWebhookDelivery((delivery) => events.broadcast('webhook.delivery', delivery)),
    onAnnotationsChanged((change) => events.broadcast('annotations.changed', change)),
    onWorksChanged((change) => events.broadcast('works.changed', change)),
    onWorkDeleted((change) => events.prepareBroadcast('works.changed', change)),
    onWorkReviewsChanged((change) => events.broadcast('workReviews.changed', change)),
    // A client with no socket principal is the desktop's own IPC connection: the local owner.
    publishNotificationChanges(events, () => clientEvents.routableClientIds(), (clientId) => ws?.principalOf(clientId) ?? CREDENTIAL_FREE_PRINCIPAL),
    publishTaskSnoozeChanges(events, personConnections),
    publishSessionViewChanges(events, personConnections),
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
    // The end of a source read: a client reads the state of its sources again.
    onTaskSourcesChanged((sourceKeys) => { void events.broadcast('tasks.sourcesChanged', { sourceKeys }) }),
    // `registerTasksHandlers` starts the timer that keeps the wanted sources fresh.
    stopTaskSourcePolling,
    // A task reads the pull requests of its sessions, so a session's change is
    // also a change of each task the session belongs to.
    onSessionStateChanged((sessionId, state) => events.broadcast('session.stateChanged', { sessionId, state })),
    // A read boundary is the reader's own: only their connections hear it move.
    onSessionReadStateChanged((change) => {
      const recipients = personConnections.of(change.personKey, change.organizationId)
      if (recipients.length) void events.publish(recipients, 'session.readStateChanged', { sessionId: change.sessionId, viewedAt: change.viewedAt })
    }),
    // A link carries whether it is watched (docs/plans/pr-watch.md).
    onPullRequestWatchesChanged((sessionId) => {
      events.broadcast('session.pullRequestsChanged', { sessionId })
      void emitSessionArtifactsChanged(sessionId)
    }),
    onSessionPullRequestsChanged((sessionId) => {
      events.broadcast('session.pullRequestsChanged', { sessionId })
      // A session's artifacts list its pull requests (docs/plans/session-artifacts.md).
      void emitSessionArtifactsChanged(sessionId)
      void emitSessionTasksChanged(ANY_ORGANIZATION, sessionId).catch((error) => {
        log.warn('session_pull_request_tasks_notify_failed', { sessionId, error: String(error) })
      })
    }),
    onSessionArtifactsChanged((sessionId) => events.broadcast('session.artifactsChanged', { sessionId })),
    onWorkspaceProjectsChanged(() => events.broadcast('workspaceProjects.changed', {})),
    onProjectsChanged(() => events.broadcast('projects.changed', {})),
    onTurnRowWritten((change) => events.broadcast('metrics.turnsChanged', change)),
    onOutboxChanged(() => events.broadcast('outbox.changed', {})),
  ]
  // A pull request changed on the code host announces nothing to Solus, so PR
  // sync asks on the workspace's behalf and turns what it finds into the same
  // event an in-Solus write sends (docs/plans/pr-sync.md).
  // Pull request assignments and review requests reach the host user's hub from
  // every needs-review answer the server reads: a list read's review-requested
  // search, or PR sync's read for the sidebar count. No poller asks the code host.
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
  // A lead's reports wait until its last open message settles (docs/plans/lead-session.md).
  const orchestrator = orchestrateSessions(opts.sessionRuntime, isLeadSession)
  // Every turn and every new session, from a client or an agent, passes one admission
  // (`PromptDispatch.admitTurn`). The delegations join it once the link exists.
  const turnAdmission: TurnOrganizationDeps = {
    hostOrganizations,
    adoptSession: (sessionId, organizationId, ownerKey, options) => shares.adoptForOrganization({ kind: 'session', id: sessionId }, organizationId, ownerKey, options),
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
    onProviderInstancesChanged: () => events.broadcast('provider-instances.changed', {}),
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
  registerWorktreeHandlers(server, { sessionRuntime: opts.sessionRuntime, events, worktreeMover, worktreeOffers, prSync })
  registerGitPublishHandlers(server)
  // Browsing a host's filesystem must work headless — that is the whole point
  // of pairing a server that has no window.
  registerFilesystemHandlers(server)
  registerCodeIntelHandlers(server, { codeIntel })
  registerAttachmentHandlers(server)
  // What a guest who may only propose sends a session waits here for someone who may prompt it.
  const linkExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const suggestions = new SessionSuggestions({ onChanged: (sessionId) => events.broadcast('session.suggestionsChanged', { sessionId }) })
  registerSuggestionHandlers(server, { suggestions, shares })
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
  // Integrations (docs/plans/mcp-integrations.md): a run lists its person's tools
  // when it starts (`integrationAgentTools`), so nothing is listed at boot.
  const integrations = new IntegrationStore()
  const integrationGateway = new IntegrationGateway(integrations)
  const claudeAppProcesses = new ClaudeAppProcesses()
  const integrationApps = new IntegrationApps(integrationGateway, opts.sessionRuntime, claudeAppProcesses)
  integrationGateway.useAppCapture((call) => integrationApps.capture(call))
  useClaudeAppCapture((sessionId, app) => integrationApps.captureClaude(sessionId, app))
  registerMcpAppHandlers(server, integrationApps)
  setIntegrationGateway(integrationGateway)
  integrationGateway.onToolsChanged((integrationId) => { void events.broadcast('integration.changed', { integrationId, change: 'tools' }) })
  integrationGateway.onConnectNeeded((request) => { void events.broadcast('integration.connectNeeded', request) })
  integrationGateway.onCustomServerNeeded((request) => { void events.broadcast('integration.customServerNeeded', request) })
  // A connection is one person's (§4.1): its events go to that person's clients.
  const integrationConnectionEvents: IntegrationConnectionEvents = {
    connectionChanged: (personKey, event) => {
      // A sign-in or a disconnect changes the header a session must send, and the tools it sees.
      integrationGateway.invalidate(event.integrationId)
      if (event.connection?.status === 'connected') void integrationGateway.warmFor(event.integrationId, personKey)
      void events.publish(personConnections.of(personKey), 'integration.connectionChanged', event)
    },
    authFinished: (personKey, event) => { void events.publish(personConnections.of(personKey), 'host.integrationAuthFinished', event) },
  }
  const integrationConnectionStore = new IntegrationConnectionStore()
  // Every read of a person's account (docs/adr/0001-standard-authentication.md §3.4):
  // a host reads with its delegated token for the person; the Solus API with the
  // person's own token, which their client presented and whose `aud` includes the
  // account plane (docs/plans/simplify-auth-and-sync.md §3 rule 1). A person's connection
  // may live in their account (plans/020 §5): it is read per call, and nothing else is held.
  const presentedTokens = apiMode ? new PresentedTokens() : null
  const accountReadsOfServer = new AccountReads({
    origin: () => apiMode ? apiModeConfig().issuer : hostOrganizationsDeps.registration()?.directoryUrl ?? null,
    delegations: () => delegations,
    ownToken: (userId) => presentedTokens?.tokenFor(userId) ?? null,
  })
  useAccountReads(accountReadsOfServer)
  // The one place a person's credentials are kept and read (docs/plans/access-model.md §2.6).
  const credentialVault = new Vault({ reads: accountReadsOfServer })
  useVault(credentialVault)
  const integrationOAuth = new IntegrationOAuth({ connections: integrationConnectionStore, integrations, vault: credentialVault, clients: hostIntegrationClients, events: integrationConnectionEvents })
  const integrationConnections = new IntegrationConnections({
    store: integrationConnectionStore, integrations, vault: credentialVault, clients: hostIntegrationClients, oauth: integrationOAuth, events: integrationConnectionEvents,
    // The Solus GitHub app's token, read as the person, is GitHub's MCP server's credential (§13.1).
    firstPartyCredential: async (_client, personKey) => {
      const token = await withUserScope(personKey, () => githubCredentials().accountToken())
      return token ? { token: token.accessToken, label: token.login ?? null } : null
    },
  })
  integrationGateway.useCredentials(integrationConnections)
  // The agent profile (plans/020-agent-profile.md): one owner applies a person's
  // files, registry skills, and MCP servers to their seats, or to the host's own
  // homes on a host they own; a pull reads it from their account.
  // Registry skills are downloaded once per host and written into each person's homes as files.
  const registrySkills = new RegistrySkillCache(join(dataDir(), 'registry-skills'))
  const profileSeat = (target: AgentProfileTarget): Seat => target.kind === 'owner' ? HOST_LOGIN_SEAT : memberSeat(target.userId, target.name)
  const profiles = new AgentProfileManager({
    sourceHomes: hostProfileHomes,
    // Where the person's agent reads: a member who is their own Linux user runs with
    // the CLI's own `~/.claude` and `~/.codex` in their home; elsewhere the seat folder.
    homeFor: (target, provider) => {
      const seat = profileSeat(target)
      if (memberUsers && seat.kind === 'user') return join(memberUserOf(seat).home, provider === 'claude-code' ? '.claude' : '.codex')
      return seats.homeFor(seat, provider)
    },
    processUserFor: (target) => identityFor(profileSeat(target)).processUser(),
    now: Date.now,
    skills: { list: () => listInstalledSkills(), files: (entry) => registrySkills.files(`${entry.source}@${entry.skillId}`, entry.name) },
    integrations: profileIntegrations({ store: integrations, gateway: integrationGateway, connections: integrationConnections, events }),
    integrationOwnerFor: (target) => target.kind === 'member'
      ? { organizationId: target.organizationId, ownerKey: target.userId }
      : { organizationId: provisionedOrganizationId() ?? LOCAL_ORGANIZATION_ID, ownerKey: hostUserKey() },
    account: {
      reads: accountReadsOfServer,
      userFor: (target) => target.kind === 'member' ? target.userId : hostOrganizations.owner()?.userId ?? null,
      reconcile: (owner, cloudConnections) => integrationConnections.reconcile(owner, cloudConnections).then(() => undefined),
    },
  })
  registerSeatHandlers(server, { seats, connector: seatConnector, profiles, agentAuth, providerInstancesChanged: () => events.broadcast('provider-instances.changed', {}) })
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
  const integrationCatalog = new IntegrationCatalog()
  const integrationProfile = {
    saved: async (principal: Principal, integration: Integration) => {
      const target = profileTargetFor(principal)
      if (target) await profiles.integrationSaved(target, integration).catch((error) => log.warn('agent_profile_publish_failed', { error: error instanceof Error ? error.message : String(error) }))
    },
    removing: async (principal: Principal, integration: Integration) => {
      const target = profileTargetFor(principal)
      if (target) await profiles.integrationRemoving(target, integration)
    },
  }
  // The agent adds and connects a service from the same catalog and create path as Settings (§13.2).
  installConnectIntegrationTool({
    catalog: integrationCatalog,
    create: (principal, owner, request) => createIntegration({ store: integrations, events, profile: integrationProfile }, principal, owner, request),
  })
  registerIntegrationHandlers(server, {
    store: integrations,
    catalog: integrationCatalog,
    gateway: integrationGateway,
    events,
    connectionStore: integrationConnectionStore,
    connections: integrationConnections,
    oauth: integrationOAuth,
    clients: hostIntegrationClients,
    getServerInfo: () => ({ host, port: actualPort }),
    profile: integrationProfile,
  })
  registerPresenceHandlers(server, { presence, onHostChanged: (clientId) => publishHostPresence(presence.organizationOf(clientId)), onSessionChanged: publishSessionPresence })
  const guides = new ReviewGuideJobs((event) => publishGuideStatus(events, event), { pr: prGuideSource, local: localGuideSource })
  registerReviewHandlers(server, opts.sessionRuntime, events, guides)
  registerAutomationHandlers(server)
  // Isolated automations use the same headless SessionRuntime lifecycle as normal
  // background sessions, so their live transcript can be opened mid-run.
  setAutomationBackgroundSessionDispatcher(({ automationId, automationName, runId, ...o }) => opts.sessionRuntime.dispatch.startUnattendedSession({ ...o, startedBy: { kind: 'automation', automationId, runId }, automationName }))
  setAutomationWorktreeCreator((prompt, cwd, abortSignal, preferences, organizationId) => (
    opts.sessionRuntime.checkouts.createNamed(cwd, prompt, opts.sessionRuntime, abortSignal, preferences, organizationId)
  ))
  // Push every automation mutation (saves, deletes, run transitions — incl.
  // background scheduler fires) to all connected clients so the UI stays live.
  setSessionOrchestration(orchestrator)
  const introducedHosts = new IntroducedHosts(fetch, Date.now, {
    installationId: getInstallationId,
    name: hostDisplayName,
    // The introduced host keeps the first one that answers as this host.
    urls: async () => (await advertisedRoutes(host, actualPort)).map((route) => route.url),
    issueToken: issueSessionToken,
    revokeDevice,
    identityKey: () => hostIdentity().publicKey(),
  })
  // An account client in this process (the desktop) presents its token here; the host acts from what it presents.
  const localClient = new LocalClientDoor({
    hostId: () => registrar.current()?.hostId ?? null,
    needsRegistration: () => !apiMode && registrar.needsRegistration(),
    register: (request) => registerAndLink(registrar, uplinkManager, request),
    verify: (token) => verifyHostAccessToken(token),
    delegations: () => apiMode ? null : delegations,
    organizationIds: () => hostOrganizations.organizations().map((entry) => entry.organizationId),
    onEstablished: () => runnerDelivery?.retryWaiting(),
    // The signed-in account is the host's user; signed out, the local user is (ADR 0001 rule 8).
    onOwnerIdentity: (owner) => { if (!apiMode) void followHostAccount(getDatabase(), owner) },
  })
  // A registered host that is not linked is reached on the local network (ADR 0001 §2.2 rule 9).
  // Account reach (docs/plans/host-reach.md §3): the person's directory, and an
  // one-hour token for one other host, both with this host's delegation for them.
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
          return await held.accessToken(actor.userId, actor.scope, { kind: 'host', hostId })
        } catch (error) {
          log.info('host_reach_token_unavailable', { hostId, error: error instanceof Error ? error.message : String(error) })
          return null
        }
      },
    }
  }
  const remoteHosts = new RemoteHosts(accountReach, introducedHosts, () => registrar.current()?.hostId ?? null, () => lanDiscovery.discoverServers(), getInstallationId, forwardedHosts)
  setRemoteHosts(remoteHosts)
  setSessionController({
    permissionModeFor: (sessionId) => opts.sessionRuntime.activeSessions.get(sessionId)?.runInput?.permissionMode ?? opts.sessionRuntime.sessionPermissionModes.get(sessionId),
    // A turn reaches other hosts for its own person (host-reach.md §3.2): the owner through
    // their personal delegation and the introduced hosts; a member only through the
    // organization they work in here; anyone else not at all.
    reachRequestFor: (sessionId): ReachRequest | null => {
      const actor = opts.sessionRuntime.activeRunRequests.get(sessionId)?.actor
      const principal = actor?.principal
      if (!actor?.user || principal?.kind === 'owner') {
        const owner = delegations?.holders().find((holder) => holder.scope === 'personal')
        return { account: owner ? { userId: owner.userId, scope: 'personal' } : null, isOwner: true }
      }
      if (principal?.kind === 'org-member') return { account: { userId: principal.userId, scope: { organizationId: principal.organizationId } }, isOwner: false }
      return null
    },
    // The same people and scopes read their organizations' Solus APIs: the owner every
    // organization this host holds a delegation for, a member only their own.
    organizationApisFor: (sessionId) => {
      const actor = opts.sessionRuntime.activeRunRequests.get(sessionId)?.actor
      const principal = actor?.principal
      const owner = !actor?.user || principal?.kind === 'owner'
      const ownerId = owner ? delegations?.holders().find((holder) => holder.scope === 'personal')?.userId : undefined
      return (delegations?.holders() ?? []).flatMap((holder) => {
        if (holder.scope === 'personal') return []
        const reads = owner
          ? holder.userId === ownerId
          : principal?.kind === 'org-member' && holder.userId === principal.userId && holder.scope.organizationId === principal.organizationId
        return reads ? [{ organizationId: holder.scope.organizationId, client: delegations!.apiClient(holder.userId, holder.scope) }] : []
      })
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
    awaitBackgroundTasks: (sessionId, taskIds, waiting) => {
      const session = opts.sessionRuntime.activeSessions.get(sessionId)
      return session ? markAwaitedTasks(session, taskIds, waiting, opts.sessionRuntime.backendFor(session.backendId)) : null
    },
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
  server.register('continueSetupLocally', async (args) => {
    const [sessionId] = args
    if (!sessionId.trim()) throw new Error('continueSetupLocally requires a session id')
    return opts.sessionRuntime.launcher.continueSetupLocally(sessionId)
  })
  // Local, in-process automation scheduler. Fires time-based triggers while the
  // app is open and catches up missed fires on launch (local-only by design).
  startMetricsRollover(() => getServerSettings().metricsRetentionDays)
  // Set below once this host can act for its owner at the Solus API.
  let insightPull: InsightPull | null = null
  registerObservabilityHandlers(server, { sessionRuntime: opts.sessionRuntime, insightPull: () => insightPull })
  registerProjectConfigHandlers(server)
  registerTasksHandlers(server)
  registerOutboxHandlers(server)
  // Any host can own tasks (and their works), so the owner-side appliers
  // register unconditionally.
  registerTaskOutboxApplier()
  registerWorkOutboxApplier()
  registerGoogleHandlers(server, { getServerInfo: () => ({ host, port: actualPort }) })
  registerAtlassianHandlers(server)
  setAtlassianOAuthCompletedListener((event) => events.broadcast('atlassian.oauthCompleted', event))
  setConnectionConnectNeededListener((request) => events.broadcast('connection.connectNeeded', request))
  // A config write from an agent tool converges every mounted client the same
  // way one made in Settings does. Personal settings and the agent profile live
  // on the person's clients, so the tools ask one of them (docs/settings.md).
  const personalRequests = new PersonalRequests(personConnections, {
    sourceClientIdOf: (id) => opts.sessionRuntime.activeRunRequests.get(id)?.sourceClientId,
    actorOf: (id) => opts.sessionRuntime.actorOfSession(id),
  }, (clientId, event, payload, answer, timeoutMs) => ws.request(clientId, event, payload, answer, timeoutMs))
  setConfigToolHost({
    hostConfigChanged: (snapshot) => events.broadcast('config.changed', snapshot),
    deviceManager: {
      settings: () => devices.manager.settings(),
      configure: (request) => configureDevices(devices, request),
      saveSshHosts: (hosts) => devices.manager.saveSshHosts(hosts),
    },
    personal: (sessionId, request) => personalRequests.send(sessionId, request),
  })
  registerProviderHandlers(server, {
    checkouts: opts.sessionRuntime.checkouts,
    dispatcher: opts.sessionRuntime,
    events,
    isWorktreeInUse: (path) => opts.sessionRuntime.sessionCheckouts.listGitContexts().some((context) => context.worktreePath === path),
    isSessionBusy: (sessionId) => opts.sessionRuntime.statuses.isSessionBusy(sessionId),
    prSync,
    guides,
    resources: shares,
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
  const resourceTelemetry = new ResourceTelemetry({
    resolvePath: resolveResourceMonitorPath,
    createMonitor: (options) => new ResourceMonitor(options),
    publish: (clientIds, event) => { events.publish(clientIds, 'host.telemetry', event) },
    rootPid: process.pid,
    now: Date.now,
  })
  registerHostResourceHandlers(server, { reader: new HostResourceReader(), telemetry: resourceTelemetry })
  registerSkillsHandlers(server, { sessionRuntime: opts.sessionRuntime, seats })
  registerPinnedSessionsHandlers(server)
  registerHostListHandlers(server, { broadcast: (topic, payload) => events.broadcast(topic, payload) })
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
  // A policy with `updates.mode: off` manages this host's updates (plans/030 §6.8).
  const assertUpdatesAllowed = () => {
    const rule = hostPolicies().hostSetting('updates')
    if (rule?.value.mode === 'off') throw new PolicyRefusedError('UPDATES_MANAGED', `${rule.source.document.organization.name} manages Solus updates.`)
  }
  server.register('hostInstallUpdate', () => { assertUpdatesAllowed(); remoteUpdates.install(); return structuredClone(hostUpdates.status) })
  server.register('hostCancelUpdate', () => { remoteUpdates.cancel(); return structuredClone(hostUpdates.status) })
  server.register('hostUpdateStatus', () => structuredClone(hostUpdates.status))
  server.register('hostCheckForUpdates', () => { assertUpdatesAllowed(); return hostUpdates.check() })
  hostUpdates.start()
  const modelProfiles = new ModelProfilesService({
    cachePath: join(solusDir(), 'model-profiles.json'),
    download: downloadModelProfiles,
    publish: (status) => { events.broadcast('host.modelProfilesChanged', status) },
  })
  if (opts.sessionRuntime.getBackendIds().includes('claude-code')) {
    opts.sessionRuntime.backendFor('claude-code').on('models-reported', () => { events.broadcast('host.modelProfilesChanged', modelProfiles.status) })
  }
  server.register('modelProfilesStatus', () => modelProfiles.status)
  server.register('modelProfilesRefresh', () => modelProfiles.refresh())
  modelProfiles.start()
  const setup = registerSetupHandlers(server, { events, checkouts: opts.sessionRuntime.checkouts,
    assertNewWorkAllowed: () => opts.sessionRuntime.assertNewWorkAllowed(),
    onActiveStepsChanged: (count) => { activeSetupSteps = count },
    onProviderInstalled: (agent) => hostUpdates.providerInstalled(agent),
    seats,
  })
  setProjectToolHost({
    create: (request, caller) => server.handle('setupCreateProject', [request], caller),
    clone: (request, caller) => server.handle('setupCloneProject', [request], caller),
  })
  // A Run on prompt copies its repository before its run starts (docs/run-on.md).
  opts.sessionRuntime.launcher.prepareDispatchCheckout = setup.prepareDispatchCheckout
  opts.sessionRuntime.launcher.dispatchCheckoutPathOf = setup.dispatchCheckoutPathOf
  registerDeviceHandlers(server, {
    domain: devices,
    testSshHost: async (config) => (await ssh.resolvesToThisMachine(sshDeviceTarget(config))
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
  const streamedProse = new StreamedProse()
  opts.sessionRuntime.on('event', (sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }) => {
    // A broadcast event is a change to the session's history; one aimed at a single client is not.
    if (!to) touchTranscript(sessionId)
    const wireEvent = projectSessionEvent(event)
    if (!wireEvent) return
    let clients = opts.sessionRuntime.watchers.clientsWatching(sessionId)
    if (to?.only) clients = clients.filter((clientId) => clientId === to.only)
    if (to?.except) clients = clients.filter((clientId) => clientId !== to.except)
    const projectedEvent = streamedProse.project(sessionId, wireEvent, clients, !to)
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
    // A turn that ended may have pushed a branch or opened a pull request (docs/plans/pr-sync.md §3.4).
    if (event.status === 'completed' || event.status === 'background' || event.status === 'failed' || event.status === 'interrupted') {
      void prSync.turnEnded(event.sessionId).catch((error) => log.warn('pr_sync_turn_end_failed', { sessionId: event.sessionId, error: String(error) }))
    }
  })
  // A message-mode question was asked or settled: the status is unchanged, so
  // nothing a turn's end does runs again. Only readers of the feed learn of it.
  opts.sessionRuntime.on('session-question', (event: HostEventMap['session.statusChanged']) => {
    events.broadcast('session.statusChanged', event)
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
    // The registration ended (removed from the account, or superseded): the host is linked to
    // nobody, so its user is local again and it keeps nothing of theirs (docs/plans/cloud-vault.md §2.5).
    if (!registration) void followHostAccount(getDatabase(), null)
    runnerDelivery?.registrationChanged()
    hostOrganizations.registrationChanged()
    // A tunnel belongs to the registration it was made for.
    uplinkManager?.registrationChanged(registration)
    // The owner's client in this process presents a token for the new registration, or registers the host again.
    localClient.registrationChanged()
  }
  // What `uplinkStatus` answers: the registration, and apart from it, the link.
  /** Set once the webhook services exist; an online link before then asks again through the next online. */
  let drainWebhooks: (reason: WebhookDrainReason) => void = () => {}
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
    onOnline: (reason) => drainWebhooks(reason),
  })
  followRegistration(registrar.current())
  // The attachment is stored with the registration (organization-vms §4): a deleted host is personal again.
  useOrganizationAttachment(() => registrar.attachedAt())
  // A registered host shared with an organization delivers its cloud-owned writes and
  // its session records to the organization's workspace service (§16).
  hostOrganizationsDeps.registration = () => registrar.current()
  hostOrganizationsDeps.credential = () => registrar.credential()
  hostOrganizationsDeps.registrationRefused = () => { void registrar.check() }
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
    savePath: join(dataDir(), 'live-activities.json'),
  })
  registerLiveActivityHandlers(server, liveActivityRelay)
  opts.sessionRuntime.on('session-status', (event: HostEventMap['session.statusChanged']) => liveActivityRelay.sessionStatusChanged(event))
  if (!apiMode) {
    // The host's user (plans/012 §1): its `local` id is minted once, before any
    // client connects. The Solus API has no host user.
    useHostUser(hostUserSettings())
    // How this host acts for people (docs/adr/0001-standard-authentication.md §3.4): a
    // refused token means the person may no longer work here in that scope — a
    // sign-out ended the client grant, or a removal or detach — and it ends everything
    // there: their runs stop, their automations pause, and what their work left
    // undelivered is dropped. A personal delegation carries only account reads; the
    // owner's own work runs on none, so nothing else stops.
    const hostDelegations = new Delegations({
      registration: () => registrar.current(),
      credential: () => registrar.credential(),
      controlToken: () => registrar.controlToken(),
      onRevoked: (userId, scope, refusal) => {
        // The owner's client in this process presents again once the delegation is gone: another grant of theirs that is still signed in makes it again.
        queueMicrotask(() => localClient.standingChanged(hostOrganizations.owner()?.userId ?? null))
        // Credentials the delegation brought, and sessions opened with them, end with it (ADR 0001 rule 5).
        credentialVault.forgetAll()
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
      onEstablished: (userId, scope) => {
        // A person's client presented on this machine (a cloud machine has no local client):
        // rows that waited for someone to deliver them as go now, not at the next five-minute poll.
        if (scope !== 'personal') {
          runnerDelivery?.retryWaiting()
          return
        }
        void integrationConnections.recheckCloud(userId)
        // The owner's account can be read now: what the link could not upload yet moves into it (docs/plans/cloud-vault.md §2.5).
        if (currentHostUser()?.account?.accountId === userId) {
          void credentialVault.settleLinked(userId)
          void profiles.pullQuietly({ kind: 'owner' })
        }
      },
      // The owner's delegations derive from their sign-in in this process: one missing here or on the account plane is made again from it.
      renew: (userId) => userId === hostOrganizations.owner()?.userId ? localClient.renew() : Promise.resolve(),
    })
    delegations = hostDelegations
    // A member the host object removed may act here no more: their credentials leave
    // the disk and their sessions stop, as when their delegation ends.
    memberUsers?.watch(({ added, removed, layoutChanged }) => {
      // The folders were named after boot (the script ran late), or changed: start
      // members with the switch it names, and give them the plugin where they can read it.
      if (layoutChanged) {
        useMemberSwitch(memberUsers.layout()?.switch ?? null)
        void syncBundledPlugins()
      }
      // Their connections stop showing "Setting up your workspace" (docs/plans/member-isolation.md §8.1).
      for (const { userId } of added) events.broadcast('connection.memberWorkspaceReady', { userId })
      for (const { userId } of removed) {
        identities.revoke(userId)
        for (const held of hostDelegations.holders()) {
          if (held.userId !== userId) continue
          for (const sessionId of hostDelegations.sessionsActingFor(userId, held.scope)) opts.sessionRuntime.stopSession(sessionId, HOST_ACTOR)
        }
      }
    })
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
      if (standing?.owner) {
        void followHostAccount(getDatabase(), standing.owner)
      }
      if (standing?.organizations.some((entry) => entry.shared)) registrar.markAttached()
      // The registration status names the account it belongs to.
      broadcastUplinkStatus()
      // The owner's client in this process presents its token again when a delegation is missing.
      localClient.standingChanged(standing?.owner?.userId ?? null)
    }))
    // Organization runs on an attached machine (organization-vms §3, §4): the host acts
    // for the person behind each turn, and its tools use the Solus API as them.
    turnAdmission.delegations = hostDelegations
    turnAdmission.markAttached = () => { registrar.markAttached() }
    remoteToolOperations = (sessionId) => {
      const actor = hostDelegations.actorOf(sessionId)
      if (!actor) return null
      return remoteWorkspaceOperations(hostDelegations.apiClient(actor.userId, { organizationId: actor.organizationId }))
    }
  }
  // What a token a person's client presents here makes: a host's delegations for them,
  // or, in the Solus API, the token kept to read their account with (`PresentedTokens`).
  const heldDelegations = delegations
  const establishPresented = heldDelegations
    ? (token: string, scope: DelegationScope) => heldDelegations.establish(token, scope)
    : presentedTokens ? async (token: string) => presentedTokens.keep(token) : undefined
  registerOrganizationHandlers(server, {
    hostOrganizations,
    policyStore,
    forgetResource: (resource) => shares.forget(resource),
    events,
    registeredHostId: () => registrar.current()?.hostId ?? null,
    apiUrl: () => registrar.current()?.apiUrl ?? null,
    delivery: () => ({ backlog: deliveryBacklog(), error: runnerDelivery?.currentStatus().error ?? null }),
  })

  // Webhooks (docs/plans/webhooks.md): the receiver and its actions. Agents run only
  // on hosts, so the Solus API has no receiver (§2.1).
  const webhookFacts = {
    hostId: () => registrar.current()?.hostId ?? null,
    forwarderSecret: () => uplinkManager?.forwarderSecret() ?? null,
    isPausedByAdmin: (webhookId: string) => hostOrganizations.isWebhookPausedByAdmin(webhookId),
    organizationRefusal: (organizationId: string, work: { unverified: boolean }) => unattendedOrganizationRefusal(hostOrganizations.organization(organizationId)?.hostRules ?? null, hostPolicies().forWork(organizationId), work.unverified)?.message ?? null,
  }
  const webhooks = createWebhookServices(opts.sessionRuntime, webhookFacts)
  const webhookService = createWebhookService({
    ...webhookFacts,
    urls: {
      // The Solus Cloud origin is the registration's directory URL, the one the uplink calls.
      cloudHost: () => {
        const registration = registrar.current()
        return registration ? { hostId: registration.hostId, origin: registration.directoryUrl } : null
      },
      cloudReady: () => webhookFacts.forwarderSecret() !== null,
      publicUrl: () => getServerSettings().webhookPublicUrl ?? null,
    },
    takeSecretRef: (secretRef, sessionId) => takeSecretRef(secretRef, sessionId),
    onDeleted: (webhook) => mirrorWebhook(webhook, { deleted: true, registered: registrar.current() !== null }),
  })
  // Organization webhooks and their delivery summaries go to the organization's Solus API for its admins (plan §2.7).
  domainEventUnsubscribes.push(
    onWebhookChanged((event) => { if (event.kind === 'saved') mirrorWebhook(event.webhook, { registered: registrar.current() !== null }) }),
    onWebhookDelivery((summary) => {
      if (summary.outcome === 'pending') return
      void (async () => {
        const [webhook, delivery] = await Promise.all([webhookService.read(summary.webhookId), readDelivery(summary.id)])
        if (webhook && delivery) mirrorWebhookDelivery(webhook, delivery, { registered: registrar.current() !== null })
      })().catch((err) => log.warn('webhook_mirror_failed', { webhookId: summary.webhookId, deliveryId: summary.id, error: err instanceof Error ? err.message : String(err) }))
    }),
  )
  setWebhookToolServices({ webhooks: webhookService, actions: webhooks.actions })
  registerWebhookHandlers(server, {
    actions: webhooks.actions,
    webhooks: webhookService,
    link: {
      linked: () => !!uplinkManager?.currentTunnel(),
      holdWhileOffline: () => uplinkManager?.holdWebhooks() ?? null,
      setHoldWhileOffline: async (hold) => { await uplinkManager?.setHoldWebhooks(hold) },
    },
  })
  // The host asks Solus cloud for its held webhook requests when its link comes online (plan §2.4).
  drainWebhooks = (reason) => {
    void uplinkManager?.drainWebhooks()
      .then(async (answer) => {
        if (answer?.kind === 'retry') {
          // The inbox did not answer: ask again after the time Solus cloud named.
          setTimeout(() => drainWebhooks(reason), answer.afterMs).unref()
          return
        }
        if (answer) await webhookService.recordLost(Object.entries(answer.lost).map(([webhookId, count]) => ({ webhookId, count })))
        log.info('webhook_drain_asked', { reason, answered: answer !== null })
      })
      .catch((err) => log.warn('webhook_drain_failed', { reason, error: err instanceof Error ? err.message : String(err) }))
  }
  const linkNow = uplinkManager?.status()
  if (linkNow?.linked && linkNow.state.observed === 'online') drainWebhooks('server_start')
  // A kind an organization's Solus API refused during a rollout is tried again after each read of the facts.
  domainEventUnsubscribes.push(hostOrganizations.onRefreshed(() => retryUnsupportedKinds()))
  // An admin's pause or resume reaches clients when the host reads its organization facts (plan §2.7).
  let pausedWebhooks = new Set<string>()
  hostOrganizations.onChanged(() => {
    const paused = new Set(hostOrganizations.pausedWebhookIds())
    for (const id of new Set([...paused, ...pausedWebhooks])) if (paused.has(id) !== pausedWebhooks.has(id)) void webhookService.announce(id)
    pausedWebhooks = paused
  })
  // The one sweeper of expired operation receipts: API retry keys, replay keys, and delivery IDs, one bounded batch an hour.
  setInterval(() => {
    sweepExpiredReceipts(Date.now()).catch((err) => log.warn('operation_receipts_sweep_failed', { error: err instanceof Error ? err.message : String(err) }))
  }, 60 * 60 * 1000).unref()

  const { server: http, requestListener, solusApiRouter, doors } = buildHttpServer({
    solusApi: { operations: refreshingSessionIndexOnList(workspaceOperations, () => opts.sessionRuntime.requestSessionIndexRefresh()), ...apiSettings },
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
    establishDelegation: establishPresented,
    // Every host admits its own guests (docs/plans/host-sharing.md §4.1).
    resolveShareSecret: (secret) => shares.resolveLinkSecret(secret),
    runner: {
      deliver: (runner, request) => applyRunnerDelivery(runner, request, { shares, onTranscriptChanged: (sessionId) => events.broadcast('session.transcriptChanged', { sessionId }) }),
    },
    transcribeAudio: opts.transcribeAudio,
    completeIntegrationOAuth: (params) => integrationOAuth.complete(params),
    webhookReceiver: apiMode ? undefined : webhooks.receiver,
  })
  // A client's records go over its socket, with the socket's principal as their authority (docs/api/README.md).
  if (solusApiRouter) server.register('solusApiRequest', ([request], ctx) => answerSocketRequest(solusApiRouter, request, ctx.principal))
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
    scheduleLinkExpiry(change)
    if (!guestsRevoked) return
    // The link's guests go, and so does what they suggested and nobody sent.
    if (change.resource.kind === 'session') void suggestions.endGuestSuggestions(change.resource.id)
    ws.disconnectWhere((principal) => principal.kind === 'guest'
      && scopeAdmits(recordScopeOf(principal), organizationId)
      && principal.share.resource.kind === change.resource.kind
      && principal.share.resource.id === change.resource.id, 'share-link-revoked')
  }))
  /**
   * A link that expires while its guests are connected ends them then, as removing
   * it would (docs/plans/custom-roles.md §9). A guest admitted after the expiry was
   * set already has its socket end there; this covers the ones admitted before.
   * One timer per resource, replaced by each change; nothing past the guest visit,
   * which ends every socket anyway.
   */
  function scheduleLinkExpiry(change: ShareChange): void {
    const key = `${change.resource.kind}:${change.resource.id}`
    clearTimeout(linkExpiryTimers.get(key))
    linkExpiryTimers.delete(key)
    const expiry = change.linkExpiry
    if (!expiry) return
    const delay = Math.max(0, expiry.expiresAt - Date.now())
    if (delay > GUEST_VISIT_TTL_MS) return
    const timer = setTimeout(() => {
      linkExpiryTimers.delete(key)
      void shares.linkEnded(change.resource, expiry.linkSecretHash).then((ended) => {
        if (!ended) return
        events.forgetRoomAdmissions()
        const ends = ws.disconnectWhere((principal) => principal.kind === 'guest'
          && principal.share.linkSecretHash === expiry.linkSecretHash
          && principal.share.resource.kind === change.resource.kind
          && principal.share.resource.id === change.resource.id, 'share-link-expired')
        log.info('share_link_expired', { kind: change.resource.kind, resourceId: change.resource.id, guests: ends })
        if (change.resource.kind === 'session') void suggestions.endGuestSuggestions(change.resource.id)
      })
    }, delay)
    timer.unref?.()
    linkExpiryTimers.set(key, timer)
  }
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
  // The host socket answers `/ws` upgrades (`attachWebSocketTransport`); the device
  // hub proxy answers its own. Nothing else upgrades.
  http.on('upgrade', (request, socket, head) => {
    if (!isHostSocketPath(request.url) && !devices.hubProxy.handleUpgrade(request, socket, head)) socket.destroy()
  })
  let ws = attachWebSocketTransport(http, server, {
    clientEvents,
    browserFrames,
    verifyAccessToken: verifyHostAccessToken,
    doors,
    requireAuth: () => requireAuth,
    isTrustedRequester: isTrustedRequesterAddress,
    isTunnelRequest,
    responseBudget: responseReceiptBudget,
    onClientConnected: ({ clientId }) => {
      handlePresenceConnected(clientId)
      // A client that connects may list sessions started outside Solus.
      opts.sessionRuntime.requestSessionIndexRefresh()
    },
    onClientDisconnected: ({ clientId }) => {
      prSync.dropConnection(clientId)
      handlePresenceDisconnected(clientId)
      workLive.disconnected(clientId)
      resourceTelemetry.unsubscribe(clientId)
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
    if (isHostSocketPath(request.url)) ws.handleUpgrade(request, socket, head)
    else if (!devices.hubProxy.handleUpgrade(request, socket, head)) socket.destroy()
  })
  // The workspace service has no tunnel and no link to resume (cloud-service-model.md §15).
  if (!apiMode) {
    tunnelPort = await bindTunnelListener(tunnelHttp, readStoredTunnel()?.proxiedPort ?? DEFAULT_TUNNEL_LISTENER_PORT)
    // A policy that turns the tunnel off keeps a stored link from resuming (plans/030 §6.7).
    void registrar.resumeUntilAnswered((remote, isRetrying) => hostPolicies().hostSetting('cloudTunnel')?.value === false ? Promise.resolve() : uplinkManager.resume(remote, isRetrying)).catch((err) => {
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
  if (isLanDiscoveryDisabled() || hostPolicies().hostSetting('remoteAccess')?.value === false) {
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
    const next = resolveEffectiveServerOptions({ host: opts.host, requireAuth: opts.requireAuth, remoteAccess, ...remoteBindOptions() })
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
      doors,
      requireAuth: () => requireAuth,
      isTrustedRequester: isTrustedRequesterAddress,
      isTunnelRequest,
      responseBudget: responseReceiptBudget,
      onClientConnected: ({ clientId }) => {
        handlePresenceConnected(clientId)
        opts.sessionRuntime.requestSessionIndexRefresh()
      },
      onClientDisconnected: ({ clientId }) => {
        prSync.dropConnection(clientId)
        handlePresenceDisconnected(clientId)
        workLive.disconnected(clientId)
        resourceTelemetry.unsubscribe(clientId)
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
  // A policy change applies at once (plans/030 §5.2): the bind moves, the tunnel closes, telemetry export follows.
  policyStore.onChanged(() => {
    void rebind(effectiveRemoteAccess()).catch((error) => log.warn('policy_rebind_failed', { error: error instanceof Error ? error.message : String(error) }))
    if (hostPolicies().hostSetting('cloudTunnel')?.value === false && uplinkManager.status().linked) {
      void uplinkManager.unlink().catch((error) => log.warn('policy_tunnel_close_failed', { error: error instanceof Error ? error.message : String(error) }))
    }
    void configureOtel(getHostConfig().config.otel, hostPolicies().hostSetting('otel') !== null).catch((error) => log.warn('policy_otel_configure_failed', { error: error instanceof Error ? error.message : String(error) }))
  })

  // Every admitted socket may present the person's account token: renewal and `accountPresent` keep their delegation (ADR 0001 §6 item 5).
  registerAuthHandlers(server, establishPresented ? { verify: verifyHostAccessToken, establish: establishPresented } : null)
  registerRemoteMachinesHandlers(server, { provisioner: sshProvisioner, wslProvisioner, listWslDistros: () => listWslDistros(runDeviceCommand), forwardedHosts, ssh, broadcast: (topic, payload) => events.broadcast(topic, payload) })
  registerConnectionsHandlers(server, {
    getServerInfo: () => ({
      host,
      port: actualPort,
      allowLan: !isLoopbackHost(host),
      remoteAccess: effectiveRemoteAccess(),
      requireAuth,
      trustLocalNetwork: effectiveTrustLocalNetwork(),
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
  registerUplinkHandlers(server, {
    registrar,
    manager: uplinkManager,
    status: uplinkStatus,
    selfTest: createHostSelfTest({
      installationId: getInstallationId,
      status: uplinkStatus,
      isReachedDirectly: () => readHostLinkEnv() !== null,
      isTunnelTurnedOffByPolicy: () => hostPolicies().hostSetting('cloudTunnel')?.value === false,
      boundPort: () => tunnelPort,
      connector: () => uplinkConnector.inspect(),
      exitNode: readTailscaleExitNode,
    }),
  })

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
        forwardedHosts.closeAll()
        stopAutomationScheduler()
        stopMetricsRollover()
        prSync.stop()
        prWatcher.stop()
        resourceTelemetry.stop()
        hostUpdates.stop()
        modelProfiles.stop()
        remoteUpdates.stop()
        stopSupervisor?.()
        codeIntel.dispose()
        await claudeAppProcesses.closeAll()
        devices.runs.dispose()
        await devices.manager.dispose()
        await devices.bridge.stop()
        for (const unsubscribe of domainEventUnsubscribes) unsubscribe()
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
        // A registration check still retrying could start cloudflared again after it stops.
        registrar.stopResuming()
        await uplinkConnector.stop()
        prSync.dropClients()
        try { ws.close() } catch (err) { log.warn('ws_close_failed', { error: err instanceof Error ? err.message : String(err) }) }
        await new Promise<void>((resolve) => http.close(() => resolve()))
        await new Promise<void>((resolve) => tunnelHttp.close(() => resolve()))
        await workStorageRuntime.stop()
        await closeDatabaseForShutdown()
        lock?.release()
      })()
      return shutdownPromise
    },
  }
}
