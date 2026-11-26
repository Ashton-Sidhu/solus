import { HostPairings } from './host/host-pairings'
import { registerHostPairingHandlers } from './transport/handlers/host-pairing-handlers'
import { registerPairApprovalHandlers } from './transport/handlers/pair-approval-handlers'
import { PairApprovals } from './admission/pair-approvals'
import { refreshReportedModels } from './execution/agents/reported-models'
import { setHostPairingTools } from './execution/agents/tools/host-pairing-tools'
import { setCloudMachineTools } from './execution/agents/tools/cloud-machine-tools'
import { initRunningServers } from './host/running-servers/registry'
import { registerRunningServerHandlers } from './transport/handlers/running-server-handlers'
import { onHostRecordRemoved, readHostList } from './host/host-list'
import type { VoiceTranscriptionOptions } from '@solus/contracts/voice-dictionary'
import { configureOtel } from './otel'
import { getHostConfig } from './host/settings'
import { startWorkStorage } from './sync/works/work-storage-runtime'
import { SessionArchiveWriter } from './sync/sessions/session-archive-writer'
import { SessionPusher } from './sync/sessions/session-push'
import { DelegatedSessionRemoteAccess } from './sync/sessions/session-remote-access'
import { sessionCloudIdentity } from './sync/sessions/session-cloud-identity'
import { SessionRepositories } from './sync/sessions/session-repository'
import { SessionBundleTransfers } from './sync/sessions/session-bundle-transfers'
import { AGENT_BIN } from '@solus/contracts/types'
import { findOnPath, warmCliPath } from './cli-env'
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
import { publishedDestination } from './sync/mirror/transcript-mirror'
import { appendDelivery, deliveryBacklog, dropQueuedFor, retryUnsupportedKinds } from './sync/delivery-queue'
import { RemoteUpdateService } from './updates/remote-update-service'
import type { ServerUpdateSupport, SupervisorMessage } from '@solus/contracts/server-update'
import { UpdateStatusService } from './updates/update-status-service'
import { ModelProfilesService, downloadModelProfiles } from './updates/model-profiles-service'
import { ModelPricesService, downloadLiteLlmPrices } from './updates/model-prices-service'
import { detectInstallKind } from './updates/install-kind'
import { fetchLatestRelease } from './updates/release-sources'
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
import { readStoredTunnel, registerAndLink, UplinkLinkManager, type WebhookDrainReason } from './transport/uplink/link'
import { HostRegistrar, HostRegistrationError, enrollAtBoot, readStoredCloudMachine, readStoredRegistration } from './host/host-registration'
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
import { applyRunnerDelivery } from './sync/runner-intake'
import { insightsEligible, useInsightsPolicy } from './sync/mirror/insight-mirror'
import { HostOrganizations } from './host/organizations'
import { HostPolicyStore, PolicyRefusedError, hostPolicies, useHostPolicyStore } from './host/policy/host-policy-store'
import { loadMachinePolicy } from './host/policy/mdm-policy'
import { removeDepartedMembers } from './host/departed-members'
import { ManagedHostActivity } from './host/managed-host-activity'
import { LiveActivityRelay } from './host/live-activity-relay'
import { activityLeases } from './execution/activity-leases'
import { adoptRegistration, cloudOrganizationId, hasManagedCompute, machineKind } from './host/machine-kind'
import { getInsightsOptIn, hostUserSettings } from './host/settings'
import { followHostAccount } from './host/host-user-rows'
import { registerOrganizationHandlers } from './transport/handlers/organization-handlers'
import { TranscriptMirror, listOwnInterruptedSessions, listUnmirroredCloudSessions } from './sync/mirror/transcript-mirror'
import { mirrorTurnDiff } from './sync/mirror/turn-diff-mirror'
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
import { registerMcpTaskHandlers } from './transport/handlers/mcp-task-handlers'
import { McpTasks } from './integrations/mcp-tasks'
import { McpTaskStore } from './integrations/mcp-task-store'
import { registerResourceWatchHandlers } from './transport/handlers/resource-watch-handlers'
import { ResourceWatches } from './integrations/resource-watches'
import { ResourceWatchStore } from './integrations/resource-watch-store'
import { registerAppHandlers } from './transport/handlers/app-handlers'
import { Apps } from './apps/apps'
import { AppDeployments } from './apps/deployments/app-deployments'
import { AppServiceApi } from './apps/deployments/app-service-api'
import { SolusCloudApps, workerMachines, type CloudMachines } from './apps/deployments/cloud-machines'
import { ConnectedHostPlatform } from './apps/deployments/connected-host-platform'
import { DockerPlatform } from './apps/deployments/docker-platform'
import { HostedAppContainers } from './apps/deployments/hosted-app-containers'
import { SolusCloudPlatform } from './apps/deployments/solus-cloud-platform'
import { tailscaleAuthKey } from './apps/deployments/tailscale-key'
import { HostAppBuilder } from './apps/app-builder'
import { hostConnections } from './apps/app-connections'
import { AppModelCalls } from './apps/app-model-calls'
import { modelCallLog } from './apps/app-observability'
import { onAppActivity, onAppDataChanged, onAppSignalOccurred, onAppsChanged } from './apps/app-events'
import { AppFiles } from './apps/app-files'
import { AppRepositories } from './apps/app-repository'
import { AppRunners } from './apps/app-runners'
import { AppSchedules } from './apps/app-schedules'
import { AppDeployPreflights } from './apps/app-deploy-preflight'
import { appSignalDeps } from './apps/app-signal-runtime'
import { setAppTelemetry } from './apps/app-telemetry'
import { otelAppTelemetry } from './execution/observability/app-emitter'
import { AppSignals } from './apps/app-signals'
import { AppStorage } from './apps/app-storage'
import { AppWebhooks, webhookInput } from './apps/app-webhooks'
import { AppWorkflows } from './apps/app-workflows'
import { failInterruptedBuilds, failInterruptedCalls } from './data/apps/app-store'
import { unlinkAppFromSessions } from './data/sessions/session-links'
import { useAppsForTools } from './execution/agents/tools/app-tools'
import { IntegrationApps } from './integrations/mcp-apps'
import { ClaudeAppProcesses, useClaudeAppCapture } from './execution/agents/claude/claude-mcp-apps'
import { IntegrationStore } from './integrations/integration-store'
import { IntegrationCatalog } from './integrations/catalog'
import { installAddMcpServerTool } from './integrations/add-mcp-server-tool'
import { installConnectIntegrationTool } from './integrations/connect-integration-tool'
import { IntegrationWrites } from './integrations/integration-create'
import { FoundServers } from './integrations/found-servers'
import { ConfigWrites } from './integrations/found/config-writes'
import { LocalMcpServers } from './integrations/local-servers'
import type { Integration } from '@solus/contracts/integration-types'
import { IntegrationGateway } from './integrations/gateway'
import { ServerFactsStore } from './integrations/server-facts-store'
import { hostIntegrationClients, IntegrationConnectionStore } from './integrations/connection-store'
import { IntegrationConnections } from './integrations/connections'
import { IntegrationOAuth, type IntegrationConnectionEvents } from './integrations/oauth'
import { setIntegrationGateway } from './integrations/integration-tools'
import { cliSkipLog } from './integrations/cli-skips'
import { AgentProfileManager, hostProfileHomes, type AgentProfileTarget } from './execution/seats/agent-profile'
import { antigravityProfileFilesHome } from './execution/agents/acp/antigravity-skills'
import { profileIntegrations } from './integrations/profile-integrations'
import { listInstalledSkills } from './skills/skills-provider'
import { RegistrySkillCache } from './skills/registry-skill-cache'
import { publishPresenceRoom, registerPresenceHandlers } from './transport/handlers/presence-handlers'
import { PresenceManager } from './presence/presence-manager'
import { SeatManager, memberHomeDirectory, seatKey } from './execution/seats/seat-manager'
import { CodexBackend } from './execution/agents/codex/codex-backend'
import { getCodexAppServerClient } from './execution/agents/codex/codex-agent'
import { ActingIdentities, hostSecretFilesFolder, identityFor, useActingIdentities, withHostScope } from './execution/seats/acting-identity'
import { actorFor, HOST_ACTOR, memberSeat, seatFor } from './admission/actor'
import { currentHostUser, hostUserKey, isHostUserKey, useHostUser } from './host/host-user'
import { parseUserKey } from '@solus/contracts/user'
import { ACCOUNT_SETTINGS_PATH } from '@solus/contracts/settings'
import { MemberFolders, useMemberFolders } from './host/member-folders'
import { memberUsers as installedMemberUsers, WorkspacePreparingError } from './host/member-users'
import { useMemberSwitch } from './cli-env'
import { solusPluginsDir, syncBundledPlugins } from './execution/agents/plugins'
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
import { announceSessionRecordChanged, assignSessionOrganization, markOwnRunningSessionRecordsInterrupted, onSessionRecordChanged, onSessionRecordDeleted, ownPublishedSessionIds, useSessionIndexState } from './data/sessions/session-records'
import { sessionIndexComplete } from './db/session-indexer'
import { assertRpcAccess } from './admission/access-policy'
import { LOCAL_ORGANIZATION_ID } from './admission/principal'
import { resolveRoles, type SolusRole } from './host/roles'
import { hostOperatingSystem } from './platform/host-operating-system'
import { hostDisplayName } from './platform/host-display-name'
import { effectiveRemoteAccess, effectiveTrustLocalNetwork, getServerSettings, setRemoteAccess, setTrustLocalNetwork, setTailscaleServe, assertTailscaleServeAllowed } from './host/settings'
import { TailscaleServe } from './host/tailscale-serve'
import { capabilityDeniedMessage } from '@solus/contracts/policy'
import type { HostStanding } from './host/organizations'
import { isLoopbackHost, resolveEffectiveServerOptions } from './transport/bind-policy'
import { isTrustedRequesterAddress } from './transport/trusted-requesters'
import { remoteAddressAdmission } from './transport/private-network-access'
import type { RemoteAccessMode } from '@solus/contracts/host-api'
import { readBootLinkCode } from './host/boot-link-code'
import { attachWebSocketTransport, isHostSocketPath } from './transport/websocket'
import { ResponseReceiptBudget } from './transport/response-receipt-cache'
import { ClientEventRegistry } from './transport/events/client-event-registry'
import { renameSession } from './execution/sessions/session-rename'
import { HostEventPublisher } from './transport/events/host-event-publisher'
import { BrowserFrameChannel } from './browser/browser-frame-channel'
import { configureDevices, initDeviceDomain } from './devices/device-domain'
import { runDeviceCommand } from './devices/device-process'
import { spawnHelper } from './devices/device-helpers'
import { SshDeviceHost, sshDeviceTarget } from './devices/ssh-device-host'
import { SshClient } from './platform/ssh'
import { registerDeviceHandlers } from './transport/handlers/device-handlers'
import type { SessionRuntime } from './execution/session-runtime'
import { setAgentToolEndpointUrl } from './execution/agents/tools/agent-tool-endpoint'
import { installAppAccessChecks } from './admission/app-sign-in'
import { LOCAL_POLICY_ORGANIZATION_ID } from '@solus/contracts/policy'

/** How long a member's access holds after the host renewed their token: their app stops within this after they lose access. */
const MEMBER_ACCESS_CHECK_MS = 5 * 60 * 1000
import type { AgentMetadata, NormalizedEvent, EnrichedError, SessionIndexUpdatedEvent } from '@solus/contracts/types'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { AgentId, IpcContext } from '@solus/contracts/types'
import { DEFAULT_SERVER_PORT, isSessionBusyStatus, projectScopeOf } from '@solus/contracts/types'
import { registerWindowHandlers, type WindowDeps } from './transport/handlers/window-handlers'
import { enrichAgentMetadata, registerSessionHandlers, type SessionDeps } from './transport/handlers/session-handlers'
import { registerSessionRepositoryHandlers } from './transport/handlers/session-repository-handlers'
import { SessionSync, SessionSyncError } from './execution/sessions/session-sync'
import { fetchSessionBundle } from './execution/sessions/session-bundle-source'
import { chooseSessionRepositorySource, fetchSessionArtifacts, type SessionCodeReadUrl, type SessionReadAccess } from './execution/sessions/session-artifacts-source'
import { sessionCloudSyncDecision } from './host/policy/host-policy-store'
import { insightsAccountOf } from './admission/actor'
import { getSessionRecord, hasSessionRecords, sessionIdsLastActiveBetween, sessionRecordsIndexing } from './data/sessions/session-records'
import { readSessionStorage } from './data/sessions/session-storage'
import { registerWorktreeHandlers } from './transport/handlers/worktree-handlers'
import { registerGitPublishHandlers } from './transport/handlers/git-publish-handlers'
import { registerFilesystemHandlers } from './transport/handlers/filesystem-handlers'
import { registerCodeIntelHandlers } from './transport/handlers/code-intel-handlers'
import { CodeIntelManager } from './code-intel/code-intel-manager'
import { registerHistoryHandlers } from './transport/handlers/history-handlers'
import { registerSessionLineageHandlers } from './transport/handlers/session-lineage-handlers'
import { ensureBackgroundSessionTitle, type BackgroundSessionTitleRequest } from './execution/sessions/background-session-title'
import { registerFolioHandlers } from './transport/handlers/folio-handlers'
import { registerReviewHandlers } from './transport/handlers/review-handlers'
import { ReviewGuideJobs } from './review/guide-jobs'
import { publishGuideStatus } from './review/guide-events'
import { localGuideSource, prGuideSource } from './review/guide-sources'
import { registerAutomationHandlers } from './transport/handlers/automation-handlers'
import { startAutomationScheduler, stopAutomationScheduler } from './execution/automations/automation-scheduler'
import { hasAutomationWork, setAutomationUpdatesPaused, setAutomationBackgroundSessionDispatcher, setAutomationWorktreeCreator } from './execution/automations/automation-runner'
import { listRuns, nextAutomationDueAt, onAutomationsChanged, pauseAutomationsOf } from './data/automations/automations-store'
import { setRemoteHosts, setSessionController, setSessionOrchestration, type ReachCaller } from './execution/agents/tools/session-tools'
import { RemoteHosts, reachOfPrincipal } from './execution/orchestration/remote-hosts'
import { organizationApisOf } from './execution/orchestration/remote-session-read'
import { hostMesh } from './execution/orchestration/host-mesh'
import { LocalClientDoor, type LocalClient } from './transport/local-client'
import { IntroducedHosts } from './execution/orchestration/introduced-hosts'
import type { AccountReach, ReachActor, ReachRequest } from './execution/orchestration/remote-hosts'
import { advertisedRoutes, readTailscaleExitNode, readTailscaleStatus } from './transport/endpoints'
import { setOwnMagicDnsName } from './transport/web-page-requests'
import { orchestrateSessions } from './execution/orchestration/orchestrate-sessions'
import { onAnnotationsChanged } from './annotations/annotation-events'
import { onWorkDeleted, onWorksChanged } from './data/works/work-events'
import { onWorkReviewsChanged } from './data/works/work-reviews'
import { registerWorkReviewHandlers } from './transport/handlers/work-review-handlers'
import { registerNotificationHubHandlers } from './transport/handlers/notification-hub-handlers'
import { publishNotificationChanges } from './notifications/hub-events'
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
import { installPullRequestToolHost } from './execution/agents/tools/pull-request-tools'
import { installPullRequestGuideToolHost } from './execution/agents/tools/pull-request-guide-tools'
import { registerProviderHandlers } from './transport/handlers/provider-handlers'
import { PrSync } from './prs/pr-sync'
import { liveCheckouts, sessionFolderCheckouts } from './prs/pr-sync-interest'
import { PrWatcher } from './prs/pr-watcher'
import { isPullRequestMergeWake, SessionWake } from './execution/sessions/session-wake'
import { registerAtlassianHandlers } from './transport/handlers/atlassian-handlers'
import { registerVaultHandlers } from './transport/handlers/vault-handlers'
import { setOAuthCompletedListener as setAtlassianOAuthCompletedListener } from './atlassian/oauth'
import { reportIntegrationConnection, setConnectionConnectNeededListener } from './connections/connection-tools'
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
import { registerPersonHistoryHandlers } from './transport/handlers/person-history-handlers'
import { publishPersonHistoryChanges } from './transport/events/person-history-events'
import { publishPersonalDocumentChanges } from './transport/events/personal-document-events'
import { loadPersonSettings, startPersonSettingsPulls, usePersonSettingsAccount } from './execution/person-settings'
import { registerLiveActivityHandlers } from './transport/handlers/live-activity-handlers'
import { registerSessionDirectoryHandler } from './transport/handlers/session-directory-handler'
import { registerSessionShellHandler, sessionShellReads } from './transport/handlers/session-shell-handler'
import { SessionShell } from './transport/events/session-shell'
import { onPinnedSessionChanged } from './data/sessions/pinned-sessions'
import { HistoryPrewarm } from './execution/sessions/history-prewarm'
import { registerProjectConfigHandlers } from './transport/handlers/project-config-handlers'
import { registerCodebaseHandlers } from './transport/handlers/codebase-handlers'
import { onCodebasesChanged } from './data/codebases/codebases'
import { onWorkspaceProjectsChanged } from './projects/workspace-projects'
import { listProjects, onProjectsChanged } from './project-config/projects-manifest'
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
import { onSessionReadStateChanged, onSessionStateChanged, onSessionViewChanged } from './data/sessions/session-states'
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
import { SessionExecutionRecorder } from './execution/sessions/session-execution-recorder'
import { interruptOwnSessionExecutions } from './data/sessions/session-executions'
import { SessionDigests } from './execution/sessions/session-digests'
import { emitSessionDigestChanged, onSessionDigestChanged, readSessionDigests, writeSessionDigest } from './data/sessions/session-digests'
import { onTurnCheckpointed } from './git/turn-checkpoints'
import { setFolderToolHost } from './execution/agents/tools/folder-tools'
import { sessionReadsFor } from './transport/handlers/session-reads'
import { setProjectToolHost } from './execution/agents/tools/project-tools'
import { setWorktreeMover } from './execution/agents/tools/worktree-tools'
import { installToolAccess } from './admission/workspace-tool-authority'

const log = createLogger('main', 'server-boot')

export interface BootOptions {
  sessionRuntime: SessionRuntime
  /** Part C supplies the read-token client here when its host access module is merged. */
  sessionReadAccess?: SessionReadAccess
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
  transcribeAudio?: (samples: Float32Array, options?: VoiceTranscriptionOptions) => Promise<{ error: string | null; transcript: string | null }>
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

/**
 * The registration this machine starts with: the one it makes now with the link code in
 * its environment, else the one stored on disk. Answers a registration only when this
 * boot made it.
 */
async function adoptStartupRegistration(): Promise<HostRegistration | null> {
  // The link code leaves the environment first, whatever happens next.
  const code = readBootLinkCode()
  // The Solus API service is no machine: it registers nowhere.
  if (isApiMode()) return null
  // A data directory that was a cloud machine's stays one, also with no registration.
  adoptRegistration(readStoredCloudMachine())
  const enrolled = code
    ? await enrollAtBoot({ code, machine: { installationId: getInstallationId(), label: hostDisplayName(), os: hostOperatingSystem() }, holdsWork: hasSessionRecords })
    : null
  adoptRegistration(enrolled ?? readStoredRegistration())
  return enrolled
}

/** What this process is to its clients: a person's machine, a cloud machine of an organization, or the Solus API service. */
function resolveHostKind(apiMode: boolean): HostKind {
  return apiMode ? 'api' : machineKind()
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
 * session records once at boot, the mirror of turns its previous process left
 * unsettled, and the mirror of sessions that have a cloud copy and no mirrored row.
 * Those rows wait in the queue until their person's token can carry them.
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
  // A session whose cloud copy is older than the mirror of personal sessions goes once, one history read at a time.
  void deps.interruptSweep.then(listUnmirroredCloudSessions).then(async (sessions) => {
    for (const session of sessions) {
      deps.transcriptMirror.touch(session.sessionId, session)
      await deps.transcriptMirror.flushNow(session.sessionId)
    }
  }).catch((error) => {
    log.warn('transcript_mirror_cloud_copy_sweep_failed', { error: String(error) })
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

/**
 * Where the machines of the cloud copies come from (docs/plans/app-deploy.md §8.3): Solus Cloud, with the owner's
 * sign-in; or an app Worker that this host names in its env, for a person who runs their own.
 */
function cloudMachinesOf(account: CloudMachines): CloudMachines {
  const url = process.env.SOLUS_CLOUD_APPS_URL
  const token = process.env.SOLUS_CLOUD_APPS_TOKEN
  if (!url || !token) return account
  return workerMachines({ url, token, name: (appId) => process.env.SOLUS_CLOUD_APPS_NAME || `app-${appId.toLowerCase()}` })
}

export async function bootServer(opts: BootOptions): Promise<BootedServer> {
  // The renderer's first connection waits on this function. An empty store
  // boots in tens of milliseconds; a real one has cost in the stores and the
  // host handlers, so the phases report where it went.
  const bootStartedAt = performance.now()
  const phaseDone = (phase: 'db_opened' | 'host_handlers_registered' | 'domain_handlers_registered' | 'update_services_ready'): void => {
    log.info('server_boot_phase', { phase, elapsedMs: Math.round(performance.now() - bootStartedAt) })
  }
  // Before the listeners or any child process: a machine with a link
  // code in its environment enrolls with it (plans/034-one-cloud-machine-kind.md §3),
  // and the registration — that one, or the one stored before — says whether this is
  // a cloud machine, which decides that no credential-free door opens on it.
  const enrolledAtBoot = await adoptStartupRegistration()
  // And the workspace service refuses to start half-configured (cloud-service-model.md §15).
  applyApiMode()
  const apiMode = isApiMode()
  const apiSettings = solusApiSettings(apiMode, getInstallationId())
  // Asked each time: a server becomes a cloud machine when it registers with an organization code.
  const hostKind = () => resolveHostKind(apiMode)
  // A cloud machine and the workspace service demand a credential on every listener, whatever the bind policy says.
  const credentialAlwaysRequired = () => hostKind() !== 'personal'
  // The machine's MDM policy is read before anything listens; one this host cannot enforce stops the boot (plans/030 §5.1).
  let standingSource: () => HostStanding | null = () => null
  const policyStore = new HostPolicyStore({ mdm: await loadMachinePolicy(), standing: () => standingSource() })
  useHostPolicyStore(policyStore)
  const remoteBindOptions = () => {
    const rule = hostPolicies().hostSetting('remoteAccess')
    return effectiveRemoteAccess() === 'off'
      ? { remoteAllowed: false, refusal: rule ? capabilityDeniedMessage(rule.source, 'remote access').replace(/\.$/, '') : 'Remote access is off' }
      : {}
  }
  const initial = resolveEffectiveServerOptions({ host: opts.host, requireAuth: opts.requireAuth, remoteAccess: effectiveRemoteAccess(), ...remoteBindOptions() })
  const allowRemoteAddress = remoteAddressAdmission(effectiveRemoteAccess)
  let host = initial.host
  let boundRemoteAccess = effectiveRemoteAccess()
  let requireAuth = initial.requireAuth
  const isCredentialRequired = () => requireAuth || credentialAlwaysRequired()
  const port = opts.port ?? WEB_UI_PORT
  let actualPort = port
  let tunnelPort = 0
  const tailscaleServe = new TailscaleServe()
  setOwnMagicDnsName((await readTailscaleStatus())?.Self?.DNSName ?? null)
  if (effectiveRemoteAccess() === 'off') await tailscaleServe.removeMappingsToPort(port)

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
  installToolAccess((principal, resource) => shares.roleFor(principal, resource), shares)
  server.useResourceAccess(shares)
  /** The host's share rows for a published session, appended for its organization; nothing for a session that is not published. */
  const mirrorShareRows = async (resource: ShareResource): Promise<void> => {
    const destination = await publishedDestination(resource.id)
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
  // A task folder that no session names is a creation the previous process did not finish. A new creation waits for this.
  void withHostScope(() => opts.sessionRuntime.taskFolders.sweepUnnamed())
  // A record this host left `running` names a turn the previous process never settled.
  const interruptSweep = markOwnRunningSessionRecordsInterrupted().catch((error) => {
    log.warn('session_records_interrupt_sweep_failed', { error: String(error) })
  })
  // Each person's settings on this host, which their work reads (docs/plans/personal-settings-source.md).
  await loadPersonSettings()
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
  // Each ended turn goes to the session's local repository (docs/plans/portable-sessions.md §7.2).
  const sessionRepositories = new SessionRepositories(join(dataDir(), 'sessions', 'repositories'))
  const sessionBundleTransfers = new SessionBundleTransfers(sessionRepositories)
  let sessionPusher: SessionPusher | null = null
  let sessionRemoteAccess: DelegatedSessionRemoteAccess | null = null
  const sessionArchive = new SessionArchiveWriter({
    repositories: sessionRepositories,
    onCommit: sessionId => sessionPusher?.committed(sessionId),
    turnDiff: mirrorTurnDiff,
    threadFiles: async (provider, threadId, projectPath) => await opts.sessionRuntime.backendFor(provider).threadFiles?.(threadId, projectPath) ?? [],
  })
  opts.sessionRuntime.useSessionArchive(sessionArchive)
  sessionArchive.resume()
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
    publishSessionViewChanges(events, personConnections),
    publishPersonHistoryChanges(events, personConnections),
    publishPersonalDocumentChanges(events, personConnections),
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
      void events.broadcast('issues.invalidated', taskId ? { issueId: taskId } : {})
    }),
    // The end of a source read: a client reads the state of its sources again.
    onTaskSourcesChanged((sourceKeys) => { void events.broadcast('issues.sourcesChanged', { sourceKeys }) }),
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
    onSessionDigestChanged((sessionId) => events.broadcast('session.digestChanged', { sessionId })),
    onWorkspaceProjectsChanged(() => events.broadcast('workspaceProjects.changed', {})),
    onCodebasesChanged(() => events.broadcast('codebases.changed', {})),
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
  const isBusyForPullRequestSettlement = (sessionId: string) =>
    opts.sessionRuntime.statuses.isSessionBusy(sessionId)
    || opts.sessionRuntime.scheduler.requestQueue.hasPromptMatching(sessionId, isPullRequestMergeWake)
  const prSync = new PrSync({
    publish: (change) => events.broadcast('pr.changed', change),
    isSessionBusy: isBusyForPullRequestSettlement,
    observeNeedingAttention: (repo, viewer, pullRequests) => prObserver.observe(repo, viewer, pullRequests),
    // The branch of a session folder can name a pull request too (docs/plans/codebases.md §8).
    liveCheckouts: (now, ofLiveTasks) => liveCheckouts(now, ofLiveTasks, sessionFolderCheckouts(
      opts.sessionRuntime.sessionFolders.gitFolders().map(({ sessionId, folder }) => ({
        sessionId, path: folder.path, repositoryPath: folder.repositoryPath, branch: opts.sessionRuntime.checkouts.get(folder.path)?.checkout?.branch ?? null,
      })),
    )),
  })
  prSync.start()
  // Work outside a turn wakes its session as the person it works for: a
  // pull request watch, an MCP task, and a resource watch.
  const sessionWake = new SessionWake({
    prompt: async (sessionId, text, origin) => {
      await opts.sessionRuntime.dispatch.promptSession(sessionId, text, 'queue', origin)
    },
  })
  // Watched pull requests wake their sessions with news (docs/plans/pr-watch.md).
  const prWatcher = new PrWatcher({ sessionWake })
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
    adoptSession: (sessionId, organizationId, ownerKey, options) => shares.adoptForOrganization({ kind: 'session', id: sessionId }, organizationId, ownerKey, options),
  }
  opts.sessionRuntime.dispatch.admission = turnAdmission
  const announceFork = (sessionId: string) => { void events.broadcast('session.forkCreated', { sessionId }) }
  const sessionDeps: SessionDeps = {
    sessionRuntime: opts.sessionRuntime,
    orchestrator,
    agentIdFromContext: opts.agentIdFromContext,
    shares,
    onResponseForkCreated: announceFork,
  }
  registerSessionHandlers(server, sessionDeps)
  registerSessionRepositoryHandlers(server, sessionBundleTransfers, shares, opts.sessionRuntime, sessionArchive)
  registerSettingsHandlers(server, {
    sessionRuntime: opts.sessionRuntime,
    onHostConfigChanged: (snapshot) => {
      publishHostConfig(snapshot)
      hostUpdates.refreshInstallations()
    },
    onProviderInstancesChanged: () => events.broadcast('provider-instances.changed', {}),
  })

  // One worktree mover for the user's move, the agent's tool, and an offer's Switch.
  const sessionCheckouts = opts.sessionRuntime.sessionCheckouts
  const worktreeMover = new WorktreeMover({
    checkouts: opts.sessionRuntime.checkouts,
    getGitContext: (sessionId) => sessionCheckouts.getGitContext(sessionId),
    trackWorktreeMove: (sessionId, controller) => sessionCheckouts.trackWorktreeMove(sessionId, controller),
    moveSessionCheckout: (sessionId, directory, checkout) => sessionCheckouts.moveSessionCheckout(sessionId, directory, checkout),
    boundDirectories: () => sessionCheckouts.sessionCheckoutPaths.entries(),
    holdNextTurn: (sessionId, finish) => sessionCheckouts.holdNextTurn(sessionId, finish),
    continueSession: async (sessionId, prompt) => { await opts.sessionRuntime.dispatch.promptSession(sessionId, prompt, 'queue', { sender: { kind: 'agent', sessionId } }) },
    recordActivity: (subject, actor, kind) => opts.sessionRuntime.recordActivity(subject, actor, kind),
    nameWorktreeBranch: (...args) => sessionCheckouts.nameWorktreeBranch(...args),
    taskFolders: opts.sessionRuntime.taskFolders,
  })
  setWorktreeMover(worktreeMover, (sessionId) => opts.sessionRuntime.actorOfSession(sessionId))
  setFolderToolHost(opts.sessionRuntime.sessionFolders, (sessionId) => opts.sessionRuntime.actorOfSession(sessionId) ?? HOST_ACTOR)
  const worktreeOffers = new WorktreeOffers({
    mover: worktreeMover,
    recordActivity: (sessionId, actor, kind) => opts.sessionRuntime.recordActivity({ kind: 'session', id: sessionId }, actor, kind),
    sessionActivity: (sessionId) => activityFor(ANY_ORGANIZATION, { kind: 'session', id: sessionId }),
    hostActor: HOST_ACTOR,
  })
  opts.sessionRuntime.on('event', (sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }) => {
    if (to) return
    worktreeOffers.observe(sessionId, event)
    if (event.type === 'turn_settled') worktreeMover.turnSettled(sessionId, event.outcome)
  })
  // What each session did, kept up to date by the host that runs it (docs/plans/session-digests.md).
  const executionRecorder = new SessionExecutionRecorder((sessionId, toolId, execution) => {
    events.broadcast('session.executionChanged', { sessionId, ...(toolId ? { toolId } : {}), execution })
    if (!toolId) void announceSessionRecordChanged(sessionId, execution).catch((error) => {
      log.warn('session_execution_report_failed', { sessionId, error: String(error) })
    })
    void emitSessionDigestChanged(sessionId).catch((error) => {
      log.warn('session_execution_tree_announcement_failed', { sessionId, error: String(error) })
    })
  })
  const recordStatus = (event: HostEventMap['session.statusChanged']) => {
    const { sessionId, status } = event
    const resetsAt = status === 'rate_limited' ? opts.sessionRuntime.rateLimitPark.rateLimits.peek(sessionId)?.resetsAt : null
    const waitingForAgents = status === 'background' && orchestrator.isAwaitingReplies(sessionId)
    const turnId = opts.sessionRuntime.activeSessions.has(sessionId) ? opts.sessionRuntime.turns.current(sessionId)?.id : undefined
    executionRecorder.status(event, turnId, {
      ...(waitingForAgents && { waitingForAgents: true }),
      ...(resetsAt != null && { rateLimitResetsAt: resetsAt * 1000 }),
    })
  }
  opts.sessionRuntime.on('session-status', recordStatus)
  opts.sessionRuntime.on('session-question', recordStatus)
  const sessionDigests = new SessionDigests({
    subagentChanged: (sessionId, agent) => executionRecorder.subagent(sessionId, agent),
    load: async (sessionId) => (await readSessionDigests(ANY_ORGANIZATION, [sessionId])).get(sessionId) ?? null,
    write: writeSessionDigest,
    announce: (sessionId) => void emitSessionDigestChanged(sessionId),
  })
  const recordSessionEvent = (sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }) => {
    if (!to?.only && event.type === 'turn_settled') {
      executionRecorder.settle(sessionId, event.turnId, event.outcome, event.settledAt)
    }
    sessionDigests.observe(sessionId, event, to)
  }
  opts.sessionRuntime.on('event', recordSessionEvent)
  domainEventUnsubscribes.push(() => {
    opts.sessionRuntime.off('session-status', recordStatus)
    opts.sessionRuntime.off('session-question', recordStatus)
    opts.sessionRuntime.off('event', recordSessionEvent)
  })
  domainEventUnsubscribes.push(onTurnCheckpointed((checkpoint) => sessionDigests.checkpointed(checkpoint)))
  domainEventUnsubscribes.push(opts.sessionRuntime.sessionEmitter.onTurnCost((cost) => sessionDigests.costed(cost)))
  registerWorktreeHandlers(server, { sessionRuntime: opts.sessionRuntime, events, worktreeMover, worktreeOffers, prSync })
  registerGitPublishHandlers(server, { sessionFolders: opts.sessionRuntime.sessionFolders })
  // Browsing a host's filesystem must work headless — that is the whole point
  // of pairing a server that has no window.
  registerFilesystemHandlers(server)
  registerCodeIntelHandlers(server, { codeIntel })
  registerAttachmentHandlers(server)
  // What a guest who may only propose sends a session waits here for someone who may prompt it.
  const linkExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const suggestions = new SessionSuggestions({ onChanged: (sessionId) => events.broadcast('session.suggestionsChanged', { sessionId }) })
  registerSuggestionHandlers(server, { suggestions, shares })
  registerAssetHandlers(server, shares)
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
  // when it starts (`integrationToolbox`), so nothing is listed at boot.
  const integrations = new IntegrationStore()
  // A command's verdict and facts are saved, so it starts once and a run start starts nothing (mcp-first-class.md §7.5).
  const integrationGateway = new IntegrationGateway(integrations, undefined, { savedFacts: new ServerFactsStore() })
  const claudeAppProcesses = new ClaudeAppProcesses()
  const integrationApps = new IntegrationApps(integrationGateway, opts.sessionRuntime, claudeAppProcesses)
  integrationGateway.useAppCapture((call) => integrationApps.capture(call))
  integrationGateway.useTurnContext((sessionId, toolUseId) => opts.sessionRuntime.sessionEmitter.turnContextOf(sessionId, toolUseId))
  useClaudeAppCapture((sessionId, app) => integrationApps.captureClaude(sessionId, app))
  registerMcpAppHandlers(server, integrationApps)
  // MCP tasks (mcp-first-class.md §12): a tool call that a server runs as an MCP task
  // becomes the session's background work, and its end starts the agent again once.
  const mcpTasks = new McpTasks({
    store: new McpTaskStore(),
    gateway: integrationGateway,
    sessionWake,
    publish: (event) => { void events.broadcast('mcpTask.changed', event) },
    backgroundEnded: (sessionId) => opts.sessionRuntime.providerEvents.endBackgroundWait(sessionId),
  })
  integrationGateway.useMcpTasks(mcpTasks)
  opts.sessionRuntime.useMcpTaskHolds((sessionId) => mcpTasks.holdsSession(sessionId))
  registerMcpTaskHandlers(server, mcpTasks)
  mcpTasks.start()
  // Resource watches (mcp-first-class.md §11.5): a change of a watched MCP resource
  // starts the session's agent again, once for a burst, after a running turn.
  const resourceWatches = new ResourceWatches({
    store: new ResourceWatchStore(),
    gateway: integrationGateway,
    sessionWake,
    publish: (event) => { void events.broadcast('integration.resourceWatchChanged', event) },
    isSessionBusy: (sessionId) => opts.sessionRuntime.statuses.isSessionBusy(sessionId),
  })
  integrationGateway.useResourceWatches(resourceWatches)
  opts.sessionRuntime.on('session-status', (event: HostEventMap['session.statusChanged']) => resourceWatches.sessionStatusChanged(event.sessionId, event.status))
  // A deleted session ends its watches and MCP tasks; an archive ends those of the person who archived it.
  domainEventUnsubscribes.push(
    onSessionRecordDeleted((sessionId) => {
      resourceWatches.sessionDeleted(sessionId)
      mcpTasks.sessionDeleted(sessionId)
    }),
    onSessionViewChanged((change) => {
      if (change.view.archivedAt === null) return
      resourceWatches.sessionArchived(change.sessionId, change.personKey)
      mcpTasks.sessionArchived(change.sessionId, change.personKey)
    }),
  )
  registerResourceWatchHandlers(server, resourceWatches)
  resourceWatches.start()
  // Apps (docs/plans/apps.md): a backend on this host with its own data. An app's
  // integration calls go through the gateway; its operations run in its own runner.
  // An app's calls are spans of the host's one tracer: in metrics.db always, and at a collector when export is on.
  setAppTelemetry(otelAppTelemetry)
  const appRunners = new AppRunners()
  const appStorage = new AppStorage()
  const appFiles = new AppFiles(appStorage)
  // The host builds what it runs, with the bundler of the Solus plugin it installed for agents (decision 4).
  const appBuilder = new HostAppBuilder({ bundler: () => join(solusPluginsDir(), 'skills', 'visual-artifacts', 'scripts', 'bundle-artifact.mjs') })
  const appRepositories = new AppRepositories()
  const apps = new Apps({ gateway: integrationGateway, integrations, connections: hostConnections, storage: appStorage, runners: appRunners, repositories: appRepositories, builder: appBuilder, files: appFiles })
  // An app can be published to a container of its own (docs/plans/app-deploy.md): the docker platform runs it on this host's
  // engine, and the container reaches the service API of this server by the name Docker gives the host.
  // The release publishes the image of each version (.github/workflows/release-server.yml); a host pulls it at its first publish.
  const appRuntimeImage = () => process.env.SOLUS_APPS_RUNTIME_IMAGE || `ghcr.io/ashton-sidhu/solus-apps-runtime:${packageJson.version}`
  // Solus Cloud for the apps of the owner (§8.3, §7.3): each request is theirs, with the token this host holds for them.
  const ownerAccountId = () => delegations?.holders().find((holder) => holder.scope === 'personal')?.userId ?? null
  const cloudApps = new SolusCloudApps({
    isSignedIn: () => ownerAccountId() !== null,
    request: async (path, init) => {
      const userId = ownerAccountId()
      if (!userId) return { refused: 'NO_DELEGATION', message: 'Sign in to Solus on the host of the app.' }
      return accountReadsOfServer.fetch(userId, 'personal', path, { method: init.method, body: init.body, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000) })
    },
  })
  // The address that Solus Cloud gives this host, while its tunnel is open.
  const tunnelOrigin = (): string | null => {
    const status = uplinkManager.status()
    return status.linked && status.state.observed === 'online' ? `https://${status.tunnel.hostname}` : null
  }
  const appDeployments = new AppDeployments(apps, {
    runtimeImage: appRuntimeImage,
    platforms: [
      new DockerPlatform({ image: appRuntimeImage, tailscaleAuthKey }),
      new SolusCloudPlatform(cloudMachinesOf(cloudApps)),
    ],
    hasTailscaleKey: () => tailscaleAuthKey() !== null,
    signIn: cloudApps,
    // A container on this host reaches this server by the name Docker gives the host. A cloud deployment reaches it at the
    // address that Solus Cloud gives this host, while this host is online. A container on a connected host reaches it at
    // the route with the widest reach; a server bound to loopback has none.
    solusUrl: async (platform, hostId) => {
      if (hostId !== null) return (await advertisedRoutes(host, actualPort))[0]?.url ?? ''
      return platform === 'docker' ? `http://host.docker.internal:${actualPort}` : process.env.SOLUS_CLOUD_SERVICE_URL || tunnelOrigin() || ''
    },
    // The container of a deployment can run on another host of the owner (§8.5): the hosts this one reaches for them.
    connectedHosts: {
      list: async () => {
        const hosts = await remoteHosts.list(ownerReach())
        return 'error' in hosts ? [] : hosts.map((target) => ({ id: target.hostId, label: target.label }))
      },
      connect: async (hostId) => {
        const remote = await remoteHosts.connectTo(ownerReach(), hostId)
        if ('error' in remote) throw new Error(remote.error)
        return { id: remote.hostId, label: remote.label, platform: new ConnectedHostPlatform(remote.label, remote.api) }
      },
    },
  })
  // The containers this host runs for the apps of another Solus of its owner. Their names differ from this host's own deployments.
  const hostedAppContainers = new HostedAppContainers(new DockerPlatform({ image: appRuntimeImage, tailscaleAuthKey, namePrefix: 'solus-hosted-app-' }))
  apps.addLifecyclePart(appDeployments)
  const appSchedules = new AppSchedules(apps)
  const appWorkflows = new AppWorkflows(apps, appRunners)
  const appSignals = new AppSignals(apps, appSignalDeps(opts.sessionRuntime))
  apps.addLifecyclePart(appSchedules)
  apps.addLifecyclePart(appSignals)
  apps.addLifecyclePart(appWorkflows)
  const appPreflights = new AppDeployPreflights({ apps, builder: appBuilder, repositories: appRepositories })
  apps.addLifecyclePart(appPreflights)
  apps.useWorkflows(appWorkflows)
  apps.useSignals(appSignals)
  // The app's model calls run with this host's providers (docs/plans/app-models.md); a call the host stopped during is failed at boot.
  const appModelCalls = new AppModelCalls(apps, { dispatcher: opts.sessionRuntime, callLog: modelCallLog })
  apps.useModelCalls(appModelCalls)
  apps.addLifecyclePart(appModelCalls)
  // A model call of a published copy runs here too, with the owner's model account (§5.2). Each operation it uses as a tool
  // runs in the copy, on the copy's data. Its record is beside the records of the app, so the owner reads it in Activity.
  const deploymentModelCalls = new AppModelCalls({
    record: (authority, idOrSlug) => apps.record(authority, idOrSlug),
    callOperation: (appId, operation, input, caller) => appDeployments.callOperation(appId, { operation, input, caller }),
  }, { dispatcher: opts.sessionRuntime, callLog: modelCallLog })
  apps.addLifecyclePart(deploymentModelCalls)
  void appModelCalls.recover().catch((error) => log.warn('app_model_calls_recover_failed', { error: error instanceof Error ? error.message : String(error) }))
  // A deleted app leaves no session linked to it.
  apps.addLifecyclePart({ activated: async () => {}, removed: (app) => unlinkAppFromSessions(app.id) })
  useAppsForTools({ apps, builder: appBuilder, workflows: appWorkflows, signals: appSignals, modelCalls: appModelCalls, deployments: appDeployments })
  domainEventUnsubscribes.push(
    onAppsChanged((event) => events.broadcast('apps.changed', event)),
    onAppDataChanged((event) => events.broadcast('apps.dataChanged', event)),
    onAppActivity((event) => events.broadcast('apps.activity', event)),
    onAppSignalOccurred((event) => events.broadcast('apps.signalOccurred', event)),
  )
  setIntegrationGateway(integrationGateway)
  integrationGateway.onToolsChanged((integrationId) => { void events.broadcast('integration.changed', { integrationId, change: 'tools' }) })
  integrationGateway.onFactsChanged((integrationId) => { void events.broadcast('integration.changed', { integrationId, change: 'facts' }) })
  cliSkipLog.onChanged((integrationId) => { void events.broadcast('integration.changed', { integrationId, change: 'facts' }) })
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
  // A signed-in person's settings come from their account (ADR 0007 decision 4): the host
  // reads them with its token for the person, which is the host owner's account or a member's own.
  usePersonSettingsAccount({
    userFor: (personKey) => {
      const id = parseUserKey(personKey)
      const userId = isHostUserKey(personKey) ? hostOrganizations.owner()?.userId ?? null : id.kind === 'account' ? id.accountId : null
      if (!userId) return null
      const holdsToken = presentedTokens?.tokenFor(userId) != null || delegations?.holders().some((holder) => holder.userId === userId) === true
      return holdsToken ? userId : null
    },
    read: (userId) => accountReadsOfServer.fetch(userId, null, ACCOUNT_SETTINGS_PATH),
  })
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
      // An Antigravity profile keeps its global skills under `config` (docs/plans/antigravity-provider.md §7.1).
      if (provider === 'antigravity') return antigravityProfileFilesHome(seats.homeFor(seat, provider))
      if (memberUsers && seat.kind === 'user') return join(memberUserOf(seat).home, provider === 'claude-code' ? '.claude' : '.codex')
      return seats.homeFor(seat, provider)
    },
    processUserFor: (target) => identityFor(profileSeat(target)).processUser(),
    now: Date.now,
    skills: { list: () => listInstalledSkills(), files: (entry) => registrySkills.files(`${entry.source}@${entry.skillId}`, entry.name) },
    integrations: profileIntegrations({ store: integrations, gateway: integrationGateway, connections: integrationConnections, events }),
    integrationOwnerFor: (target) => target.kind === 'member'
      ? { organizationId: target.organizationId, ownerKey: target.userId }
      : { organizationId: cloudOrganizationId() ?? LOCAL_ORGANIZATION_ID, ownerKey: hostUserKey() },
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
    const organizationId = (held && held !== 'personal' ? held.organizationId : null) ?? cloudOrganizationId()
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
  // Settings, the agent, and Found write integration records through one writer.
  const integrationWrites = new IntegrationWrites({ store: integrations, events, profile: integrationProfile, gateway: integrationGateway, connections: integrationConnections, oauth: integrationOAuth })
  // The agent adds and connects a service from the same catalog and create path as Settings (§13.2).
  installConnectIntegrationTool({
    catalog: integrationCatalog,
    create: (principal, owner, request) => integrationWrites.addServer(principal, owner, request),
  })
  // The MCP servers on this host's loopback follow the running-servers list once it exists (mcp-first-class.md §9).
  const localMcpServers = new LocalMcpServers({
    integrations: () => integrations.listAnyOwner(ANY_ORGANIZATION),
    gateway: integrationGateway,
    factsChanged: (integrationId) => { void events.broadcast('integration.changed', { integrationId, change: 'facts' }) },
  })
  const foundServers = new FoundServers({
    store: integrations,
    writes: integrationWrites,
    connections: integrationConnections,
    // Codex reads its own files, with its rule for a trusted project (mcp-first-class.md §8.1).
    codexLayers: codexBackend ? async (cwd) => (await getCodexAppServerClient().request('config/read', { includeLayers: true, cwd })).layers ?? [] : undefined,
    local: localMcpServers,
    // Codex writes its own config (`config/value/write`), so Solus does not race it on its file (§8.8).
    configWrites: new ConfigWrites({
      codexWrite: codexBackend ? async (keyPath, value, filePath) => { await getCodexAppServerClient().request('config/value/write', { keyPath, value, mergeStrategy: 'replace', filePath }) } : undefined,
    }),
  })
  // An agent gives a server it installed for its CLI to every agent, through the same add as Found (§8.7).
  installAddMcpServerTool({
    found: foundServers,
    start: (integrationId, starter) => integrationGateway.startProcess(integrationId, starter),
    askToConnect: (integration, sessionId) => reportIntegrationConnection(integration, sessionId, { added: true }),
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
  // The owner reaches other hosts through their personal delegation and the introduced hosts (host-reach.md §3.2).
  const ownerReach = (): ReachRequest => {
    const owner = delegations?.holders().find((holder) => holder.scope === 'personal')
    return { account: owner ? { userId: owner.userId, scope: 'personal' } : null, isOwner: true }
  }
  // A caller's reach: the owner's own, a member's organization, and nothing for anyone else.
  const reachOf = (principal: Principal): ReachRequest | null => reachOfPrincipal(principal, ownerReach)
  // The person an agent tool reaches for: the calling session's current turn, or an outside
  // app's person. Null for the host's own turn, which has no person.
  const reachingPrincipal = (caller: ReachCaller): Principal | null => {
    if ('principal' in caller) return caller.principal
    const actor = opts.sessionRuntime.activeRunRequests.get(caller.sessionId)?.actor
    return actor?.user ? actor.principal : null
  }
  const hostPairings = new HostPairings(getInstallationId, hostDisplayName)
  const pairApprovals = new PairApprovals()
  domainEventUnsubscribes.push(registerPairApprovalHandlers(server, pairApprovals, { broadcast: (topic, payload) => events.broadcast(topic, payload) }))
  setHostPairingTools(hostPairings)
  // The cloud machine and organization tools act as the person of the turn, with the token this host holds for them (plans/035 §5).
  setCloudMachineTools({
    reads: accountReadsOfServer,
    holders: () => apiMode ? [] : delegations?.holders() ?? [],
    thisHost: () => ({ hostId: registrar.current()?.hostId ?? null, installationId: getInstallationId() }),
    ssh,
    accountOrigin: () => hostOrganizationsDeps.registration()?.directoryUrl ?? null,
  })
  const remoteHosts = new RemoteHosts(accountReach, introducedHosts, () => registrar.current()?.hostId ?? null, () => lanDiscovery.discoverServers(), getInstallationId, forwardedHosts, fetch, hostPairings, readHostList)
  // This host introduces the machines it holds to each other, so a machine that no
  // device reaches still joins the person's other machines (host-reach.md §4.4).
  const hostIntroductionsAllowed = () => !hostPolicies().capabilityDenial('remoteAccess', 'host introductions')
  const mesh = hostMesh({
    self: () => ({
      installationId: getInstallationId(),
      label: hostDisplayName(),
      api: {
        hostIntroductionsList: async () => introducedHosts.list(),
        hostIntroductionIssue: (forHost) => introducedHosts.issue(forHost),
        hostIntroductionAccept: async ({ introduction, grantedDeviceId }) => {
          await introducedHosts.accept(introduction, grantedDeviceId)
          remoteHosts.disconnect(introduction.installationId)
          return { ok: true as const }
        },
      },
    }),
    targets: async () => {
      const targets = await remoteHosts.list({ account: null, isOwner: true })
      return 'error' in targets ? [] : targets
    },
    connect: (target) => remoteHosts.connect(target),
  })
  const meshHosts = () => { if (hostIntroductionsAllowed()) mesh.run() }
  registerHostPairingHandlers(server, hostPairings, remoteHosts, meshHosts)
  registerSessionLineageHandlers(server, opts.sessionRuntime, remoteHosts, reachOf)
  domainEventUnsubscribes.push(onHostRecordRemoved(({ listing }) => remoteHosts.disconnect(listing.installationId)))
  setRemoteHosts(remoteHosts)
  registerIntegrationHandlers(server, {
    store: integrations,
    catalog: integrationCatalog,
    gateway: integrationGateway,
    events,
    connectionStore: integrationConnectionStore,
    connections: integrationConnections,
    oauth: integrationOAuth,
    getServerInfo: () => ({ host, port: actualPort }),
    profile: integrationProfile,
    writes: integrationWrites,
    found: foundServers,
    // The other hosts an MCP discovery asks for the caller (mcp-first-class.md §8.9).
    remote: { hosts: remoteHosts, reachOf },
    hostLabel: hostDisplayName,
    local: localMcpServers,
  })
  setSessionController({
    // fork_session reads sessions as the person the calling turn works for.
    fork: {
      runtime: opts.sessionRuntime,
      readsFor: (principal) => sessionReadsFor(server, { clientId: 'agent-tool', principal }),
      announce: announceFork,
    },
    // start_sessions reads this host's usage to choose the fallback model.
    providerUsage: {
      usage: opts.sessionRuntime.usageLimits,
      held: opts.sessionRuntime.rateLimitPark.rateLimits,
      providerOf: (sessionId) => opts.sessionRuntime.activeSessions.get(sessionId)?.backendId,
      actorOf: (sessionId) => opts.sessionRuntime.actorOfSession(sessionId),
    },
    permissionModeFor: (sessionId) => opts.sessionRuntime.activeSessions.get(sessionId)?.runInput?.permissionMode ?? opts.sessionRuntime.sessionPermissionModes.get(sessionId),
    codebaseIdFor: (sessionId) => opts.sessionRuntime.sessionFolders.codebaseIdOf(sessionId),
    // A turn, or an outside app's call, reaches other hosts for its own person by `reachOf`
    // (host-reach.md §3.2; plans/035 §0.6): the owner through their personal delegation and
    // the introduced hosts; a member only through their organization; anyone else not at all.
    // The host's own turn, with no person, reaches as the owner.
    reachRequestFor: (caller): ReachRequest | null => {
      const principal = reachingPrincipal(caller)
      return principal ? reachOf(principal) : ownerReach()
    },
    // The same people and scopes read their organizations' Solus APIs: the owner every
    // organization this host holds a delegation for, a member only their own.
    organizationApisFor: (caller) => {
      const held = delegations
      return held ? organizationApisOf(reachingPrincipal(caller), held.holders(), (userId, scope) => held.apiClient(userId, scope)) : []
    },
    listAgentTargets: async () => Promise.all(
      opts.sessionRuntime
        .getBackendIds()
        .map((id) => opts.sessionRuntime.getMetadataFor(id))
        .filter((metadata): metadata is AgentMetadata => metadata !== undefined)
        .map(async (metadata) => agentTargetFromMetadata(await enrichAgentMetadata(metadata))),
    ),
    getSessionInfo: (sessionId) => opts.sessionRuntime.history.sessionInfoOrRecord(sessionId),
    loadSessionTail: (provider, sessionId, projectPath, limit) => opts.sessionRuntime.history.loadSession(provider, sessionId, projectPath, limit),
    liveStatus: (sessionId) => opts.sessionRuntime.statuses.liveSessionStatus(sessionId),
    executedModel: (sessionId) => orchestrator.executedModelOf(sessionId),
    pendingInputEvents: (sessionId) => opts.sessionRuntime.inputRequests.pendingInputEventsForSession(sessionId),
    loadPlanContent: (provider, sessionId, projectPath, planToolUseId) =>
      opts.sessionRuntime.history.loadPlanContent(provider, sessionId, projectPath, planToolUseId),
    listPlans: (provider, projectPath, allProjects) => opts.sessionRuntime.history.listPlans(provider, projectPath, allProjects),
    invalidatePlanCaches: (sessionId) => opts.sessionRuntime.history.invalidatePlanCaches(sessionId),
    renameSession: (callerSessionId, sessionId, title) => {
      const actor = opts.sessionRuntime.actorOfSession(callerSessionId) ?? HOST_ACTOR
      return renameSession(opts.sessionRuntime, events, {
        sessionId, title, source: 'manual', publishEvent: true, actor, scope: recordScopeOf(actor.principal), via: { sessionId: callerSessionId },
      })
    },
    sessionQueue: (sessionId) => opts.sessionRuntime.scheduler.queueSnapshot(sessionId),
    changeSessionQueue: (callerSessionId, sessionId, mutation) =>
      opts.sessionRuntime.scheduler.changeSessionQueue(sessionId, mutation, opts.sessionRuntime.actorOfSession(callerSessionId) ?? HOST_ACTOR),
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
  const historyPrewarm = new HistoryPrewarm(opts.sessionRuntime)
  registerSessionDirectoryHandler(server, historyPrewarm)
  // The phone's session list as a snapshot and the changes after it (docs/plans/mobile-session-shell.md §5).
  // Published host events and the personal changes that no connection may hear move its keys.
  const sessionShell = new SessionShell({
    reads: sessionShellReads(server),
    publish: (clientId, changes) => { void events.publish(clientId, 'sessionShell.changed', changes) },
    hostProjects: listProjects,
    sessionsStartedBy: async (automationId) => (await listRuns(automationId)).flatMap(run => run.sessionId ? [run.sessionId] : []),
    sessionsLastActiveBetween: sessionIdsLastActiveBetween,
  })
  // A session leaves the list 30 days after its last activity, with no event: check once an hour.
  const sessionShellIdleCheck = setInterval(() => { void sessionShell.checkIdleSessions() }, 60 * 60_000)
  sessionShellIdleCheck.unref?.()
  sessionShell.attentionChanged(opts.sessionRuntime.attention.list())
  domainEventUnsubscribes.push(
    events.observe((event) => sessionShell.observe(event)),
    onSessionRecordChanged((record) => sessionShell.sessionChanged(record.sessionId)),
    onSessionRecordDeleted((sessionId) => sessionShell.sessionChanged(sessionId)),
    onSessionViewChanged((change) => sessionShell.sessionChanged(change.sessionId)),
    onSessionReadStateChanged((change) => sessionShell.sessionChanged(change.sessionId)),
    onPinnedSessionChanged((change) => sessionShell.sessionChanged(change.sessionId)),
    () => clearInterval(sessionShellIdleCheck),
  )
  registerSessionShellHandler(server, sessionShell)
  // A turn changes the provider file: read the session's first page again before it is next opened.
  opts.sessionRuntime.on('session-status', (event: HostEventMap['session.statusChanged']) => {
    if (event.status === 'completed' || event.status === 'failed' || event.status === 'interrupted') historyPrewarm.afterTurn(event.sessionId)
  })
  registerCodebaseHandlers(server, opts.sessionRuntime.sessionFolders, opts.sessionRuntime.taskFolders)
  registerTasksHandlers(server)
  registerOutboxHandlers(server)
  // Any host can own tasks (and their works), so the owner-side appliers
  // register unconditionally.
  registerTaskOutboxApplier()
  registerWorkOutboxApplier()
  registerGoogleHandlers(server, { getServerInfo: () => ({ host, port: actualPort }) })
  registerAtlassianHandlers(server)
  registerVaultHandlers(server)
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
    hostConfigChanged: (snapshot) => publishHostConfig(snapshot),
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
    isSessionBusy: isBusyForPullRequestSettlement,
    prSync,
    guides,
    resources: shares,
  })
  installPullRequestToolHost({
    resources: shares,
    prSync,
    isSessionBusy: isBusyForPullRequestSettlement,
  })
  // The PR guide tools start runs through the same owner as the prGenerateGuides RPC.
  installPullRequestGuideToolHost({
    guides,
    dispatcher: opts.sessionRuntime,
    servesExecution: () => server.servesExecution(),
    projectOf: (sessionId) => {
      const run = opts.sessionRuntime.activeSessions.get(sessionId)?.runInput
      return run ? projectScopeOf(run) : undefined
    },
  })
  registerChecksHandlers(server)
  // The clients that run on one seat; a seat's facts go to them and nobody else.
  const clientsForSeat = (seat: Seat): string[] =>
    [...ws.sessions.values()].filter((session) => seatKey(seatFor(actorFor(session.principal))) === seatKey(seat)).map((session) => session.clientId)
  const usageWatches = registerUsageHandlers(server, {
    sessionRuntime: opts.sessionRuntime,
    events,
    seats,
    clientsForSeat,
  })
  const serverRegistry = initRunningServers((clientIds, servers, error) => { void events.publish(clientIds, 'runningServers.changed', { servers, error }) }, withHostScope)
  const serverTunnels = registerRunningServerHandlers(server, serverRegistry, (port) => port === actualPort || port === tunnelPort)
  let previewTunnelEnabled = getHostConfig().config.previewTunnelEnabled
  function publishHostConfig(snapshot: ReturnType<typeof getHostConfig>): void {
    previewTunnelEnabled = snapshot.config.previewTunnelEnabled
    serverTunnels.applyPolicy()
    events.broadcast('config.changed', snapshot)
  }
  localMcpServers.follow(serverRegistry)
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
  domainEventUnsubscribes.push(registerHostListHandlers(server, { broadcast: (topic, payload) => events.broadcast(topic, payload) }))
  registerSessionReadStateHandlers(server)
  // A host is the person's home while they are signed out (docs/plans/person-state.md §3).
  registerPersonHistoryHandlers(server, () => LOCAL_ORGANIZATION_ID)
  phaseDone('domain_handlers_registered')
  const updatesAllowed = () => hostPolicies().hostSetting('updates')?.value.mode !== 'off'
  const hostUpdates = new UpdateStatusService({
    currentVersion: packageJson.version,
    install: hasManagedCompute() ? 'cloud' : detectInstallKind(),
    latest: () => fetchLatestRelease(packageJson.version),
    automaticUpdates: () => getServerSettings().hostConfig.agentAutoUpdates,
    canCheck: updatesAllowed,
    assertInstallAllowed: assertUpdatesAllowed,
    publish: (status) => { events.broadcast('host.updateStatusChanged', status) },
  })
  let activeSetupSteps = 0
  const supervisor = opts.updateSupervisor
  server.setUpdateTrial(supervisor?.support.operation?.phase === 'restarting')
  const remoteUpdates = new RemoteUpdateService({
    status: () => hostUpdates.status,
    publish: (support) => hostUpdates.setServerUpdate(support),
    blockNewTurns: (blocked) => { opts.sessionRuntime.setUpdatePending(blocked); setAutomationUpdatesPaused(blocked) },
    hasWork: () => hostUpdates.isUpdatingAgents || activeSetupSteps > 0 || hasAutomationWork() || opts.sessionRuntime.hasWorkForUpdate(),
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
  await interruptOwnSessionExecutions(Date.now())
  const interruptedSessions = await interruptSweep
  orchestrator.recover()
  if (interruptedSessions) orchestrator.reportChildrenInterruptedByRestart(interruptedSessions)
  startAutomationScheduler()
  // A call or a build that was in progress when the host last stopped did not finish; then the app schedules and the runs start.
  void Promise.all([failInterruptedCalls(Date.now()), failInterruptedBuilds()])
    .catch((err) => log.warn('app_calls_recovery_failed', { error: err instanceof Error ? err.message : String(err) }))
    .then(() => {
      appSchedules.start()
      // Each run that was in progress starts again from its receipts, and each sleeping run gets its wake.
      appWorkflows.start()
    })
  // A policy with `updates.mode: off` manages this host's updates (plans/030 §6.8).
  function assertUpdatesAllowed(): void {
    const rule = hostPolicies().hostSetting('updates')
    if (rule?.value.mode === 'off') throw new PolicyRefusedError('UPDATES_MANAGED', `${rule.source.document.organization.name} manages Solus updates.`)
  }
  server.register('hostInstallUpdate', () => { assertUpdatesAllowed(); remoteUpdates.install(); return structuredClone(hostUpdates.status) })
  server.register('hostCancelUpdate', () => { remoteUpdates.cancel(); return structuredClone(hostUpdates.status) })
  server.register('hostUpdateStatus', () => structuredClone(hostUpdates.status))
  server.register('hostCheckForUpdates', () => { assertUpdatesAllowed(); return hostUpdates.check() })
  hostUpdates.refreshInstallations()
  hostUpdates.start()
  const modelProfiles = new ModelProfilesService({
    cachePath: join(solusDir(), 'model-profiles.json'),
    download: downloadModelProfiles,
    publish: (status) => { events.broadcast('host.modelProfilesChanged', status) },
    onProfilesChanged: () => { void hostUpdates.refreshProviders() },
  })
  // Claude Code and an ACP agent report models the published list does not know; clients read them from the metadata.
  for (const id of opts.sessionRuntime.getBackendIds()) {
    opts.sessionRuntime.backendFor(id).on('models-reported', () => { events.broadcast('host.modelProfilesChanged', modelProfiles.status) })
  }
  server.register('modelProfilesStatus', () => modelProfiles.status)
  // An agent that reports its models only when a session opens is asked again at boot and when a person refreshes the list.
  const refreshAllReportedModels = () => Promise.all(opts.sessionRuntime.getBackendIds().map((id) => refreshReportedModels(opts.sessionRuntime.backendFor(id))))
  server.register('modelProfilesRefresh', async () => (await Promise.all([modelProfiles.refresh(), refreshAllReportedModels()]))[0])
  server.register('modelProfilesCheck', () => modelProfiles.checkIfStale())
  modelProfiles.start()
  void refreshAllReportedModels()
  const modelPrices = new ModelPricesService({ cachePath: join(solusDir(), 'model-prices.json'), download: downloadLiteLlmPrices })
  modelPrices.start()
  const setup = registerSetupHandlers(server, { events, checkouts: opts.sessionRuntime.checkouts,
    agents: hostUpdates.agents,
    assertNewWorkAllowed: () => opts.sessionRuntime.assertNewWorkAllowed(),
    onActiveStepsChanged: (count) => { activeSetupSteps = count },
    seats,
  })
  setProjectToolHost({
    create: (request, caller) => server.handle('setupCreateProject', [request], caller),
    clone: (request, caller) => server.handle('setupCloneProject', [request], caller),
    adopt: (sessionId, path, addToCodebase) => {
      return opts.sessionRuntime.sessionFolders.adoptCreated(sessionId, path, addToCodebase, opts.sessionRuntime.actorOfSession(sessionId) ?? HOST_ACTOR)
    },
    // The project, codebase, sharing, and host tools send the RPC of a person's client, through its gate.
    rpc: {
      listProjects: (args, caller) => server.handle('listProjects', args, caller),
      projectConfigLoad: (args, caller) => server.handle('projectConfigLoad', args, caller),
      projectConfigSave: (args, caller) => server.handle('projectConfigSave', args, caller),
      untrackProject: (args, caller) => server.handle('untrackProject', args, caller),
      codebaseList: (args, caller) => server.handle('codebaseList', args, caller),
      codebaseSave: (args, caller) => server.handle('codebaseSave', args, caller),
      codebaseMembers: (args, caller) => server.handle('codebaseMembers', args, caller),
      codebaseScanFolder: (args, caller) => server.handle('codebaseScanFolder', args, caller),
      shareGet: (args, caller) => server.handle('shareGet', args, caller),
      shareSet: (args, caller) => server.handle('shareSet', args, caller),
      shareSetLink: (args, caller) => server.handle('shareSetLink', args, caller),
      shareLinkOrigin: (args, caller) => server.handle('shareLinkOrigin', args, caller),
      hostSelfTest: (args, caller) => server.handle('hostSelfTest', args, caller),
      hostResources: (args, caller) => server.handle('hostResources', args, caller),
    },
  })
  // A Run on prompt copies its repository before its run starts (docs/run-on.md).
  opts.sessionRuntime.launcher.prepareDispatchCheckout = setup.prepareDispatchCheckout
  opts.sessionRuntime.useSessionSync(new SessionSync(opts.sessionRuntime, {
    repositories: sessionRepositories,
    providerInstalled: async (provider) => {
      const binary = AGENT_BIN[provider]
      return binary ? !!findOnPath(binary, await warmCliPath()) : false
    },
    // eslint-disable-next-line complexity
    fetchBundle: async (request) => {
      const { sessionId, sourceHostId, actor } = request
      const principal = actor.principal
      const reach: ReachRequest = reachOf(principal) ?? { account: null, isOwner: false }
      const record = await getSessionRecord(ANY_ORGANIZATION, sessionId)
      const account = insightsAccountOf(actor)
      const decision = sessionCloudSyncDecision(record?.organizationId ?? (principal.kind === 'org-member' ? principal.organizationId : 'local'), account?.id.kind === 'account' ? { accountId: account.id.accountId } : null)
      const storage = readSessionStorage(sessionId)
      const localPath = storage ? sessionRepositories.named(storage.repository).path : null
      const readAccess: SessionReadAccess | undefined = opts.sessionReadAccess ?? (sessionRemoteAccess ? async (readSessionId, readActor) => {
        const person = insightsAccountOf(readActor)
        if (person?.id.kind !== 'account') return null
        const localRecord = await getSessionRecord(ANY_ORGANIZATION, readSessionId)
        const answer = await sessionRemoteAccess!.remote(readSessionId, sessionCloudIdentity(localRecord, person.id.accountId), 'read')
        return answer.status === 'ready' ? answer.remote : null
      } : undefined)
      const codeUrl: SessionCodeReadUrl = async (code, readActor) => {
        const person = insightsAccountOf(readActor)
        if (!sessionRemoteAccess || person?.id.kind !== 'account') return null
        const localRecord = await getSessionRecord(ANY_ORGANIZATION, code.sessionId)
        const answer = await sessionRemoteAccess.codeUrl({ ...code, access: 'read' }, sessionCloudIdentity(localRecord, person.id.accountId))
        return answer.status === 'ready' ? answer.url : null
      }
      return chooseSessionRepositorySource(decision.allowed && readAccess
        // A refused local head is not in the cloud history. With no `have`, the cloud source does not answer `diverged`.
        ? cloudRequest => fetchSessionArtifacts(readAccess, codeUrl, localPath, { ...cloudRequest, have: sessionPusher?.refusedHead(sessionId) ? null : cloudRequest.have }) : null,
      async (hostRequest) => {
        if (!sourceHostId && !decision.allowed && decision.reason === 'person-not-signed-in') throw new SessionSyncError('not-signed-in', 'Sign in or connect to the last run host.')
        if (!sourceHostId) throw new SessionSyncError('no-repository', 'No session repository is available.')
        try { return await fetchSessionBundle(remoteHosts, reach, hostRequest) }
        catch (error) {
          if (error instanceof SessionSyncError && error.reason === 'source-offline' && decision.allowed) {
            throw new SessionSyncError('source-offline', `${sourceHostId} is offline and the cloud copy is behind the requested head.`)
          }
          throw error
        }
      }, request)
    },
    prepareCheckout: setup.prepareDispatchCheckout,
    claimSession: (sessionId, principal, isProject) => shares.claimSession(sessionId, principal, { shareWithOrganization: isProject }),
  }))
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
    sessionShell.attentionChanged(entries)
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
    if (clients.length) {
      const cursor = opts.sessionRuntime.eventCursor(event)
      events.publishToRoom({ kind: 'session', id: sessionId }, clients, 'session.eventReceived', { sessionId, event: projectedEvent, ...(cursor && { cursor }) })
    }
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
    if (event.status === 'running') sessionPusher?.running(event.sessionId)
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
  // A message-mode question was asked or settled, or the input that waits
  // changed between a permission and a question: the status is unchanged, so
  // nothing a turn's end does runs again. Only readers of the feed learn of it.
  opts.sessionRuntime.on('session-question', (event: HostEventMap['session.statusChanged']) => {
    events.broadcast('session.statusChanged', event)
  })
  // A separate topic: the activity changes many times in a turn, and nothing a status change does runs again for it.
  opts.sessionRuntime.on('session-activity', (event: HostEventMap['session.activityChanged']) => {
    events.broadcast('session.activityChanged', event)
  })
  opts.sessionRuntime.on('watchers-changed', (sessionId: string) => publishSessionPresence(sessionId))

  // Personal Uplink: the tunnel listener, the link to the control plane, and the
  // verifier for its grants. All three exist on every host; only a linked host uses them.
  // The workspace service has none of them (cloud-service-model.md §15): its one
  // verifier trusts the cloud issuer for `SOLUS_API_AUDIENCE`, and it never links.
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
  // An outside app's organization may allow only some apps, and a member's app stops when
  // the member loses access: the host acts for them only while it can renew their token (plans/035 §0.3).
  const memberAccessCache = new Map<string, number>()
  installAppAccessChecks({
    appDenial: (app, approver) => hostPolicies().forWork(approver.kind === 'member' ? approver.organizationId : LOCAL_POLICY_ORGANIZATION_ID).appDenial(app)?.message ?? null,
    memberHasAccess: async (approver) => {
      const key = `${approver.userId}:${approver.organizationId}`
      if ((memberAccessCache.get(key) ?? 0) > Date.now()) return true
      try {
        await delegations?.accessToken(approver.userId, { organizationId: approver.organizationId }, { kind: 'api' })
        if (!delegations) return false
        memberAccessCache.set(key, Date.now() + MEMBER_ACCESS_CHECK_MS)
        return true
      } catch {
        memberAccessCache.delete(key)
        return false
      }
    },
  })
  // A registration again under the same host id is a new generation with a new OAuth client.
  const registrationKey = (registration: HostRegistration | null) => registration ? `${registration.hostId}:${registration.generation}` : null
  let registeredKey = registrationKey(readStoredRegistration())
  let uplinkManager: UplinkLinkManager
  const followRegistration = (registration: HostRegistration | null): void => {
    if (apiMode) return
    tokenVerifier = tokenVerifierFor(registration)
    // A cloud machine's registration names the organization it works for (organization-scope §3, R9).
    adoptRegistration(registration)
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
    isDesktopApp: () => detectInstallKind() === 'desktop',
    holdsWork: async () => {
      // The index may still find sessions on this disk; an answer now could be wrong.
      if (sessionRecordsIndexing()) throw new HostRegistrationError('register-rejected', 'This server is still reading its session history. Try again in a moment.')
      return hasSessionRecords()
    },
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
    onOnline: (reason) => drainWebhooks(reason),
  })
  followRegistration(registrar.current())
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
    statusOf: (sessionId) => opts.sessionRuntime.statuses.liveActivityStatus(sessionId),
    registration: () => registrar.current(),
    credential: () => registrar.credential(),
    savePath: join(dataDir(), 'live-activities.json'),
  })
  registerLiveActivityHandlers(server, liveActivityRelay)
  const reportLiveActivityStatus = (event: HostEventMap['session.statusChanged']) => liveActivityRelay.sessionStatusChanged(event)
  opts.sessionRuntime.on('session-status', reportLiveActivityStatus)
  opts.sessionRuntime.on('session-question', reportLiveActivityStatus)
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
          sessionPusher?.signedOut()
          githubCredentials().forgetOwnerAccountCopy()
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
        sessionPusher?.established()
        // A person's client presented on this machine (a cloud machine has no local client):
        // rows that waited for someone to deliver them as go now, not at the next five-minute poll.
        runnerDelivery?.retryWaiting()
        if (scope !== 'personal') return
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
    sessionRemoteAccess = new DelegatedSessionRemoteAccess(() => registrar.current(), hostDelegations)
    sessionPusher = new SessionPusher({ repositories: sessionRepositories,
      access: sessionRemoteAccess,
      hostId: () => registrar.current()?.hostId ?? null })
    opts.sessionRuntime.dispatch.refusedHead = sessionId => sessionPusher?.refusedHead(sessionId) ?? null
    sessionPusher.resume()
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
    // A standing change (a share made, a policy edited) is the moment to ask for grants again.
    domainEventUnsubscribes.push(hostOrganizations.onChanged((standing) => {
      // Registered: the host's user becomes the owner's account, and its rows follow (U5).
      if (standing?.owner) {
        void followHostAccount(getDatabase(), standing.owner)
      }
      // The registration status names the account it belongs to.
      broadcastUplinkStatus()
      // The owner's client in this process presents its token again when a delegation is missing.
      localClient.standingChanged(standing?.owner?.userId ?? null)
    }))
    // Organization runs on a cloud machine (organization-vms §3, §4): the host acts
    // for the person behind each turn, and its tools use the Solus API as them.
    turnAdmission.delegations = hostDelegations
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
  // A webhook's `call_app` action runs an app mutation as the app's owner (docs/plans/apps.md §8).
  const webhooks = createWebhookServices(opts.sessionRuntime, webhookFacts, async ({ appId, operation, data, webhookId }) => {
    await apps.callOperation(appId, operation, webhookInput(data), { kind: 'webhook', webhookId }, null)
  })
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
  // The webhooks an app declares are ordinary webhook records, made when a version becomes active.
  const appWebhooks = new AppWebhooks(apps, webhookService)
  apps.addLifecyclePart(appWebhooks)
  registerAppHandlers(server, { apps, schedules: appSchedules, webhooks: appWebhooks, workflows: appWorkflows, signals: appSignals, modelCalls: appModelCalls, deployments: appDeployments, hostedContainers: hostedAppContainers, preflights: appPreflights })
  registerWebhookHandlers(server, {
    actions: webhooks.actions,
    receiver: webhooks.receiver,
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

  /** The person's choice of Tailscale Funnel, read at each repair, so a mapping made again keeps it (plans/035 §0.8). */
  const wantsFunnel = (): boolean => getServerSettings().tailscaleServe.funnel

  async function enableServe(port: number) {
    assertTailscaleServeAllowed(true, port)
    const previous = getServerSettings().tailscaleServe
    const status = await tailscaleServe.enable(port, actualPort, previous.enabled && previous.funnel)
    if (previous.enabled && previous.port !== port) {
      try { await tailscaleServe.disable(previous.port, actualPort) }
      catch (error) {
        await tailscaleServe.disable(port, actualPort).catch(() => {})
        throw error
      }
    }
    // What Tailscale now has: Funnel stays on only where the new port allows it.
    setTailscaleServe(true, port, status.funnel)
    tailscaleServe.startRepair(port, actualPort, (next) => { void events.broadcast('host.tailscaleServeChanged', next) }, wantsFunnel)
    void events.broadcast('host.tailscaleServeChanged', status)
    return status
  }

  async function setServeFunnel(enabled: boolean) {
    const setting = getServerSettings().tailscaleServe
    if (enabled) assertTailscaleServeAllowed(true, setting.port)
    if (!setting.enabled) throw new Error('Turn on Tailscale HTTPS for this host first.')
    const status = await tailscaleServe.setFunnel(enabled, setting.port, actualPort)
    setTailscaleServe(true, setting.port, status.funnel)
    log.info('tailscale_funnel_changed', { funnel: status.funnel, port: setting.port })
    void events.broadcast('host.tailscaleServeChanged', status)
    return status
  }

  const { server: http, requestListener, solusApiRouter, doors } = buildHttpServer({
    solusApi: { operations: refreshingSessionIndexOnList(workspaceOperations, () => opts.sessionRuntime.requestSessionIndexRefresh()), ...apiSettings },
    isVerifyingUpdate: () => server.isVerifyingUpdate,
    host,
    port,
    staticDir: opts.staticDir,
    name: hostDisplayName,
    getHost: () => host,
    getPort: () => actualPort,
    requireAuth: isCredentialRequired,
    isTrustedRequester: isTrustedRequesterAddress,
    allowRemoteAddress,
    isTunnelRequest,
    deviceHub: devices.hubProxy,
    sessionBundles: sessionBundleTransfers,
    // No pairing door on a cloud machine or the workspace service: a grant is the only credential there.
    pairingDisabled: credentialAlwaysRequired,
    pairApprovals,
    enableTailscaleServe: async (port) => ({ url: (await enableServe(port)).url }),
    isApiMode: apiMode,
    verifyAccessToken: verifyHostAccessToken,
    establishDelegation: establishPresented,
    // Every host admits its own guests (docs/plans/host-sharing.md §4.1).
    resolveShareSecret: (secret) => shares.resolveLinkSecret(secret),
    runner: {
      deliver: (runner, request) => applyRunnerDelivery(runner, request, {
        shares,
        onTranscriptChanged: (sessionId) => events.broadcast('session.transcriptChanged', { sessionId }),
        onExecutionChanged: (sessionId, runnerHostId, execution) => events.broadcast('session.executionChanged', { sessionId, runnerHostId, execution }),
      }),
    },
    transcribeAudio: opts.transcribeAudio,
    completeIntegrationOAuth: (params) => integrationOAuth.complete(params),
    webhookReceiver: apiMode ? undefined : webhooks.receiver,
    appService: apiMode ? undefined : new AppServiceApi({ deployments: appDeployments, apps, signals: appSignals, modelCalls: deploymentModelCalls }),
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
    // A new sign-in can change which models the account has.
    if (event.state === 'connected' && opts.sessionRuntime.getBackendIds().includes(event.provider)) {
      void refreshReportedModels(opts.sessionRuntime.backendFor(event.provider), seats.connectedSeat(event.seat, event.provider) ?? undefined)
    }
    // A member's seat just connected: their profile follows them here (plans/020 §4).
    if (event.state === 'connected' && event.seat.kind === 'user' && event.seat.userId.kind === 'account') {
      const target = memberProfileTarget(event.seat.userId.accountId)
      if (target) void profiles.pullQuietly(target)
    }
  }))
  // Boot, and every few minutes after: every person who keeps settings here, and the owner
  // of a linked host, gets their account's settings without a client's nudge.
  domainEventUnsubscribes.push(startPersonSettingsPulls(() => hostOrganizations.owner() ? [hostUserKey()] : []))
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
    if (!isHostSocketPath(request.url) && !allowRemoteAddress(request.socket.remoteAddress)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    if (!isHostSocketPath(request.url) && !serverTunnels.handleUpgrade(request, socket, head) && !devices.hubProxy.handleUpgrade(request, socket, head)) socket.destroy()
  })
  let ws = attachWebSocketTransport(http, server, {
    clientEvents,
    browserFrames,
    verifyAccessToken: verifyHostAccessToken,
    doors,
    requireAuth: isCredentialRequired,
    isTrustedRequester: isTrustedRequesterAddress,
    allowRemoteAddress,
    isTunnelRequest,
    responseBudget: responseReceiptBudget,
    onClientConnected: ({ clientId }) => {
      handlePresenceConnected(clientId)
      // A client that connects may list sessions started outside Solus.
      opts.sessionRuntime.requestSessionIndexRefresh()
    },
    onClientDisconnected: ({ clientId }) => {
      sessionShell.disconnected(clientId)
      prSync.dropConnection(clientId)
      handlePresenceDisconnected(clientId)
      workLive.disconnected(clientId)
      resourceTelemetry.unsubscribe(clientId)
      serverRegistry.unwatch(clientId)
      usageWatches.clientDisconnected(clientId)
      serverTunnels.disconnect(clientId)
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
        // A TCP server answers its address with a port; a pipe or a closed server does not.
        const address = z.object({ port: z.number() }).safeParse(http.address())
        return address.success ? address.data.port : nextPort
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
  // A harness on this host reaches its run's tools over loopback, whatever address the server binds.
  setAgentToolEndpointUrl(`http://127.0.0.1:${actualPort}/mcp`)
  const serveSetting = getServerSettings().tailscaleServe
  if (serveSetting.enabled && effectiveRemoteAccess() !== 'off') {
    void tailscaleServe.enable(serveSetting.port, actualPort, serveSetting.funnel).then(async () => {
      if (effectiveRemoteAccess() === 'off') await tailscaleServe.removeMappingsToPort(actualPort)
      else tailscaleServe.startRepair(serveSetting.port, actualPort, (status) => { void events.broadcast('host.tailscaleServeChanged', status) }, wantsFunnel)
    })
      .catch((error) => log.warn('tailscale_serve_start_failed', { error: error instanceof Error ? error.message : String(error) }))
  }

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
    else if (!serverTunnels.handleUpgrade(request, socket, head) && !devices.hubProxy.handleUpgrade(request, socket, head)) socket.destroy()
  })
  // The workspace service has no tunnel and no link to resume (cloud-service-model.md §15).
  if (!apiMode) {
    tunnelPort = await bindTunnelListener(tunnelHttp, readStoredTunnel()?.proxiedPort ?? DEFAULT_TUNNEL_LISTENER_PORT)
    // A policy that turns the tunnel off keeps a stored link from resuming (plans/030 §6.7).
    void registrar.resumeUntilAnswered(async (remote, isRetrying) => {
      // A policy that turns the tunnel off does not stop a link at the host's own address, which has no tunnel.
      if (hostPolicies().hostSetting('cloudTunnel')?.value === false && !uplinkManager.isReachedDirectly()) return
      await uplinkManager.resume(remote, isRetrying)
      // A personal host that enrolled at this boot is linked as one that a person registers is: at its first registration.
      // A cloud machine with no link asks by itself (`UplinkLinkManager.resume`).
      if (enrolledAtBoot && !enrolledAtBoot.organizationId && !uplinkManager.currentTunnel()) {
        await uplinkManager.link().catch((error) => uplinkManager.noteLinkFailure(error instanceof Error ? error.message : String(error)))
      }
    }).catch((err) => {
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
  if (isLanDiscoveryDisabled() || effectiveRemoteAccess() === 'off') {
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

  async function rebind(remoteAccess: RemoteAccessMode): Promise<void> {
    if (remoteAccess === 'off') {
      tailscaleServe.stopRepair()
      await tailscaleServe.removeMappingsToPort(actualPort)
    }
    const next = resolveEffectiveServerOptions({ host: opts.host, requireAuth: opts.requireAuth, remoteAccess, ...remoteBindOptions() })
    const nextRequireAuth = next.requireAuth
    if (next.host === host && nextRequireAuth === requireAuth && remoteAccess === boundRemoteAccess) return
    host = next.host
    requireAuth = nextRequireAuth
    boundRemoteAccess = remoteAccess
    lock?.release()
    // Existing WS connections (including the one carrying this very toggle)
    // keep the plain http.close() callback from ever firing, since Node waits
    // for all live sockets to end on their own. Force them closed first.
    prSync.dropClients()
    try { ws.close() } catch (err) { log.warn('ws_close_failed_during_rebind', { error: err instanceof Error ? err.message : String(err) }) }
    await new Promise<void>((resolve) => http.close(() => resolve()))
    actualPort = await listenWithRetries(actualPort)
    setAgentToolEndpointUrl(`http://127.0.0.1:${actualPort}/mcp`)
    const serveSettingAfterBind = getServerSettings().tailscaleServe
    if (remoteAccess !== 'off' && serveSettingAfterBind.enabled) {
      void tailscaleServe.enable(serveSettingAfterBind.port, actualPort, serveSettingAfterBind.funnel)
        .then(async () => {
          if (effectiveRemoteAccess() === 'off') await tailscaleServe.removeMappingsToPort(actualPort)
          else tailscaleServe.startRepair(serveSettingAfterBind.port, actualPort, (status) => { void events.broadcast('host.tailscaleServeChanged', status) }, wantsFunnel)
        })
        .catch((error) => log.warn('tailscale_serve_rebind_failed', { error: error instanceof Error ? error.message : String(error) }))
    }
    ws = attachWebSocketTransport(http, server, {
      clientEvents,
      browserFrames,
      verifyAccessToken: verifyHostAccessToken,
      doors,
      requireAuth: isCredentialRequired,
      isTrustedRequester: isTrustedRequesterAddress,
      allowRemoteAddress,
      isTunnelRequest,
      responseBudget: responseReceiptBudget,
      onClientConnected: ({ clientId }) => {
        handlePresenceConnected(clientId)
        opts.sessionRuntime.requestSessionIndexRefresh()
      },
      onClientDisconnected: ({ clientId }) => {
        sessionShell.disconnected(clientId)
        prSync.dropConnection(clientId)
        handlePresenceDisconnected(clientId)
        workLive.disconnected(clientId)
        resourceTelemetry.unsubscribe(clientId)
        serverRegistry.unwatch(clientId)
        usageWatches.clientDisconnected(clientId)
        serverTunnels.disconnect(clientId)
      },
      onClientExpired: ({ clientId }) => {
        opts.sessionRuntime.watchers.handleClientExpired(clientId)
        void browserRegistry.dropClient(clientId)
        devices.dropClient(clientId)
      },
    })
    lock = acquireLock(host, actualPort)
    if (!lock) log.warn('lock_acquisition_failed_after_rebind')
    log.info('server_rebound', { host, port: actualPort, requireAuth: isCredentialRequired() })
  }
  // A policy change applies at once (plans/030 §5.2): the bind moves, the tunnel closes, telemetry export follows.
  policyStore.onChanged(() => {
    const settings = getHostConfig()
    if (previewTunnelEnabled !== settings.config.previewTunnelEnabled) publishHostConfig(settings)
    hostUpdates.refreshInstallations()
    void rebind(effectiveRemoteAccess()).catch((error) => log.warn('policy_rebind_failed', { error: error instanceof Error ? error.message : String(error) }))
    if (hostPolicies().hostSetting('cloudTunnel')?.value === false && uplinkManager.status().linked) {
      void uplinkManager.unlink().catch((error) => log.warn('policy_tunnel_close_failed', { error: error instanceof Error ? error.message : String(error) }))
    }
    void configureOtel(getHostConfig().config.otel, hostPolicies().hostSetting('otel') !== null).catch((error) => log.warn('policy_otel_configure_failed', { error: error instanceof Error ? error.message : String(error) }))
  })

  // Every admitted socket may present the person's account token: renewal and `accountPresent` keep their delegation (ADR 0001 §6 item 5).
  registerAuthHandlers(server, establishPresented ? { verify: verifyHostAccessToken, establish: establishPresented } : null)
  registerRemoteMachinesHandlers(server, { provisioner: sshProvisioner, wslProvisioner, listWslDistros: () => listWslDistros(runDeviceCommand), forwardedHosts, ssh, hostName: hostDisplayName, broadcast: (topic, payload) => events.broadcast(topic, payload) })
  registerConnectionsHandlers(server, {
    getServerInfo: () => ({
      host,
      port: actualPort,
      allowLan: !isLoopbackHost(host),
      remoteAccess: effectiveRemoteAccess(),
      requireAuth: isCredentialRequired(),
      trustLocalNetwork: effectiveTrustLocalNetwork(),
      hostKind: hostKind(),
      roles: [...roles],
    }),
    tunnelUrl: tunnelOrigin,
    mirrorOrigin: async (resource) => {
      if (resource.kind !== 'session' || !(await publishedDestination(resource.id))) return null
      return registrar.current()?.directoryUrl ?? null
    },
    getActiveSessions: () => [...ws.sessions.values()].map(s => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      deviceId: s.deviceId,
      isActingHost: s.isActingHost,
      connectedAt: s.connectedAt,
    })),
    discoverLanServers: () => lanDiscovery.discoverServers(),
    introducedHosts,
    disconnectRemoteHost: (hostId) => remoteHosts.disconnect(hostId),
    onIntroduced: meshHosts,
    setRemoteAccess: async (remoteAccess) => {
      const next = setRemoteAccess(remoteAccess)
      await rebind(next.remoteAccess)
      return { ...next, host, port: actualPort, allowLan: !isLoopbackHost(host), requireAuth: isCredentialRequired() }
    },
    getTailscaleServe: () => {
      const setting = getServerSettings().tailscaleServe
      return tailscaleServe.status(setting.enabled, setting.port, actualPort)
    },
    enableTailscaleServe: enableServe,
    setTailscaleFunnel: setServeFunnel,
    publicAddress: () => getHostConfig().config.publicAddress,
    disableTailscaleServe: async () => {
      const setting = getServerSettings().tailscaleServe
      assertTailscaleServeAllowed(false, setting.port)
      await tailscaleServe.disable(setting.port, actualPort)
      setTailscaleServe(false, setting.port)
      const status = await tailscaleServe.status(false, setting.port, actualPort)
      void events.broadcast('host.tailscaleServeChanged', status)
      return status
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
    // One second for the answer of the registration to reach its caller, whose connection ends too.
    onBecameCloudMachine: () => { setTimeout(() => ws.disconnectWhere((principal) => principal.kind === 'owner', 'became-cloud-machine'), 1_000).unref() },
    selfTest: createHostSelfTest({
      installationId: getInstallationId,
      status: uplinkStatus,
      isReachedDirectly: () => uplinkManager.isReachedDirectly(),
      isTunnelTurnedOffByPolicy: () => hostPolicies().hostSetting('cloudTunnel')?.value === false,
      boundPort: () => tunnelPort,
      connector: () => uplinkConnector.inspect(),
      exitNode: readTailscaleExitNode,
    }),
  })

  log.info('server_listening', { host, port: actualPort })
  console.log(`\n  Solus web UI → http://localhost:${actualPort}\n`)
  // Once the address is known: a machine held since the last start joins the others.
  meshHosts()

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
        await tailscaleServe.shutdown(actualPort).catch((error) => log.warn('tailscale_serve_shutdown_failed', { error: error instanceof Error ? error.message : String(error) }))
        setHostPairingTools(null)
        remoteHosts.close()
        const closeForwardedHosts = forwardedHosts.closeAll()
        introducedHosts.dispose()
        stopAutomationScheduler()
        appSchedules.stop()
        appWorkflows.stop()
        appFiles.dispose()
        stopMetricsRollover()
        prSync.stop()
        prWatcher.stop()
        resourceTelemetry.stop()
        serverRegistry.stop()
        serverTunnels.close()
        hostUpdates.stop()
        modelProfiles.stop()
        modelPrices.stop()
        remoteUpdates.stop()
        stopSupervisor?.()
        codeIntel.dispose()
        await Promise.all([closeForwardedHosts, claudeAppProcesses.closeAll()])
        appRunners.dispose()
        devices.runs.dispose()
        await devices.manager.dispose()
        await devices.bridge.stop()
        for (const unsubscribe of domainEventUnsubscribes) unsubscribe()
        clearInterval(seatSweepTimer)
        await seatConnector.stopAll()
        // Before the gateway closes its processes: a host stop is not the end of an MCP task (§12.4).
        mcpTasks.stop()
        resourceWatches.stop()
        await integrationGateway.close()
        agentAuth.stopAll()
        await lanDiscovery.close()
        transcriptMirror.dispose()
        hostOrganizations.stop()
        await managedHostActivity.stop()
        liveActivityRelay.stop()
        await sessionDigests.settled()
        await executionRecorder.settled()
        await runnerDelivery?.stop()
        // A registration check still retrying could start cloudflared again after it stops.
        registrar.stopResuming()
        await uplinkConnector.stop()
        prSync.dropClients()
        try { ws.close() } catch (err) { log.warn('ws_close_failed', { error: err instanceof Error ? err.message : String(err) }) }
        await new Promise<void>((resolve) => http.close(() => resolve()))
        await new Promise<void>((resolve) => tunnelHttp.close(() => resolve()))
        await workStorageRuntime.stop()
        await sessionArchive.stop()
        await sessionPusher?.stop()
        await sessionBundleTransfers.stop()
        await closeDatabaseForShutdown()
        lock?.release()
      })()
      return shutdownPromise
    },
  }
}
