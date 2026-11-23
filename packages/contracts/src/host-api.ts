import type { HostPairRequest, HostPairingsSnapshot, HostClientPairing } from './host-pairing'
import type { TaskDetailsRead, TaskProviderRead, TaskReadOptions } from './task-read'
import type { VaultKeyRef, VaultKeySave, VaultKeyStatus } from './vault-keys'
import type { PrReactionContent, PrReactions, PrUrlInspection } from './pr-social'
import type { RepoRef } from './providers'
import type { TaskInvolvement, TaskProviderData, TaskReactionContent, TaskTemplate, TaskExternalIssue } from './task-data'
import type { RunningServer, StopRunningServerResult, RunningServerTunnel, NativeServerForward, NativeServerForwardRequest } from './running-servers'
import type { VoiceTranscriptionOptions } from './voice-dictionary'
import type { VoiceTranscript, VoicePartial, VoiceStreamRequest, VoiceStreamFeedRequest, VoiceWarmRequest } from './voice-stream'
import type { ProviderInstancesSnapshot, ProviderInstancesWrite, ProviderInstanceTarget, ProviderInstanceCode, ProviderInstanceStatus } from './provider-instances'
import type { SessionSuggestion, SessionSuggestRequest, SuggestionDecision } from './session-suggestions'
import type { SessionQueueMutation, SessionQueueSnapshot } from './session-queue'
import type { CheckoutSnapshot } from './checkout'
import type { HostResources, HostTelemetry } from './host-resources'
import type { WorktreeOfferResolution } from './activity'
import type { BrowserRuntimeStatus } from './browser-runtime'
import type { ExternalCommentCommand, WorkExternalComments } from './work-comments'
import type { WorkCommentCommand } from './comment-commands'
import type { AgentId, AgentTaskLifecyclePolicy, AgentUsageLimits, IpcContext, PromptOptions, PromptDispatchResult, Attachment, SessionMeta, SessionGeneratedMetadata, SessionMetadataGenerationContext, RecentProject, DetectedEditor, DetectedTerminal, ResolvedTerminal, TerminalAppId, OpenInEditorRequest, FilePreviewRequest, FilePreviewResult, ProjectContentSearchRequest, ProjectContentSearchResult, ProjectFilesRequest, ProjectFilesResult, ProjectFileMutationRequest, ProjectFileMutationResult, WriteFileRequest, WriteFileResult, FileMatch, DirectoryListResult, CreateDirectoryResult, HostPathMutation, HostPathMutationResult, PluginCommandsResult, RemoteSkill, SkillInstallResult, GitCheckout, TurnSnapshot, DiffResult, DiffFileContentsRequest, DiffFileContentsResult, ChangedFileStat, WorktreeEntry, BranchRef, GitActionRequest, GitActionResult, GitDiscardResult, GitSyncResult, GitCheckoutBranchResult, GitIdentity, GitState, GitStateOptions, GitRepositoryStatus, GitInitRepositoryResult, GithubPublishRepositoryRequest, GithubPublishRepositoryResult, ProjectConfig, ProjectEntry, ProjectIdentity, DispatchHistoryRoot, PlanDescriptor, PlanAnnotations, DiffRequest, RateLimitDecisionAction, RuntimeSessionInfo, SessionDescription, SessionProviderSwitchResult, AcceptPlanRequest, AcceptPlanResult, WatchSessionInput, WatchSessionResult, ThreadGoal, ThreadGoalSetRequest, Work, WorkListingMeta, WorkMeta, WorkType, WorkAnnotations, WorkRevision, WorkRevisionSummary, WorkExportRequest, WorkExportResult, SessionRecord, SessionRecordUpsert, SessionRecordListFilter, SessionRecordList, SessionRecordSearchQuery, SessionRecordSearch, PinnedSession, AppGlobalShortcuts, SetAppGlobalShortcutsResult, StartInfo, Automation, AutomationAction, AutomationRun, AutomationRunPoint, AutomationTrigger, AuthStatus, PrCheckoutContext, PrReviewContext, MergeMethod, PrMergeResult, PrConflictResolutionResult, HostCapabilities, DiscoveredServer, SetupAgent, SetupAdoptProjectResult, SetupAgentAuthCheckResult, SetupCloneProjectRequest, SetupCloneProjectResult, SetupSyncProjectRequest, SetupGithubReposResult, SetupSshAccessResult, SetupStepResult, HostReadiness, GitCommitIdentity, VoiceModelStatus, HeadlessSessionRequest, HeadlessPromptRequest, GithubDelegatedCredential, OtelSettings, OtelSettingsSnapshot, TextGenerationSettings, TextGenerationSettingsSnapshot, ProviderId, ModelProfilesStatus, IgnoredProjectFiles, WorktreeIncludeChange, CopiedProjectFile } from './types'
import type { PrDiffFileContents, PrDiffFileContentsRequest, PrDiffRequest, PrDiffSlice, PrFilter, PrFilterChoice, PrFilterField, PrInterest, PrLabel, PrListPage, PrProjectCursor, PrProjectListing, PrPendingWorkflowRuns, PrRevertResult, PrStackMergeRequest, PrStackMergeResult, PrStateAction, PrViewedFileChange, PrViewedFiles, PrWorkflowApprovalResult, PrSyncChange, PrReviewer, PrReviewerCandidate, PrReviewerKind, PrReviewTarget, PrStack, PullRequest, PullRequestOverview, PullRequestUpdate, ReviewThread, ReviewComment, PrCommit, PrConversationItem, DraftReview, ProviderRepository, ProviderViewer } from './providers'
import type { TaskSource } from './task-sources'
import type { PrepareSessionTaskRequest, PrepareSessionTaskResult, SessionExecutionHost, Task, TaskAssigneeCandidate, TaskAttachments, TaskCommentHit, TaskCommentSearchQuery, TaskCreateInput, TaskDetails, TaskForSessionResult, TaskLinkInput, TaskLinkKind, TaskLinkTarget, TaskLinkedTask, TaskMoveTarget, TaskSessionLink, TaskSessionRole, TaskSidebarFilter, TaskSidebarSnapshot, TaskSnapshot, TaskSnooze, TaskSourceOptions, TaskSourceState, TaskSummary, TaskUpdatePatch } from './task-types'
import type { OutboxApplyResult, OutboxOp } from './outbox-types'
import type { SessionPullRequestLink, SessionPullRequestWatchOutcome } from './session-pull-requests'
import type { SessionArtifacts } from './session-artifacts'
import type { SessionMergeBackPrompt, SessionTree } from './session-digest'
import type { SessionChange, SessionChanged } from './session-state'
import type { ListMySessionsResponse, SessionTurnDiff } from './session-repositories'
import type { WorkspaceProject, WorkspaceProjectAddRequest, WorkspaceProjectPatch } from './workspace-projects'
import type { SessionSubagentRequest, SessionHistoryPageRequest, SessionHistoryPage, SessionMessageWindow, SessionMessageWindowRequest, SessionPreviewResult, WireSessionLoadMessage, SessionToolInputsRequest, SessionToolInput } from './session-history'
import type { AttentionEntry } from './attention-types'
import type { ReviewContext, ReviewGuide, ReviewState, ReviewGuideStatusEvent, ReviewGuideRequestOptions, PrGuideMetadata, PrGuideMetadataRequest, PrGuideStatusRequest, ReviewGuideTarget, ReviewTarget, ReviewLensSnapshot, ReviewLensGenerateRequest, ReviewLensEditRequest, ReviewLensCommentChange, ReviewLensCommentsResult } from './review'
import type { PrChecksSnapshot } from './checks-rpc-types'
import type { AssetCreateUrlRequest, AssetCreateUrlResult, AssetFindUrlRequest, AssetFindUrlResult, AssetUploadRequest, AssetUploadResult, AttachmentUploadRequest, AttachmentUploadTokenRequest, AttachmentUploadTokenResult } from './rpc'
import type { MetricsNlCompileResult, MetricsQueryResult, MetricsQuerySpec, MetricsSchema, MetricsSessionSummary, MetricsSqlValidation, MetricsTurnFilter, MetricsTurnPageRequest, MetricsTurnPageResult, MetricsTurnListingSummary, MetricsTurnTrace, MetricsValue, SavedMetricsQuery, TurnFlag, TurnFlagKind } from './observability-types'
import type { ClientNotificationRequest, NotificationSoundLog } from './notification-types'
import type { ShareDialogLog } from './sharing'
import type { NotificationCount, NotificationHubCapability, NotificationListRequest, NotificationPage, NotificationSetArchived, NotificationSetRead, NotificationStateResult } from './notification-hub'
import type { BrowserAnnotateOp, BrowserAnnotationState, BrowserAnnotationTool, BrowserAppearance, BrowserDialogAnswer, BrowserPageDialog, BrowserCaptureRequest, BrowserCloseResult, BrowserCookieImportRequest, BrowserCookieImportResult, BrowserCookieSourceScan, BrowserDetachReason, BrowserDiscoveredTarget, BrowserEvidence, BrowserEvidenceOptions, BrowserFrameCaps, BrowserInteractOp, BrowserInteractResult, BrowserNavigateOp, BrowserOpenRequest, BrowserPage, BrowserProfileSet, BrowserRecordingResult, BrowserRecordingState, BrowserRecordingStopRequest, BrowserSnapshot, BrowserSnapshotOptions, BrowserSurfaceReport, BrowserViewportRequest } from './browser-types'
import type { DeviceActionRequest, DeviceHostConfig, DeviceBuild, DeviceInstallRequest, DeviceProjectInfo, DeviceRun, DeviceSigningTeam, DeviceRunLog, DeviceRunStartRequest, DeviceCloseRequest, DeviceConfigureRequest, DeviceControlRequest, DeviceControlResult, DeviceDetail, DeviceHostTestResult, DeviceOpenRequest, DevicePreview, DeviceScreenshotRequest, DeviceScreenshotResult, DeviceShutdownRequest, DeviceState, DeviceStreamUrl, DeviceTarget, DeviceToolUpdateRequest, SshDeviceHostConfig } from './device-types'
import type { AtlassianApiTokenConnectResult, AtlassianApiTokenInput, AtlassianJiraProject, AtlassianOAuthStartResult, AtlassianStatus } from './atlassian'
import type { McpAppCallRequest, McpAppLiveDocument, McpAppLiveRequest, McpAppModelContextRequest, McpAppRequest, McpAppResourceRequest, McpAppSnapshot, McpAppToolInfo, McpAppToolRequest } from './mcp-apps'
import type {
  AppAgentAccessRequest, AppUpdateRequest, AppBuildLog, AppConfigSetRequest, AppCallDetail, AppCallReadRequest, AppCallStats, AppCallStatsRequest, AppCallRequest, AppCallsRequest, AppCallView, AppDeployReceipt, AppDeployRequest,
  AppFileRequest, AppFileView, AppMetrics, AppRequest, AppRevisionDiff, AppRevisionRequest, AppRevisionView, AppStepSource, AppStepSourceRequest, AppRunDetail, AppRunRequest, AppRunsRequest, AppRunView,
  AppDeployPreflight, AppDeployPreflightRequest, AppScheduleCalendar, AppScheduleCalendarRequest, AppScheduleRequest, AppScheduleSetRequest, AppScheduleView, AppSecretSetRequest, AppSessionLink, AppSessionRequest, AppSignalActionRequest, AppSignalActionSaveRequest,
  AppSignalOccurrence, AppSignalOccurrencesRequest, AppSignalView, AppState, AppSummary, AppUi, AppVersionDiff, AppVersionRequest, AppVersionView, AppWebhookRequest, AppWebhookView,
} from './apps'
import type { AppModelCallRequest, AppModelCallView, AppModelCallsRequest } from './app-models'
import type {
  AppContainerAddress,
  AppContainerLogsRequest,
  AppContainerManageAnswer,
  AppContainerManageRequest,
  AppContainerRequest,
  AppContainerRunRequest,
  AppContainerState,
  AppDeploymentLogsRequest,
  AppDeploymentView,
  AppPublishPlaces,
  AppPublishReceipt,
  AppPublishRequest,
  AppTailscaleKeySetRequest,
} from './app-deployments'
import type { CodeIntelDocsRequest, CodeIntelDocsResult, CodeIntelInstallRequest, CodeIntelInstallResult, CodeIntelReferencesRequest, CodeIntelReferencesResult, CodeIntelReindexRequest, CodeIntelReindexResult, CodeIntelStatus, CodeIntelStatusRequest, CodeIntelSymbolRequest, CodeIntelSymbolResult } from './code-intel'
import type { DocDestination, DocProviderId, DocProviderStatus, PlanPublishRequest, WorkExternalLink, WorkPublishRequest, WorkPublishResult, WorkPullResult } from './docs'
import type { GoogleAuthStatus } from './google-auth'
import type { HostConfigPatch, HostConfigSnapshot, TypeSafeKeyStatus } from './host-config'
import type { AccountSettingsPatchRequest, AccountSettingsResponse, ExecutionPreferences } from './settings'
import type { HostPoliciesResponse, HostPolicyAssignRequest, HostPolicyCreateRequest, HostPolicySummary, OrganizationPolicyResponse, PolicyHost, PolicyWriteRequest } from './policy-api'
import type { PolicySet } from './policy'

import type { AccountState, CreateManagedHostOutcome, SignInEnd } from './account-types'
import type { ConnectionTokenResource } from './auth/clients'
import type { SolusApiRequest, SolusApiResponse } from './solus-api/request'
import type { DesktopUpdateStatus } from './desktop-update-types'
import type { HostUpdateStatus } from './host-update-types'
import type { Permission } from './permissions'
import type { LiveActivityRegistration } from './live-activity'
import type {
  HostWebhookSettings,
  HostWebhookSettingsPatch,
  Webhook,
  WebhookCreateInput,
  WebhookDelivery,
  WebhookDeliveryQuery,
  WebhookDeliverySummary,
  WebhookDryRunRequest,
  WebhookDryRunResult,
  WebhookUpdateInput,
  WebhookWithUrl,
} from './webhooks'
import type { WebhookAdminList, WebhookAdminOutcome, WebhookAdminRef } from './webhook-admin'
import type { AccountResponse, HostKind, ManagedHostLifecycle, ManagedHostSpecChangeRequest, ManagedHostSpecRequest, OrganizationDirectory, UplinkDirectory, UplinkEnrollmentTicket, HostRegistrationRequest, UplinkStatus } from './uplink'
import type { HostRoute } from './host-routes'
import type { HostSelfTest } from './host-connection'
import type { HostListing } from './host-list'
import type { AccountDocumentName, AccountDocumentRequest, AccountDocumentResult } from './account-documents'
import type { ForwardedHost, SshAddLink, SshAddRequest, SshAddResult, SshTargetCandidate, WslAddRequest, WslDistroList } from './remote-machines'
import type { WorkLiveAwarenessRequest, WorkLiveCloseRequest, WorkLiveOpenRequest, WorkLiveOpenResult, WorkLivePushRequest, WorkLivePushResult } from './work-live'
import type { WorkReview, WorkReviewDecide, WorkReviewInboxItem, WorkReviewRequest, WorkReviewStateEntry } from './work-review'
import type { ShareLink, ShareList, ShareResource, ShareRole, ShareSetLinkRequest, ShareSetRequest } from './sharing'
import type { SessionActionLeaf } from './permissions'
import type { HostOrganizationsStatus } from './organization-scope'
import type { WorkTransfer } from './work-transfer'
import type { AgentAuthFlowRequest, AgentAuthMcpTarget, AgentAuthStartResult, AgentAuthSubmitRequest, AgentAuthTarget } from './agent-auth'
import type { McpTask, McpTaskAnswerRequest, McpTaskIdRequest, McpTaskListRequest } from './integrations/mcp-task'
import type { IntegrationResourceWatchListRequest, IntegrationResourceWatchStopRequest, ResourceWatch } from './integrations/resource-watch'
import type { CatalogPage, Integration, IntegrationCatalogListRequest, IntegrationConnectCancelRequest, IntegrationConnection, IntegrationConnectStartRequest, IntegrationConnectStartResult, IntegrationConnectSubmitRequest, IntegrationCreateRequest, IntegrationAccountRequest, IntegrationFacts, IntegrationFoundAddRequest, IntegrationFoundAddResult, IntegrationFoundChangeRequest, IntegrationFoundChangeResult, IntegrationDiscoverRequest, IntegrationFoundListRequest, IntegrationDiscovery, IntegrationFoundTestRequest, IntegrationFoundTestResult, FoundServerList, IntegrationIdRequest, IntegrationProcessStartRequest, IntegrationProbeRequest, IntegrationProbeResult, IntegrationResourceAttachRequest, IntegrationResourceListRequest, IntegrationResourceLists, IntegrationToolSummary, IntegrationUpdateRequest } from './integration-types'
import type { IntegrationPromptGetRequest, IntegrationPromptList, IntegrationPromptListRequest, IntegrationPromptText } from './integrations/prompts'
import type { SeatConnectCodeRequest, SeatConnectStartResult, SeatConnectTokenRequest, SeatProviderRequest, SeatRemoveRequest, SeatStatus } from './seats'
import type { AccountAgentProfilePatchRequest, AccountAgentProfileResponse, AgentProfileCopy, AgentProfileStatus } from './agent-profile'
import type { VaultSaveKeyRequest, VaultConnectRequest, VaultConnectResult, VaultConnection, VaultDisconnectRequest } from './vault'
import type { PresenceSetComposingRequest, PresenceSetEditingRequest, PresenceSetFocusRequest, PresenceSnapshotResult } from './presence'
import type { User } from './user'
import type { RpcPlane } from './rpc-planes'

/** A host this host paired with, so its agents can start sessions there (docs/plans/cross-host-sessions.md §10). The token never leaves the host. */
/** A host this host was introduced to, so its agents start sessions there with no account (docs/plans/host-reach.md §4). */
export interface IntroducedHost {
  installationId: string
  label: string
  url: string
  /** The host's identity key, from its introduction. */
  identityKey: string
  introducedAt: number
}

export interface IntroducedHostsSummary {
  hosts: IntroducedHost[]
  /** Hosts the person forgot here; no client introduces them again until they are allowed. */
  refused: Array<{ installationId: string; label: string }>
}

/** A token one host issued for another, as a client hands it over (host-reach.md §4.1). */
export interface HostIntroduction {
  installationId: string
  label: string
  /** Where the issuing host may be reached, the widest reach first. */
  urls: string[]
  sessionToken: string
  /** The device the token is, on the issuing host. */
  deviceId: string
  /** The issuing host's identity key: the receiving host sends the token only where this key signs (docs/plans/host-routes.md D3). */
  identityKey: string
}

/** How this host is reached and who this client is to it. */
/** A time the host's event loop stopped for 5 s or more (CPU starved or long sync work).
 *  A client cannot tell this from a network drop, so the host tells it after it recovers. */
export interface HostEventLoopStall {
  /** When the host saw the stall end, in ms since the epoch on the host's clock. One stall has one value. */
  endedAt: number
  durationMs: number
  /** The host's one-minute load average, to one decimal. Absent where the OS has none (Windows). */
  loadAverage?: number
  cpuCount: number
}

export type RemoteAccessMode = 'off' | 'private' | 'any'

export interface TailscaleServeStatus {
  enabled: boolean
  port: number
  state: 'off' | 'ready' | 'active' | 'other' | 'error'
  url: string | null
  error: string | null
}

/** A device this host paired (plans/033 §4.4), as the Access tab lists it whether it is connected or not. */
export interface PairedDevice {
  deviceId: string
  deviceLabel: string
  pairedAt: number
  /** When the host last admitted its token; it expires thirty days after this. */
  lastSeenAt: number
  /** Set once the owner revoked it. A revoked device pairs again as a new device. */
  revokedAt: number | null
}

export interface ConnectionsServerInfo {
  /** Account-owned integration settings; absent for signed-out local access. */
  accountConnectionsUrl?: string
  host: string
  port: number
  allowLan: boolean
  installationId: string
  /** Where other machines reach this host (docs/plans/host-routes.md D2); a client saves them as `host` routes. */
  routes: HostRoute[]
  /** A cloud VM without a usable tailnet address needs a connection hint. */
  cloudWithoutTailnet?: boolean
  tailscaleServe?: TailscaleServeStatus
  /** MagicDNS SSH destination for an editor on the client machine. Absent when SSH is not available. */
  sshTarget?: { host: string; user: string }
  /** The host's identity key (D3); a client that has none saves it. Absent on an organization's workspace service, which is not a machine and is reached only over `https:`. */
  identityKey?: string
  remoteAccess: RemoteAccessMode
  requireAuth: boolean
  trustLocalNetwork: boolean
  /** `managed` when Solus cloud provisioned this host (managed-hosts.md §1): the link is system-owned and pairing does not exist;
   *  `cloud` for an organization's workspace service (cloud-service-model.md), which is not a machine. */
  hostKind: HostKind
  /** The planes this host serves (cloud-service-model.md §1). A host without `execution` runs no agent: a client keeps it out of its execution targets. */
  roles: RpcPlane[]
  /** What this host loaded (plans/030): the MDM policy's source and fingerprint, and each cloud policy's revision, so `solus policy show` can compare. */
  policy?: {
    mdmSource: string | null
    mdmFingerprint: string | null
    cloud: Array<{ organizationId: string; kind: 'organization' | 'host'; revision: number | null }>
  }
  /** How this client was admitted; only a `local-owner` may change how the host is reached. */
  principal: 'local-owner' | 'remote-owner' | 'org-member' | 'guest' | 'runner' | 'system'
  /** The user key of the caller: the account behind a grant-admitted client, or the host's user on a local connection (plans/012 §1). */
  userId?: string
  /** The person the host names this client as, on their prompts, answers, and in the room (plans/012 §1). Absent for a runner and the host itself. */
  user?: User
  /** The organization an `org-member` reached this host through; the share dialog reads its directory. */
  organizationId?: string
  /** The name the host shows other people for a grant-admitted client. */
  displayName?: string
  /** A guest's one resource and its role there; the guest shell renders nothing else.
   *  A task resource reaches the task page and every session and work linked to it. */
  share?: { resource: ShareResource; role: ShareRole; actions?: readonly SessionActionLeaf[] }
  /** The permissions this connection holds on the host (docs/plans/permissions.md): prefixes, `['host']` for the owner. A control is disabled exactly when its permission is not covered. */
  permissions: Permission[]
  /** `preparing` while the host is still making this member's Linux user and folders (docs/plans/member-isolation.md §8.1): their turns are refused until `connection.memberWorkspaceReady`. Absent when ready, and for everyone who is not such a member. */
  memberWorkspace?: 'preparing'
  /** The last stall of 5 s or more, when the host saw it in the last 5 minutes. Absent from an older host. */
  recentEventLoopStall?: HostEventLoopStall
}

export interface LocalConnectionInfo {
  port: number
  token: string
  installationId: string
}

// Renderer-facing surface. The desktop renderer builds this API over WebSocket
// in `src/client-core`; preload now exposes only the native shell residue below.
export interface SolusAPI {
  start(): Promise<StartInfo>
  serverGetCapabilities(): Promise<HostCapabilities>
  /** Subscribe to a session's events. Resolves identity: the answer may differ
   *  from the argument when another client already named this provider thread. */
  watchSession(input: WatchSessionInput): Promise<WatchSessionResult>
  unwatchSession(sessionId: string): Promise<void>
  prompt(ctx: IpcContext, options: PromptOptions): Promise<PromptDispatchResult>
  sessionPrepare(request: import('./rpc').SessionPrepareRequest): Promise<import('./rpc').SessionPrepareResult>
  sessionRepositoryBundle(request: import('./rpc').SessionRepositoryBundleRequest): Promise<import('./rpc').SessionRepositoryBundleResult>
  sessionRepositoryBundleChunk(request: import('./rpc').SessionRepositoryBundleChunkRequest): Promise<import('./rpc').SessionRepositoryBundleChunkResult>
  retry(ctx: IpcContext, options: PromptOptions): Promise<void>
  sessionQueue(ctx: IpcContext): Promise<SessionQueueSnapshot>
  sessionQueueChange(ctx: IpcContext, mutation: SessionQueueMutation): Promise<SessionQueueSnapshot>
  /** The session's suggestions: all of them to someone who may prompt it, a guest's own to that guest. */
  sessionSuggestions(ctx: IpcContext): Promise<SessionSuggestion[]>
  sessionSuggest(ctx: IpcContext, request: SessionSuggestRequest): Promise<SessionSuggestion>
  sessionSuggestionWithdraw(ctx: IpcContext, suggestionId: string): Promise<boolean>
  /** Send runs the suggestion as the caller's own turn, with this call's context; dismiss removes its files. */
  sessionSuggestionDecide(ctx: IpcContext, suggestionId: string, decision: SuggestionDecision): Promise<boolean>
  switchSessionAgent(sessionId: string, provider: AgentId, agentSessionId?: string | null): Promise<SessionProviderSwitchResult>
  saveFileDialog(defaultName: string, content: string): Promise<string | null>
  openExternal(url: string, options?: { hideAppAfterOpen?: boolean }): Promise<boolean>
  openInFileManager(path: string): Promise<boolean>
  openInTerminal(ctx: IpcContext): Promise<boolean>
  openWorktreeTerminal(ctx: IpcContext): Promise<boolean>
  resolveTerminal(fallbackTerminalId: TerminalAppId | null): Promise<ResolvedTerminal>
  attachFiles(ctx?: IpcContext): Promise<Attachment[] | null>
  attachFilePaths(paths: string[], ctx?: IpcContext): Promise<Attachment[] | null>
  attachUpload(ctx: IpcContext, request: AttachmentUploadRequest): Promise<string>
  /** Mint a one-use URL for streaming a large file (a video) into the session's
   *  upload folder. */
  attachUploadToken(ctx: IpcContext, request: AttachmentUploadTokenRequest): Promise<AttachmentUploadTokenResult>
  assetUpload(request: AssetUploadRequest): Promise<AssetUploadResult>
  assetCreateUrl(ctx: IpcContext | undefined, request: AssetCreateUrlRequest): Promise<AssetCreateUrlResult>
  /** One round trip for a list of candidate paths; null when none can be served. */
  assetFindUrl(ctx: IpcContext | undefined, request: AssetFindUrlRequest): Promise<AssetFindUrlResult | null>
  takeScreenshot(ctx?: IpcContext): Promise<Attachment | null>
  pasteImage(dataUrl: string, ctx?: IpcContext): Promise<Attachment | null>
  transcribeAudio(audio: Float32Array | string, options?: VoiceTranscriptionOptions, ctx?: IpcContext): Promise<{ error: string | null; transcript: string | null }>
  voiceStreamStart(options?: VoiceTranscriptionOptions): Promise<{ streamId: string }>
  voiceStreamFeed(request: VoiceStreamFeedRequest): Promise<VoicePartial>
  voiceStreamFinish(request: VoiceStreamRequest): Promise<VoiceTranscript>
  voiceStreamCancel(request: VoiceStreamRequest): Promise<void>
  warmTranscription(request?: VoiceWarmRequest, ctx?: IpcContext): Promise<void>
  voiceModelStatus(ctx?: IpcContext): Promise<VoiceModelStatus>
  voiceModelRetry(ctx?: IpcContext): Promise<VoiceModelStatus>
  logVoiceTranscription(row: {
    sessionIndex: number
    firstStartedAt: string | null
    startedAt: string | null
    listeningMs: number | null
    transcribeMs: number
    prompt: string
    promptChars: number
    promptWords: number
    totalListeningMs: number
    success: boolean
  }): Promise<void>
  searchFiles(query: string, cwd: string, ctx?: IpcContext): Promise<{ files: FileMatch[] }>
  /** The files git ignores in a checkout, and which ones its `.worktreeinclude` names. */
  listIgnoredProjectFiles(cwd: string): Promise<IgnoredProjectFiles>
  /** Adds files to, or takes them out of, a checkout's `.worktreeinclude`. */
  setWorktreeIncluded(cwd: string, changes: WorktreeIncludeChange[]): Promise<IgnoredProjectFiles>
  /** The files a Run on send copies from this checkout: what its `.worktreeinclude` names, and the file itself. */
  readWorktreeIncludedFiles(cwd: string): Promise<CopiedProjectFile[]>
  /** Project-wide content search (live grep over the workspace index). */
  searchProjectContents(ctx: IpcContext, request: ProjectContentSearchRequest): Promise<ProjectContentSearchResult>
  /** `annotate` adds per-entry repo/branch/project marks — costs a stat per folder. */
  listDirectory(path: string, showHidden?: boolean, annotate?: boolean): Promise<DirectoryListResult>
  createDirectory(path: string): Promise<CreateDirectoryResult>
  /** Rename, trash, or delete one path anywhere on the host (the directory picker). */
  mutateHostPath(mutation: HostPathMutation): Promise<HostPathMutationResult>
  readProjectFile(ctx: IpcContext, request: FilePreviewRequest): Promise<FilePreviewResult>
  listProjectFiles(ctx: IpcContext, request?: ProjectFilesRequest): Promise<ProjectFilesResult>
  /** Create, rename, or delete one entry inside the project root. */
  mutateProjectFile(ctx: IpcContext, request: ProjectFileMutationRequest): Promise<ProjectFileMutationResult>
  writeFile(ctx: IpcContext, request: WriteFileRequest): Promise<WriteFileResult>
  /** The symbol under a position in a project file: hover text, definition,
   *  and the first reference page from the host's SCIP index. */
  codeIntelSymbolAt(ctx: IpcContext, request: CodeIntelSymbolRequest): Promise<CodeIntelSymbolResult>
  /** One bounded page after the references included with the symbol answer. */
  codeIntelReferences(ctx: IpcContext, request: CodeIntelReferencesRequest): Promise<CodeIntelReferencesResult>
  /** The MDN summary for a platform symbol, fetched by the host so the card can
   *  describe it in place. Not project-scoped: no context, no index. */
  codeIntelDocs(request: CodeIntelDocsRequest): Promise<CodeIntelDocsResult>
  /** Without a context or cwd this answers tool availability on the host only. */
  codeIntelStatus(ctx: IpcContext | null, request?: CodeIntelStatusRequest): Promise<CodeIntelStatus>
  /** Install one known SCIP indexer on the host. The language selects a fixed command; clients cannot supply argv. */
  codeIntelInstall(request: CodeIntelInstallRequest): Promise<CodeIntelInstallResult>
  codeIntelReindex(ctx: IpcContext, request?: CodeIntelReindexRequest): Promise<CodeIntelReindexResult>
  /** Answers a permission `askingSessionId` waits on — the caller's own session, or one it sent work to.
   *  `feedback` goes with a denial to the agent that asked; only a request with `supportsFeedback` takes it. */
  respondPermission(ctx: IpcContext, askingSessionId: string, questionId: string, optionId: string, updatedPlan?: string, feedback?: string): Promise<boolean>
  writePlanFile(filePath: string, content: string, ctx?: IpcContext): Promise<{ ok: boolean; error?: string }>
  /** Answers a question `askingSessionId` waits on — the caller's own session, or one it sent work to. */
  respondQuestion(ctx: IpcContext, askingSessionId: string, questionId: string, answers: Record<string, string>): Promise<boolean>
  rateLimitDecision(ctx: IpcContext, action: RateLimitDecisionAction): Promise<boolean>
  cancelQueuedPrompt(ctx: IpcContext, queueId: string): Promise<boolean>
  editQueuedPrompt(ctx: IpcContext, queueId: string, text: string): Promise<boolean>
  bindRuntimeSession(ctx: IpcContext): Promise<RuntimeSessionInfo | null>
  resetSession(ctx: IpcContext): Promise<void>
  /** Accept a plan in its own session: stop the planning run, hand over or reset
   *  as asked, and record the decision (plans/012 §5). The client then sends the
   *  implementation prompt. */
  acceptPlan(ctx: IpcContext, request: AcceptPlanRequest): Promise<AcceptPlanResult>
  /** Collaboration plane: the session records of the caller's organization (docs/plans/cloud-service-model.md). */
  sessionRecordList(filter?: SessionRecordListFilter): Promise<SessionRecordList>
  /** Collaboration plane: one session record with the caller's view and whether it is in their list
   *  (`/v1/sessions/:sessionId`); null when the caller may not read it. */
  sessionRecordGet(sessionId: string): Promise<SessionRecord | null>
  /** Collaboration plane: what was said in the sessions this home keeps. */
  sessionRecordSearch(query: SessionRecordSearchQuery): Promise<SessionRecordSearch>
  /** The Solus API only: the caller's sessions in the cloud, with their card and four facts
   *  (`GET /v1/me/sessions`; docs/plans/portable-sessions-cloud.md answer 2.3 C). */
  sessionCloudList(): Promise<ListMySessionsResponse['items']>
  /** The Solus API only: the diff of one turn, read from the session repository at its
   *  recorded head (`GET /v1/sessions/:sessionId/turns/:turnIndex/diff`). */
  sessionTurnDiff(sessionId: string, turnIndex: number): Promise<SessionTurnDiff>
  /** Collaboration plane, at the session's home (`/v1/sessions/:sessionId`;
   *  docs/plans/session-archive.md): settle a session for everyone, or archive
   *  and snooze it in the caller's own list. Answers where it is now. */
  sessionUpdate(sessionId: string, change: SessionChange): Promise<SessionChanged>
  /** The pull requests a session works on (`/v1/sessions/:sessionId/pull-requests`). */
  sessionPullRequests(sessionId: string): Promise<SessionPullRequestLink[]>
  /** Link a pull request to a session by its URL (`PUT /v1/links`). The same link again changes nothing. */
  sessionPullRequestPut(sessionId: string, url: string): Promise<void>
  /** Remove a pull request from a session. PR sync does not link it again. */
  sessionPullRequestDelete(sessionId: string, pullRequest: { repository: string; number: number }): Promise<void>
  /** Collaboration plane: a runner's report of one session. The host itself and, later, a runner of the organization. */
  sessionRecordUpsert(record: SessionRecordUpsert): Promise<SessionRecord>
  /** Collaboration plane: the organization's projects, one per repository (docs/plans/project-model.md §2). */
  workspaceProjectList(): Promise<WorkspaceProject[]>
  /** Add a repository to the organization's projects. Adding one already there answers the existing row. */
  workspaceProjectAdd(request: WorkspaceProjectAddRequest): Promise<WorkspaceProject>
  workspaceProjectRemove(projectId: string): Promise<void>
  workspaceProjectUpdate(projectId: string, patch: WorkspaceProjectPatch): Promise<WorkspaceProject>
  loadSession(sessionId: string, projectPath?: string, ctx?: IpcContext, provider?: AgentId, limit?: number, options?: { deferToolInputs?: boolean }): Promise<WireSessionLoadMessage[]>
  loadSessionSubagent(request: SessionSubagentRequest): Promise<SessionHistoryPage>
  loadSessionPage(request: SessionHistoryPageRequest): Promise<SessionHistoryPage>
  loadSessionToolInputs(request: SessionToolInputsRequest): Promise<SessionToolInput[]>
  loadSessionPreview(sessionId: string, projectPath?: string, ctx?: IpcContext, provider?: AgentId): Promise<SessionPreviewResult>
  /** The passage a search hit sits in: the message and its neighbours, from the index. */
  loadSessionMessageWindow(request: SessionMessageWindowRequest): Promise<SessionMessageWindow>
  getSessionInfo(sessionId: string): Promise<SessionMeta | null>
  getSessionInfos(sessionIds: string[]): Promise<Array<SessionMeta | null>>
  /** Lineage and active-member metadata for a saved session, in one read. */
  describeSession(sessionId: string): Promise<SessionDescription>
  /** Name a session and describe its task from the opening prompt. */
  generateSessionMetadata(
    promptText: string,
    cwd: string,
    context?: SessionMetadataGenerationContext,
  ): Promise<SessionGeneratedMetadata | null>
  /** Return a worker's saved title, generating one if it is missing and allowed. */
  ensureBackgroundSessionTitle(sessionId: string, preferences?: ExecutionPreferences): Promise<string | null>
  /** Persist a session name; null clears it back to the derived title. */
  setSessionTitle(
    sessionId: string,
    title: string | null,
    source?: 'generated' | 'manual',
    generatedDescription?: string,
    publishEvent?: boolean,
  ): Promise<void>
  /** Persist the checkout owned by one session attempt. */
  setSessionBranch(sessionId: string, branch: string): Promise<void>
  /** Watch a pull request the session links, or stop watching it. The agent
   *  wakes on news (docs/plans/pr-watch.md). Answers what starting did. */
  sessionPullRequestWatch(sessionId: string, repository: string, number: number, watching: boolean): Promise<SessionPullRequestWatchOutcome>
  /** What a session produced or linked: its pull requests, works, files,
   *  images, and automations, and those of the sessions it started
   *  (docs/plans/session-artifacts.md). */
  sessionArtifactsList(sessionId: string): Promise<SessionArtifacts>
  /** A session and every session below it, the session first: each one's
   *  record, digest, and artifacts (docs/plans/session-digests.md). */
  sessionTree(sessionId: string, includeRelations?: boolean): Promise<SessionTree>
  sessionLineageHistory(parentSessionId: string, childSessionId: string, before?: string, turnLimit?: number): Promise<SessionHistoryPage>
  sessionMergeBackPrompt(sessionId: string): Promise<SessionMergeBackPrompt>
  listRecentProjects(): Promise<RecentProject[]>
  trackRecentProject(path: string): Promise<void>
  listPlans(projectPath?: string, allProjects?: boolean, ctx?: IpcContext): Promise<PlanDescriptor[]>
  loadPlanContent(sessionId: string, projectPath: string, planToolUseId: string, ctx?: IpcContext, provider?: AgentId): Promise<string | null>
  getThreadGoal(threadId: string, ctx?: IpcContext, provider?: AgentId): Promise<ThreadGoal | null>
  setThreadGoal(request: ThreadGoalSetRequest, ctx?: IpcContext, provider?: AgentId): Promise<ThreadGoal>
  clearThreadGoal(threadId: string, ctx?: IpcContext, provider?: AgentId): Promise<boolean>
  /** Compact the existing Codex thread addressed by this session. */
  compactSession(ctx: IpcContext): Promise<void>
  loadPlanAnnotations(sessionId: string, planToolUseId: string, ctx?: IpcContext): Promise<PlanAnnotations | null>
  savePlanAnnotations(annotations: PlanAnnotations, ctx?: IpcContext): Promise<{ ok: boolean }>
  toggleBookmarkPlan(sessionId: string, projectPath: string, cwd: string, planToolUseId: string, title: string, ctx?: IpcContext): Promise<PlanAnnotations>
  detectEditors(ctx?: IpcContext): Promise<{ editors: DetectedEditor[]; terminals: DetectedTerminal[] }>
  openInEditor(ctx: IpcContext, request: OpenInEditorRequest): Promise<boolean>

  googleDisconnect(): Promise<void>
  googleStatus(): Promise<GoogleAuthStatus>
  googleConnect(callbackBaseUrl?: string): Promise<{ authUrl: string; expiresAt: number }>

  atlassianStatus(): Promise<AtlassianStatus>
  /** `callbackBaseUrl` is the origin the client reached the workspace service by; a host ignores it and uses its loopback listener. */
  atlassianStartOAuth(callbackBaseUrl?: string): Promise<AtlassianOAuthStartResult>
  atlassianCancelOAuth(): Promise<void>
  atlassianConnectApiToken(input: AtlassianApiTokenInput): Promise<AtlassianApiTokenConnectResult>
  atlassianDisconnect(): Promise<void>
  atlassianJiraProjects(): Promise<AtlassianJiraProject[]>
  /** `principal` is how this caller was admitted; only a `local-owner` may change how the host is reached. */
  connectionsGetServerInfo(): Promise<ConnectionsServerInfo>
  connectionsListEndpoints(): Promise<Array<{ kind: 'loopback' | 'lan' | 'tailnet'; label: string; host: string; port: number }>>
  connectionsGeneratePairToken(): Promise<{ token: string; code: string; expiresAt: number }>
  connectionsListSessions(): Promise<Array<{ id: string; deviceLabel: string; deviceId: string | null; connectedAt: number; connectionCount: number; connectionIds: string[] }>>
  /**
   * Adds a machine this host reaches with SSH (docs/plans/host-routes.md D6): installs and
   * starts Solus there when needed, then links it to the account or opens a forward to it.
   * Progress goes on `host.sshProgress`. A discovered server with no target suggests one.
   */
  hostsAddOverSsh(request: SshAddRequest): Promise<SshAddResult>
  /** The hosts this host reaches through a forward it holds (D7). */
  hostsListForwarded(): Promise<ForwardedHost[]>
  /** Gives a forward in `needs-auth` its password or key passphrase, which stays in the host's memory. Resolves when the forward answers or stops again. */
  hostsUnlockForwarded(args: { installationId: string; authSecret: string }): Promise<ForwardedHost>
  /** The WSL distros this Windows host can add as machines. */
  hostsListWslDistros(): Promise<WslDistroList>
  /**
   * The machines this host's `~/.ssh/config` names, as targets to add over SSH: the
   * Discover source of docs/plans/host-fleet.md D7. Only the host owner may read them.
   */
  hostsListSshConfigHosts(): Promise<SshTargetCandidate[]>
  /** Adds one of this host's WSL distros as a machine it forwards to. */
  hostsAddWsl(request: WslAddRequest): Promise<SshAddResult>
  /** Closes the forward and forgets the host. With `stopRemote`, also removes the service Solus installed there. */
  hostsRemoveForwarded(args: { installationId: string; stopRemote: boolean }): Promise<{ removed: boolean }>
  /** Links a forwarded host to the account over the same SSH target; its forward stays as a route (D9). */
  hostsLinkForwarded(args: { installationId: string; link: SshAddLink }): Promise<{ linked: true }>
  /** The hosts the owner connected to themselves, as this host keeps them while they are signed out (plans/031 D7). Owner only. */
  /** Explicit owner pairing, used by chat tools and the CLI. */
  hostsPair(request: HostPairRequest): Promise<HostListing>
  hostsListPaired(): Promise<HostPairingsSnapshot>
  hostsPairClient(installationId: string): Promise<HostClientPairing>
  hostsForget(installationId: string): Promise<{ removed: boolean }>
  hostListRead(): Promise<HostListing[]>
  /** Adds a host to the list, or replaces the listing with the same id. */
  hostListPut(listing: HostListing): Promise<void>
  /** Removes a host from the list. */
  hostListRemove(id: string): Promise<void>
  /** The devices this host paired, offline and revoked ones included (plans/033 §4.4): the ones with access first, then the most recently seen. Owner only. */
  connectionsListDevices(): Promise<PairedDevice[]>
  connectionsRevokeDevice(args: { deviceId: string }): Promise<{ ok: boolean }>
  connectionsSetRemoteAccess(args: { remoteAccess: RemoteAccessMode }): Promise<{ remoteAccess: RemoteAccessMode; host: string; port: number; allowLan: boolean; requireAuth: boolean }>
  connectionsGetTailscaleServe(): Promise<TailscaleServeStatus>
  connectionsEnableTailscaleServe(args: { port: number }): Promise<TailscaleServeStatus>
  connectionsDisableTailscaleServe(): Promise<TailscaleServeStatus>
  connectionsSetTrustLocalNetwork(args: { trustLocalNetwork: boolean }): Promise<{ trustLocalNetwork: boolean }>
  /**
   * The next access token for this socket (docs/adr/0001-standard-authentication.md rule 4).
   * It must name the same person and audience as the token that opened the socket, and for a
   * member still list the socket's organization; the socket then lives to its expiry (ms).
   */
  authRenew(request: { accessToken: string }): Promise<{ expiresAt: number }>
  /**
   * A signed-in client's access token for this host, on any admitted socket (ADR 0001 §6
   * item 5). The host makes each delegation the token names that it does not hold; the
   * socket's access does not change. `delegated` is true when every one is held now.
   */
  accountPresent(request: { accessToken: string; organizationId?: string }): Promise<{ delegated: boolean }>
  /** One Solus API request, with the socket's principal as its authority: no credential exchange. */
  solusApiRequest(request: SolusApiRequest): Promise<SolusApiResponse>
  /** The hosts this host paired with (host administrator only). */
  /** The hosts this host was introduced to, and the ones the person forgot (host-reach.md §4). */
  hostIntroductionsList(): Promise<IntroducedHostsSummary>
  /** A token for the named host, which a client hands to it with `hostIntroductionAccept`. */
  hostIntroductionIssue(args: { installationId: string; label: string }): Promise<HostIntroduction>
  /** Keeps the token another host issued; `grantedDeviceId` is the device this host issued for it. */
  hostIntroductionAccept(args: { introduction: HostIntroduction; grantedDeviceId: string }): Promise<{ ok: true }>
  /** Forgets an introduced host here and refuses it until it is allowed again. */
  hostIntroductionForget(args: { installationId: string }): Promise<{ forgotten: boolean }>
  hostIntroductionAllow(args: { installationId: string }): Promise<{ allowed: boolean }>
  /**
   * Register this host to the owner's Solus account with a ticket the owner's client got
   * (docs/adr/0001-standard-authentication.md §2.2 rule 8). A registered host redeems a
   * ticket that names organizations as an attachment. Local owner only.
   */
  uplinkRegister(args: HostRegistrationRequest): Promise<UplinkStatus>
  /** Turn the tunnel on: the internet reaches this registered host through cloudflared (rule 9). Nothing else changes. */
  uplinkLink(): Promise<UplinkStatus>
  /** Turn the tunnel off. The registration, its delegations, and its organizations stay. */
  uplinkUnlink(): Promise<UplinkStatus>
  /** Take this host's organization attachment back for one organization; the host stays registered and keeps its records. */
  uplinkDetachOrganization(organizationId: string): Promise<UplinkStatus>
  uplinkStatus(): Promise<UplinkStatus>
  /** The host tests its own connection: Solus Cloud, its tunnel, port 7844, and its server (docs/plans/host-readiness.md). */
  hostSelfTest(): Promise<HostSelfTest>
  /** Organization scope (docs/plans/organization-scope.md §3.1, §6.1, §7). */
  hostOrganizations(): Promise<HostOrganizationsStatus>
  /** The policies that govern work on this host (plans/030), as a summary: no launch pins and no update feed. */
  hostPolicy(): Promise<PolicySet>
  /** Host administrator only: opt this machine's work for one organization into its Insights while that organization's policy is off. */
  hostSetInsightsOptIn(organizationId: string, enabled: boolean): Promise<HostOrganizationsStatus>
  /** A Local work, whole, for its upload into an organization (docs/plans/cloud-sharing.md §3). */
  workExportForCloud(workId: string): Promise<WorkTransfer>
  /** The Local work after its upload into `organizationId`: points at that organization, with its content kept, only when it did not change since that export (cloud-sharing.md §3a). */
  workMarkMoved(workId: string, fingerprint: string, organizationId: string): Promise<void>
  /** Solus API: store an uploaded work in the caller's organization under its own id; the same work again answers as before. */
  workUpload(transfer: WorkTransfer): Promise<{ workId: string; organizationId: string }>
  /** Sharing (docs/plans/multiplayer-sharing.md §3–§4). Reading needs viewer access; the list is replaced whole. */
  shareGet(request: { resource: ShareResource }): Promise<ShareList>
  shareSet(request: ShareSetRequest): Promise<ShareList>
  /** The link as it now stands, with its secret, to the owner and editors: a new secret when it was minted or regenerated, the same secret on a role change; null when the link is off. */
  shareSetLink(request: ShareSetLinkRequest): Promise<ShareLink | null>
  /** The origin a resource's guest link names (docs/plans/host-sharing.md §2): the account origin for a mirrored session, else this host's tunnel when online, else its first direct address; null when nobody off this machine can reach it. */
  shareLinkOrigin(resource: ShareResource): Promise<{ origin: string | null }>
  /** Provider seats (Step 2 plan §3.2): the caller's own Claude and Codex logins on this host. */
  providerInstanceStatus(request: ProviderInstanceTarget): Promise<ProviderInstanceStatus>
  providerInstanceSignIn(request: ProviderInstanceTarget): Promise<SeatConnectStartResult>
  providerInstanceSubmitCode(request: ProviderInstanceCode): Promise<{ submitted: true }>
  providerInstanceCancelSignIn(request: ProviderInstanceTarget): Promise<{ cancelled: boolean }>
  providerInstanceSignOut(request: ProviderInstanceTarget): Promise<ProviderInstanceStatus>
  providerInstancesGet(): Promise<ProviderInstancesSnapshot>
  providerInstancesWrite(request: ProviderInstancesWrite): Promise<ProviderInstancesSnapshot>
  seatList(): Promise<SeatStatus[]>
  /** Starts the provider's login on the host for the caller's seat; answers once it has printed where to sign in. */
  seatConnectStart(request: SeatProviderRequest): Promise<SeatConnectStartResult>
  /** Hands the browser's code to the login waiting on stdin. Completion arrives as `host.seatChanged`. */
  seatConnectSubmitCode(request: SeatConnectCodeRequest): Promise<{ submitted: true }>
  seatConnectCancel(request: SeatProviderRequest): Promise<{ cancelled: boolean }>
  /** A credential made elsewhere: a Claude setup-token (inference-only) or a Codex auth.json. */
  seatConnectToken(request: SeatConnectTokenRequest): Promise<SeatStatus>
  seatDisconnect(request: SeatProviderRequest): Promise<SeatStatus>
  /** Host administrator: deletes a member's seat files, on removal from the team. */
  seatRemove(request: SeatRemoveRequest): Promise<{ removed: number }>
  /** Starts a Claude Design or MCP server sign-in in the caller's seat. The end of a `waiting` flow arrives as `host.agentAuthFinished`. */
  agentAuthStart(target: AgentAuthTarget): Promise<AgentAuthStartResult>
  /** Hands the code, or the address the browser ended on, to the waiting sign-in. */
  agentAuthSubmit(request: AgentAuthSubmitRequest): Promise<{ submitted: true }>
  agentAuthCancel(request: AgentAuthFlowRequest): Promise<{ cancelled: boolean }>
  /** Clears the caller's stored OAuth credential for one MCP server. */
  agentAuthSignOut(target: AgentAuthMcpTarget): Promise<{ message: string }>
  /** Integrations (docs/plans/mcp-integrations.md): the MCP entries of the integrations.sh feed. */
  integrationCatalogList(request: IntegrationCatalogListRequest): Promise<CatalogPage>
  /** The anonymous check of one server address. Creates nothing. */
  integrationProbe(request: IntegrationProbeRequest): Promise<IntegrationProbeResult>
  /** An MCP App card's saved document and tool data (docs/plans/conversation-card-parity.md). */
  mcpAppRead(request: McpAppRequest): Promise<McpAppSnapshot>
  /** The app of a tool call that has not ended, for the caller's own integration; null when the tool has no app or the caller is not its owner. */
  mcpAppLiveRead(request: McpAppLiveRequest): Promise<McpAppLiveDocument | null>
  /** Whether the app may call a tool now, and whether that tool only reads. */
  mcpAppToolInfo(request: McpAppToolRequest): Promise<McpAppToolInfo>
  /** Calls a tool of the app's integration with the caller's connection; a write needs `approved`. Returns the result as JSON. */
  mcpAppCallTool(request: McpAppCallRequest): Promise<string>
  /** Reads a resource of the app's integration with the caller's connection. Returns the result as JSON. */
  mcpAppReadResource(request: McpAppResourceRequest): Promise<string>
  /** Replaces the app's context for the agent, which the session's next turns carry. Empty text clears it. */
  mcpAppUpdateModelContext(request: McpAppModelContextRequest): Promise<void>
  /** Apps (docs/plans/apps.md): the apps of this host that the caller may use. */
  appList(): Promise<AppSummary[]>
  /** What a client needs to show one app: its header and the policy of its frame. `appId` is an id or a slug. */
  appRead(request: AppRequest): Promise<AppState>
  /** The UI of the active version; null when the app has none. */
  appUi(request: AppRequest): Promise<AppUi | null>
  /** Runs one call for the app's UI as the caller: an operation, its storage, or an integration tool. Answers the result as JSON text. */
  appCall(request: AppCallRequest): Promise<string>
  /** Stops the app: no operation runs and no schedule fires until `appStart`. */
  appStop(request: AppRequest): Promise<AppState>
  appStart(request: AppRequest): Promise<AppState>
  /** Deletes the app with its repository, its data, its schedules, its secrets, and its webhooks. */
  appDelete(request: AppRequest): Promise<boolean>
  appVersions(request: AppRequest): Promise<AppVersionView[]>
  /** The source change of one version against the version before it. */
  appVersionDiff(request: AppVersionRequest): Promise<AppVersionDiff>
  /** Makes an earlier version active. It does not rewind the app's data. */
  appActivate(request: AppVersionRequest): Promise<AppState>
  appSchedules(request: AppRequest): Promise<AppScheduleView[]>
  appScheduleSet(request: AppScheduleSetRequest): Promise<AppScheduleView[]>
  /** Runs a schedule's mutation now. */
  appScheduleRun(request: AppScheduleRequest): Promise<AppScheduleView[]>
  /** The runs of each schedule in each span the client asks for, and the runs to come. */
  appScheduleCalendar(request: AppScheduleCalendarRequest): Promise<AppScheduleCalendar>
  /** Sets or clears one secret. The value is never read back. */
  appSecretSet(request: AppSecretSetRequest): Promise<AppState>
  /** Sets one config value, or gives the field its default again with `null`. */
  appConfigSet(request: AppConfigSetRequest): Promise<AppState>
  /** The app's webhooks with their URLs and signing secrets, for its owner. */
  appWebhooks(request: AppRequest): Promise<AppWebhookView[]>
  /** A new signing secret for one webhook the app declares: the sender needs the new one. Answers the app's webhooks. */
  appWebhookRotateSecret(request: AppWebhookRequest): Promise<AppWebhookView[]>
  /** The newest calls of the call log that pass the request's filters. */
  appCalls(request: AppCallsRequest): Promise<AppCallView[]>
  /** The sessions linked to the app. */
  appSessions(request: AppRequest): Promise<AppSessionLink[]>
  /** Links a session of this host to the app, as a deploy does. Answers the linked sessions. */
  appSessionLink(request: AppSessionRequest): Promise<AppSessionLink[]>
  /** Removes the link of one session to the app. The session stays. Answers the linked sessions. */
  appSessionUnlink(request: AppSessionRequest): Promise<AppSessionLink[]>
  /** The app's revisions, the newest first: each save, with the versions built from it. */
  appRevisions(request: AppRequest): Promise<AppRevisionView[]>
  /** The source change of one revision against the revision before it. */
  appRevisionDiff(request: AppRevisionRequest): Promise<AppRevisionDiff>
  /** Where a step of a workflow is in the source of a version, with the text of its file; null when the source has no such step. */
  appStepSource(request: AppStepSourceRequest): Promise<AppStepSource | null>
  /** Builds a revision on the host and makes the version active. It answers when the build ended; `apps.changed` says each step before that. */
  appDeploy(request: AppDeployRequest): Promise<AppDeployReceipt>
  appBuildLog(request: AppVersionRequest): Promise<AppBuildLog>
  /** What a deploy of a revision changes against the active version. The host builds the revision and makes no version of it. */
  appDeployPreflight(request: AppDeployPreflightRequest): Promise<AppDeployPreflight>
  /** Sends the active version of an app to its deployment, a container outside Solus, and makes the deployment first when the app has none (docs/plans/app-deploy.md). The app in Solus does not change. */
  appPublish(request: AppPublishRequest): Promise<AppPublishReceipt>
  /** Removes the deployment of an app with the data it holds. */
  appUnpublish(request: AppRequest): Promise<void>
  /** The deployment of an app; null for an app that is not published. */
  appDeployment(request: AppRequest): Promise<AppDeploymentView | null>
  /** The newest lines of the log of an app's deployment. */
  appDeploymentLogs(request: AppDeploymentLogsRequest): Promise<string>
  /** The places that can run the copy of an app of this host, and what this host has for a publish. */
  appPublishPlaces(): Promise<AppPublishPlaces>
  /** Sets or removes the Tailscale auth key of this host, for a copy with an address on the tailnet. A value is never read back. */
  appTailscaleKeySet(request: AppTailscaleKeySetRequest): Promise<AppPublishPlaces>
  /** Runs the container of an app of another Solus on this host. A container of that app that is there already is replaced; its data stays. */
  appContainerRun(request: AppContainerRunRequest): Promise<AppContainerAddress>
  appContainerStatus(request: AppContainerRequest): Promise<AppContainerState>
  /** The newest lines that a hosted container wrote. */
  appContainerLogs(request: AppContainerLogsRequest): Promise<string>
  /** Removes a hosted container with the data it holds. */
  appContainerRemove(request: AppContainerRequest): Promise<void>
  /** Carries one request of the management API to the runtime in a hosted container. */
  appContainerManage(request: AppContainerManageRequest): Promise<AppContainerManageAnswer>
  /** Whether the app's operations are tools for agents. */
  appSetAgentAccess(request: AppAgentAccessRequest): Promise<AppState>
  /** Renames the app, describes it, or colours its tile, for every person and client. */
  appUpdate(request: AppUpdateRequest): Promise<AppState>
  /** One call with its input, its log lines, and its trace; null when the call log no longer has it. */
  appCallRead(request: AppCallReadRequest): Promise<AppCallDetail | null>
  /** The calls of the last 24 hours, in numbers. */
  appMetrics(request: AppRequest): Promise<AppMetrics>
  /** The calls that pass the filters in numbers, with the bars of the Activity chart. */
  appCallStats(request: AppCallStatsRequest): Promise<AppCallStats>
  /** The newest workflow runs. */
  appRuns(request: AppRunsRequest): Promise<AppRunView[]>
  appRunRead(request: AppRunRequest): Promise<AppRunDetail | null>
  /** Ends a run that is running or sleeping. A step in progress ends by itself. */
  appRunTerminate(request: AppRunRequest): Promise<AppRunDetail>
  /** Starts a failed run again: its failed step runs again, and its finished steps do not. */
  appRunRetry(request: AppRunRequest): Promise<AppRunDetail>
  /** Takes a failed run off what needs the owner, with no retry. The run stays in the history. */
  appRunDismiss(request: AppRunRequest): Promise<AppRunDetail>
  /** The signals the active version declares, each with its signal actions. */
  appSignals(request: AppRequest): Promise<AppSignalView[]>
  appSignalOccurrences(request: AppSignalOccurrencesRequest): Promise<AppSignalOccurrence[]>
  /** Makes or changes one signal action. */
  appSignalActionSave(request: AppSignalActionSaveRequest): Promise<AppSignalView[]>
  appSignalActionDelete(request: AppSignalActionRequest): Promise<AppSignalView[]>
  /** The app files. Their bytes cross through `appCall` with `@files/read`. */
  appFiles(request: AppRequest): Promise<AppFileView[]>
  appFileRemove(request: AppFileRequest): Promise<AppFileView[]>
  /** The newest model calls of the app, without their text (docs/plans/app-models.md). */
  appModelCalls(request: AppModelCallsRequest): Promise<AppModelCallView[]>
  /** One model call with its text, steps, and result; null when the host no longer keeps it. */
  appModelCallRead(request: AppModelCallRequest): Promise<AppModelCallView | null>
  /** Stops a queued or running model call. */
  appModelCallCancel(request: AppModelCallRequest): Promise<AppModelCallView>
  integrationList(): Promise<Integration[]>
  integrationGet(request: IntegrationIdRequest): Promise<Integration | null>
  /** Probes an address, then writes the record; a command (`stdio`) needs a host administrator and starts nothing. Changes arrive as `integration.changed`. */
  integrationCreate(request: IntegrationCreateRequest): Promise<Integration>
  /** Host administrator. */
  integrationUpdate(request: IntegrationUpdateRequest): Promise<Integration>
  /** Host administrator: removes the record and its tools. */
  integrationRemove(request: IntegrationIdRequest): Promise<{ removed: boolean }>
  /** The upstream tools of one integration, as the gateway last listed them. */
  integrationTools(request: IntegrationIdRequest): Promise<IntegrationToolSummary[]>
  integrationFacts(request: IntegrationIdRequest): Promise<IntegrationFacts>
  /** Host administrator, owner: starts the caller's process of a `stdio` integration and lists its tools; `recheck` checks the revision again. */
  integrationProcessStart(request: IntegrationProcessStartRequest): Promise<IntegrationFacts>
  /** Owner: closes the caller's sessions of a `stdio` integration, which stops their processes. The next use starts one again. */
  integrationProcessStop(request: IntegrationIdRequest): Promise<{ stopped: boolean }>
  /** The MCP servers in this host's config files, names only; the user files only for a host administrator. */
  integrationFoundList(request: IntegrationFoundListRequest): Promise<FoundServerList>
  /** Discovers the MCP servers of every host the caller reaches from this host. The answer names the hosts it asks: this host and each other host it reaches for the caller. Each list comes as `integration.discovered` (§8.9). */
  integrationDiscover(request: IntegrationDiscoverRequest): Promise<IntegrationDiscovery>
  /** Reads the file again and adds the found server the person saw; a command needs a host administrator and starts nothing. `hostId`: the add goes to that host through this one. */
  integrationFoundAdd(request: IntegrationFoundAddRequest): Promise<IntegrationFoundAddResult>
  /** Host administrator: starts a found server once, reads its tools, and stops it. Nothing is saved (mcp-first-class.md §8.8). */
  integrationFoundTest(request: IntegrationFoundTestRequest): Promise<IntegrationFoundTestResult>
  /** Host administrator: turns a found server off or on in one of its files, or deletes the entry there (§8.8). */
  integrationFoundChange(request: IntegrationFoundChangeRequest): Promise<IntegrationFoundChangeResult>
  /** The MCP prompts of the caller's integrations for one project, and the servers that need the caller's sign-in first (mcp-first-class.md §10). */
  integrationPromptList(request: IntegrationPromptListRequest): Promise<IntegrationPromptList>
  /** Owner: expands one MCP prompt with the caller's connection; the text becomes the caller's message. */
  integrationPromptGet(request: IntegrationPromptGetRequest): Promise<IntegrationPromptText>
  /** The caller's MCP resources and templates (docs/plans/mcp-first-class.md §11.4). A list-changed notification arrives as `integration.changed` with `change: 'facts'`. */
  integrationResourceList(request: IntegrationResourceListRequest): Promise<IntegrationResourceLists>
  /** Reads one MCP resource as the caller and keeps its contents in the conversation's attachment store: one attachment for each content item. */
  integrationResourceAttach(ctx: IpcContext, request: IntegrationResourceAttachRequest): Promise<Attachment[]>
  /** A session's resource watches that are live or ended in the last day (mcp-first-class.md §11.5). Changes arrive as `integration.resourceWatchChanged`. */
  integrationResourceWatchList(request: IntegrationResourceWatchListRequest): Promise<ResourceWatch[]>
  /** Stops one resource watch and tells the server. False when it is not live. */
  integrationResourceWatchStop(request: IntegrationResourceWatchStopRequest): Promise<boolean>
  /** A session's MCP tasks that are live or ended in the last day (mcp-first-class.md §12.5). Changes arrive as `mcpTask.changed`. */
  mcpTaskList(request: McpTaskListRequest): Promise<McpTask[]>
  /** Asks the server to cancel one MCP task. Cooperative: the row says "Cancelling…" until the server reports an end. False when it is not live. */
  mcpTaskCancel(request: McpTaskIdRequest): Promise<boolean>
  /** Answers one question of an MCP task that needs input. False when the question is no longer open. */
  mcpTaskAnswer(request: McpTaskAnswerRequest): Promise<boolean>
  /** The caller's own connections (§4). Changes arrive as `integration.connectionChanged`. */
  integrationConnectionList(): Promise<IntegrationConnection[]>
  /** Starts the caller's sign-in to one integration. The end of a `waiting` flow arrives as `host.integrationAuthFinished`. */
  integrationConnectStart(request: IntegrationConnectStartRequest): Promise<IntegrationConnectStartResult>
  /** Hands the address the browser ended on to a waiting flow, or stores an API key for a `bearer` integration. */
  integrationConnectSubmit(request: IntegrationConnectSubmitRequest): Promise<{ submitted: true }>
  integrationConnectCancel(request: IntegrationConnectCancelRequest): Promise<{ cancelled: boolean }>
  /** Removes the caller's token and connection. */
  integrationDisconnect(request: IntegrationAccountRequest): Promise<{ disconnected: boolean }>
  /** Host administrator: this host's own agent profile, to copy to a seat on another host (docs/agent-profile.md). */
  agentProfileRead(): Promise<AgentProfileCopy>
  /** Replaces the caller's profile on this host with this copy, as a push from their computer; an empty profile removes it. */
  agentProfileApply(copy: AgentProfileCopy): Promise<AgentProfileStatus>
  /** The host pulls the caller's profile from their account and applies it (plans/020-agent-profile.md §4). */
  agentProfilePull(): Promise<AgentProfileStatus>
  /** The caller's profile on this host: where it came from, when, and what it holds. */
  agentProfileStatus(): Promise<AgentProfileStatus>
  /** Presence (docs/plans/multiplayer-presence.md): who is on this host, and which participant the caller is. Changes arrive as `host.presenceChanged`. */
  presenceSnapshot(): Promise<PresenceSnapshotResult>
  /** What this client is looking at; a hint for "jump to", never an authorization. */
  presenceSetFocus(request: PresenceSetFocusRequest): Promise<void>
  /** This client has (or no longer has) a draft for the session; the room hears it as `session.presenceChanged`. */
  presenceSetComposing(request: PresenceSetComposingRequest): Promise<void>
  /** This client edits (or stopped editing) a work; the host roster hears it as `host.presenceChanged`. */
  presenceSetEditing(request: PresenceSetEditingRequest): Promise<void>
  /** The caller's own TypeSafe key: where it is, never its value. */
  typeSafeKeyStatus(): Promise<TypeSafeKeyStatus>
  vaultKeyStatus(ref: VaultKeyRef): Promise<VaultKeyStatus>
  vaultKeySave(input: VaultKeySave): Promise<void>
  vaultKeyDisconnect(ref: VaultKeyRef): Promise<void>
  /** Saves or (with null) removes the caller's key, where this host keeps it. */
  typeSafeKeySet(apiKey: string | null): Promise<TypeSafeKeyStatus>
  /** This host's durable config. */
  configGet(): Promise<HostConfigSnapshot>
  /** Host administrator only. Refuses any key that is not host config. */
  configUpdate(patch: HostConfigPatch): Promise<HostConfigSnapshot>
  textGenerationSettingsGet(): Promise<TextGenerationSettingsSnapshot>
  otelSettingsGet(): Promise<OtelSettingsSnapshot>
  discoverServers(): Promise<DiscoveredServer[]>
  setProjectsBaseDirectory(path: string): Promise<Pick<HostCapabilities, 'projectsBaseDirectory' | 'projectsBaseDirectoryIsSet'>>
  setupInstallAgentCli(args: { agent: SetupAgent; installation?: 'native' | 'existing' }): Promise<SetupStepResult>
  setupCheckAgentAuth(args: { agent: SetupAgent }): Promise<SetupAgentAuthCheckResult>
  setupListGithubRepos(): Promise<SetupGithubReposResult>
  setupCloneProject(args: SetupCloneProjectRequest): Promise<SetupCloneProjectResult>
  setupSyncProject(args: SetupSyncProjectRequest): Promise<SetupAdoptProjectResult>
  /** Registers a checkout the host already has, instead of cloning a new one. */
  setupAdoptProject(args: { path: string; cloneUrl?: string }): Promise<SetupAdoptProjectResult>
  /** Creates an empty folder named `name` in `parent` (default: the projects folder), runs `git init`, and records it. */
  setupCreateProject(args: { name: string; parent?: string }): Promise<SetupAdoptProjectResult>
  /** Git binary, commit identity, GitHub credentials and SSH keys — on this host alone. */
  setupHostReadiness(): Promise<HostReadiness>
  setupInstallGit(): Promise<SetupStepResult>
  /** Installs the GitHub CLI, which is what `gh auth` and `gh pr create` need to exist first. */
  setupInstallGh(): Promise<SetupStepResult>
  setupSetGitIdentity(args: GitCommitIdentity): Promise<GitCommitIdentity>
  setupCheckSshAccess(args: { host?: string }): Promise<SetupSshAccessResult>
  /** Hands this host's stored token to `gh` so agent `gh pr create` calls work. */
  setupAuthorizeGhCli(): Promise<{ ok: true }>
  /** Points git at `solus git-credential` so pushes stop prompting. */
  setupInstallGitCredentialHelper(): Promise<{ ok: true }>

  /** This host's Solus release check and its providers' release checks. */
  hostUpdateStatus(): Promise<HostUpdateStatus>
  /** Runs every check now; inside the host's rate limit it returns the current status. */
  hostCheckForUpdates(): Promise<HostUpdateStatus>
  hostInstallUpdate(): Promise<HostUpdateStatus>
  hostCancelUpdate(): Promise<HostUpdateStatus>

  /** The model list this host runs on, and where it came from. */
  modelProfilesStatus(): Promise<ModelProfilesStatus>
  /** Drops the cached list and downloads the published one now. If GitHub
   *  cannot be reached, the host runs on the list its build shipped with. */
  modelProfilesRefresh(): Promise<ModelProfilesStatus>
  /** A model picker opened: downloads the published list if the host last
   *  asked more than five minutes ago, so a new model shows without the daily check. */
  modelProfilesCheck(): Promise<ModelProfilesStatus>

  /** Active per-session needs-attention entries (server-side, outlive clients). */
  listAttention(): Promise<AttentionEntry[]>
  /** The notifications hub this host answers (plans/015). An older host lacks the
   *  method; a client shows it as unsupported, not as an empty inbox. */
  notificationsCapability(): Promise<NotificationHubCapability>
  /** The caller's notifications at this host, newest first. The host names the
   *  recipient from the principal. `notifications.changed` says to read again. */
  notificationsList(request: NotificationListRequest): Promise<NotificationPage>
  notificationsCount(): Promise<NotificationCount>
  /** Set, never toggle: the answer is the row as the host holds it after the write. */
  notificationsSetRead(request: NotificationSetRead): Promise<NotificationStateResult>
  notificationsSetArchived(request: NotificationSetArchived): Promise<NotificationStateResult>

  /** Create a durable provider session with no client watching it. */
  forkSessionFromResponse(request: { sessionId: string; sourceThreadId: string; targetSessionId: string; pointId: string }): Promise<SessionRecord>
  createHeadlessSession(request: HeadlessSessionRequest): Promise<{ sessionId: string; agentSessionId: string }>
  /** Prompt an existing session for an agent on another host. */
  promptHeadlessSession(request: HeadlessPromptRequest): Promise<{ disposition: 'started' | 'steered' | 'queued'; queueId?: string }>
  /** A person's decision on a plan another session wrote, taken from the card in
   *  the conversation that sent it the work. False when the plan is no longer
   *  waiting, or this conversation has no message open to that session. */
  decideSessionPlan(ctx: IpcContext, targetSessionId: string, decision: 'approve' | 'request_changes', comment?: string): Promise<boolean>
  /** Interrupt a session, by Solus's id or the provider thread a card holds. */
  stopSession(sessionId: string): Promise<boolean>
  /** Stop the background tasks a session's agent left running, without
   *  interrupting its turn. False when there is nothing to stop. */
  stopBackgroundTasks(sessionId: string): Promise<boolean>
  stopSessionSubagent(sessionId: string, toolId: string): Promise<boolean>
  /** Stop the worktree setup that runs now and start its prompt in the project
   *  folder instead. False when no worktree setup runs. */
  continueSetupLocally(sessionId: string): Promise<boolean>

  providerStatus(ctx: IpcContext): Promise<AuthStatus>
  providerConnect(ctx: IpcContext): Promise<AuthStatus>
  /** Abort an in-flight providerConnect; its promise rejects with a cancellation. */
  providerCancelConnect(ctx: IpcContext): Promise<void>
  providerDisconnect(ctx: IpcContext): Promise<void>
  /** Exports the local GitHub credential only to the app's own window. */
  githubExportCredential(): Promise<GithubDelegatedCredential>
  /** The connected account, with its host avatar for the surfaces that draw it. */
  providerViewer(ctx: IpcContext): Promise<ProviderViewer>
  /** The repositories the host's credential for a code host can read, newest push first. */
  providerRepositories(providerId: ProviderId): Promise<ProviderRepository[]>

  // PR review mode
  /** One page of a project's list. A page after the first needs the `cursor`
   *  the page before it answered. */
  prList(ctx: IpcContext, filter?: PrFilter, page?: number, cursor?: string): Promise<PrListPage>
  /** A page of every named project on this host, in one answer, so the
   *  every-project list lands at once instead of one project at a time. Page
   *  one, except for a project named in `after`, which gets its next page. */
  prListProjects(ctx: IpcContext, projectRoots: string[], filter?: PrFilter, after?: PrProjectCursor[]): Promise<PrProjectListing[]>
  /** The repository's labels, or the people who can be mentioned in it, that
   *  match `query`: the choices of the list's label and author filters beyond
   *  the rows a page has loaded. */
  prFilterOptions(ctx: IpcContext, field: PrFilterField, query: string): Promise<PrFilterChoice[]>
  /**
   * Replace this client's interest in the ctx repository, and answer what PR
   * sync knows about it now. Later changes arrive as `pr.changed`. The host
   * drops the interest when the connection closes (docs/plans/pr-sync.md).
   */
  prSetInterest(ctx: IpcContext, interests: PrInterest[]): Promise<PrSyncChange>
  prGuideMetadata(ctx: IpcContext, request: PrGuideMetadataRequest): Promise<PrGuideMetadata | null>
  /** Resolve the exact host revision without changing local repository state. */
  prOpenReview(ctx: IpcContext, number: number): Promise<PrReviewTarget>
  prGetDiff(ctx: IpcContext, request: PrDiffRequest): Promise<PrDiffSlice>
  prGetDiffFileContents(ctx: IpcContext, request: PrDiffFileContentsRequest): Promise<PrDiffFileContents>
  prPrepareCheckout(ctx: IpcContext, target: PrReviewTarget): Promise<PrCheckoutContext>
  /** Fetch the PR's body, author, and state for the Activity overview. */
  prGetDetail(ctx: IpcContext, number: number): Promise<PullRequest>
  prUpdate(ctx: IpcContext, number: number, patch: PullRequestUpdate): Promise<PullRequest>
  /** Adds or removes the viewer's reaction on the pull request (`targetId`
   *  null) or one of its comments or reviews. Answers with the target's
   *  reactions after the write, so no read follows it. Reactions are read
   *  with the pull request, its comments, and its threads. */
  prReact(repo: RepoRef, number: number, targetId: string | null, content: PrReactionContent, add: boolean): Promise<PrReactions>
  prInspectUrl(url: string): Promise<PrUrlInspection>
  /** Fetch the PR detail, commits, and reviewers for the PR list detail pane. */
  /** Fetch the PR detail, commits, and reviewers for the PR list detail pane. */
  /** Set includeCommits to false when the summary does not use the commit list. */
  prGetOverview(ctx: IpcContext, number: number, options?: { includeCommits?: boolean }): Promise<PullRequestOverview>
  /** Per-file +/- counts from the code host for the PR's changed files. */
  prChangedFiles(ctx: IpcContext, number: number): Promise<ChangedFileStat[]>
  prListThreads(ctx: IpcContext, number: number): Promise<ReviewThread[]>
  prListComments(ctx: IpcContext, number: number): Promise<PrConversationItem[]>
  prListCommits(ctx: IpcContext, number: number): Promise<PrCommit[]>
  /** The stack this pull request is in, bottom to top; null when it is in none
   *  or the host keeps no stacks. */
  prGetStack(ctx: IpcContext, number: number): Promise<PrStack | null>
  prListReviewers(ctx: IpcContext, number: number): Promise<PrReviewer[]>
  prListReviewerCandidates(ctx: IpcContext, number: number): Promise<PrReviewerCandidate[]>
  prRequestReviewers(ctx: IpcContext, number: number, logins: string[]): Promise<PrReviewer[]>
  prRemoveRequestedReviewer(ctx: IpcContext, number: number, reviewerId: string, kind?: PrReviewerKind): Promise<PrReviewer[]>
  prListLabelCandidates(ctx: IpcContext, number: number): Promise<PrLabel[]>
  /** Replace the label set. Answers the whole pull request, the way every
   *  other write does, so one apply path keeps list rows and detail in step. */
  prSetLabels(ctx: IpcContext, number: number, names: string[]): Promise<PullRequest>
  prUpdateLifecycle(ctx: IpcContext, number: number, action: PrStateAction, expectedHeadSha: string): Promise<PullRequest>
  prSubmitReview(ctx: IpcContext, number: number, review: DraftReview): Promise<void>
  prAddIssueComment(ctx: IpcContext, number: number, body: string): Promise<void>
  prDeleteIssueComment(ctx: IpcContext, number: number, commentId: string): Promise<void>
  prInterdiff(ctx: IpcContext, pr: PrReviewContext): Promise<import('@solus/contracts/types').PrInterdiffResult>
  prReplyThread(ctx: IpcContext, number: number, threadId: string, body: string): Promise<ReviewComment>
  prResolveThread(ctx: IpcContext, number: number, threadId: string): Promise<void>
  prUnresolveThread(ctx: IpcContext, number: number, threadId: string): Promise<void>
  /** Queue background guide generation for these PRs; resolves once queued. */
  prGenerateGuides(ctx: IpcContext, numbers: number[]): Promise<void>
  /**
   * A person's refresh: forget what the host remembered about this project's
   * pull requests and run a PR sync tick for it now. Changes arrive as
   * `pr.changed`. Reads share what has already been fetched; this is the one
   * way to opt out.
   */
  prRefresh(ctx: IpcContext): Promise<void>
  prMerge(ctx: IpcContext, number: number, method: MergeMethod, expectedHeadSha: string): Promise<PrMergeResult>
  /** Ask the host to merge with `method` once its requirements pass. Answers
   *  the whole pull request, armed. */
  prEnableAutoMerge(ctx: IpcContext, number: number, method: MergeMethod, expectedHeadSha: string): Promise<PullRequest>
  prDisableAutoMerge(ctx: IpcContext, number: number): Promise<PullRequest>
  /** Bring the base branch into the head on the host, checked against the
   *  head the viewer saw. Answers the whole pull request after the update. */
  prUpdateBranch(ctx: IpcContext, number: number, expectedHeadSha: string): Promise<PullRequest>
  /** Open a new pull request that reverses a merged one. */
  prRevert(ctx: IpcContext, number: number): Promise<PrRevertResult>
  /** Merge a stacked pull request and every open layer below it in one host
   *  operation. Needs `merge-stack` in both `capabilities.actions` and
   *  `viewerPermissions.actions`. */
  prMergeStack(ctx: IpcContext, request: PrStackMergeRequest): Promise<PrStackMergeResult>
  /** A host URL for media that a pull request points at on GitHub, such as
   *  `https://github.com/user-attachments/assets/<id>`. A private repository
   *  serves it only with a GitHub credential, so the host fetches it with its
   *  own and the client never gets the token. Only a URL that
   *  `githubMediaFetchUrl` accepts is signed. `repository` is the pull
   *  request's `owner/name`, which can differ from the checkout. GitHub needs
   *  it to serve an upload in an organization that enforces SAML SSO. */
  prMediaUrl(ctx: IpcContext | undefined, githubMediaUrl: string, repository?: string): Promise<AssetCreateUrlResult>
  /** The workflow runs of a fork pull request that wait for a maintainer. */
  prPendingWorkflowRuns(ctx: IpcContext, number: number): Promise<PrPendingWorkflowRuns>
  /** Approve the waiting workflow runs of a fork pull request, checked against
   *  the head the viewer saw. Needs `approve-workflows` in both action lists. */
  prApproveWorkflowRuns(ctx: IpcContext, number: number, expectedHeadSha: string): Promise<PrWorkflowApprovalResult>
  /** Which files the viewer marked viewed, as the code host keeps it. Needs
   *  `capabilities.viewedFiles`. */
  prViewedFiles(ctx: IpcContext, number: number): Promise<PrViewedFiles>
  /** Mark files viewed or not viewed on the code host. The last change to a
   *  path in `changes` wins. */
  prSetFilesViewed(ctx: IpcContext, number: number, changes: PrViewedFileChange[]): Promise<void>
  prPrepareConflictResolution(ctx: IpcContext, number: number): Promise<PrConflictResolutionResult>
  /** Cached checks for the repository's open PRs; failures are represented in the snapshot. */
  prChecks(ctx: IpcContext, numbers?: number[]): Promise<PrChecksSnapshot>

  /** Cached subscription quota per provider. Asking also keeps the backend's
   *  poll alive — it suspends itself once nobody is watching. */
  usageLimits(): Promise<AgentUsageLimits[]>
  /** The quota now, and keep the backend's poll alive until this client
   *  unwatches or disconnects; changes arrive as `usage.limitsChanged`. */
  usageWatch(): Promise<AgentUsageLimits[]>
  usageUnwatch(): Promise<void>

  /** This machine's load, read on demand and cached for 5 s. */
  hostResources(): Promise<HostResources>
  /** Web and API servers discovered on this host, independent of browser pages. */
  runningServersList(): Promise<RunningServer[]>
  /** Renew the connection's lease and return its current list. */
  runningServersWatch(checkoutPaths?: string[]): Promise<RunningServer[]>
  runningServersCheckoutRoots(paths: string[]): Promise<{ path: string; root: string | null }[]>
  runningServersUnwatch(): Promise<void>
  runningServerTunnel(serverId: string, endpointId: string): Promise<RunningServerTunnel>
  /** Forward a TCP port on this host's loopback interface. Requires host administration. */
  portForwardTunnel(port: number): Promise<RunningServerTunnel>
  runningServerStop(serverId: string): Promise<StopRunningServerResult>
  /** Start or renew this client's process telemetry, and read the current state.
   *  A subscription ends 20 s after its last renewal (`host.telemetry`). */
  hostTelemetrySubscribe(): Promise<HostTelemetry>
  hostTelemetryUnsubscribe(): Promise<void>

  // Observability / Insights (metrics.db query engine)
  /** Grouped rows from a builder/preset QuerySpec, compiled server-side. */
  metricsQuery(spec: MetricsQuerySpec): Promise<MetricsQueryResult>
  /** Rows from guarded read-only SQL (editor and NL paths). */
  metricsRunSql(sql: string): Promise<MetricsQueryResult>
  /** One page of turns for the normal Insights view. */
  metricsTurnPage(request: MetricsTurnPageRequest): Promise<MetricsTurnPageResult>
  /** Full-range aggregates for the same view: count, status chips, stats, histogram. */
  metricsTurnListingSummary(filter: MetricsTurnFilter): Promise<MetricsTurnListingSummary>
  /** prepare()-only validation: guard violations, SQLite errors, result columns. */
  metricsValidateSql(sql: string): Promise<MetricsSqlValidation>
  /** Compile a natural-language question to SQL via an ephemeral agent. */
  metricsCompileNl(ctx: IpcContext, question: string): Promise<MetricsNlCompileResult>
  /** The field registry: views, columns, types, descriptions. */
  metricsSchema(): Promise<MetricsSchema>
  /** Distinct values for a registered low-cardinality column. */
  metricsDistinctValues(column: string): Promise<MetricsValue[]>
  metricsListSavedQueries(): Promise<SavedMetricsQuery[]>
  metricsSaveQuery(query: SavedMetricsQuery): Promise<SavedMetricsQuery[]>
  metricsDeleteQuery(id: string): Promise<SavedMetricsQuery[]>
  /**
   * Absolute path of this host's durable `solus.log`, for opening it in an
   * editor. Always the production log, never a development `dev.log`.
   */
  logFilePath(): Promise<string>
  /** Root-turn rollup for session surfaces. */
  metricsSessionSummary(sessionId: string): Promise<MetricsSessionSummary>
  /** One turn's full span tree for the waterfall. */
  metricsTurnTrace(traceId: string): Promise<MetricsTurnTrace>
  /** Every mark a person has put on a turn on this host. Small: one row per
   *  marked turn, and a person marks few. */
  metricsListTurnFlags(): Promise<TurnFlag[]>
  /** Mark a turn, replacing any earlier mark on it. Answers the whole list. */
  metricsSetTurnFlag(flag: { traceId: string; kind: TurnFlagKind; note: string }): Promise<TurnFlag[]>
  /** Unmark a turn. Idempotent; answers the whole list. */
  metricsClearTurnFlag(traceId: string): Promise<TurnFlag[]>

  getReviewContext(ctx: IpcContext): Promise<ReviewContext | null>
  generateGuide(ctx: IpcContext, opts?: ReviewGuideRequestOptions): Promise<{ key: string; guide: ReviewGuide; persisted: boolean; outdated?: boolean } | null>
  requestReviewGuide(ctx: IpcContext, opts?: ReviewGuideRequestOptions): Promise<ReviewGuideStatusEvent | null>
  reviewGuideStatus(ctx: IpcContext, opts?: Pick<ReviewGuideRequestOptions, 'target' | 'scope'>): Promise<ReviewGuideStatusEvent | null>
  /** Saved-guide status for many listed pull requests in one round trip,
   * answered in request order. Reads host storage only and never asks the
   * code host; the caller compares the saved head with the head it listed. */
  prGuideStatuses(ctx: IpcContext, requests: PrGuideStatusRequest[]): Promise<(ReviewGuideStatusEvent | null)[]>
  cancelGenerateGuide(ctx: IpcContext, opts?: Pick<ReviewGuideRequestOptions, 'target' | 'scope'>): Promise<boolean>
  readGuide(ctx: IpcContext, key: string, target?: ReviewGuideTarget): Promise<ReviewGuide | null>
  readReviewState(ctx: IpcContext, key: string): Promise<ReviewState | null>
  writeReviewState(ctx: IpcContext, state: ReviewState): Promise<boolean>

  /** The lens for one target, with its comments and live job. Null when the
   * target has no checkout the host can resolve. */
  readReviewLens(ctx: IpcContext, target: ReviewTarget): Promise<ReviewLensSnapshot | null>
  /** The saved-lens revision of many listed pull requests in one round trip,
   * answered in request order; 0 means no lens. Reads host storage only. */
  prLensRevisions(ctx: IpcContext, targets: Extract<ReviewTarget, { kind: 'pr' }>[]): Promise<number[]>
  /** Queue a new lens. It replaces the current lens only when it succeeds. */
  requestReviewLens(ctx: IpcContext, request: ReviewLensGenerateRequest): Promise<ReviewLensSnapshot | null>
  /** Queue a lens edit on the current lens. */
  editReviewLens(ctx: IpcContext, request: ReviewLensEditRequest): Promise<ReviewLensSnapshot | null>
  cancelReviewLens(ctx: IpcContext, target: ReviewTarget): Promise<boolean>
  /** Swap the current lens and the previous version. */
  restoreReviewLens(ctx: IpcContext, target: ReviewTarget): Promise<ReviewLensSnapshot | null>
  updateReviewLensComments(ctx: IpcContext, target: ReviewTarget, change: ReviewLensCommentChange): Promise<ReviewLensCommentsResult>
  /** Post a lens comment to its pull request as a conversation comment. */
  postReviewLensComment(ctx: IpcContext, target: ReviewTarget, commentId: string): Promise<ReviewLensCommentsResult>
  /** Delete the conversation comment a lens comment posted. */
  retractReviewLensComment(ctx: IpcContext, target: ReviewTarget, commentId: string): Promise<ReviewLensCommentsResult>

  createWork(title: string, type: WorkType, content: string | undefined, preview: string | undefined, sessionId: string | undefined, agentProvider: AgentId, cwd?: string, id?: string): Promise<Work>
  /** `base` is the saved record the writer's edits are based on: its record
   *  version and its body's version. A save against a newer record is refused. */
  saveWork(id: string, updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>, base: Pick<Work, 'updatedAt' | 'contentVersion'>): Promise<Work>
  loadWork(id: string): Promise<Work | null>
  listWorks(): Promise<WorkListingMeta[]>
  deleteWork(id: string): Promise<void>
  duplicateWork(id: string): Promise<Work>
  linkWorkSession(id: string, sessionId: string): Promise<void>
  /** Execution plane: the host writes the work's content to one of its own paths. */
  worksExport(request: WorkExportRequest): Promise<WorkExportResult>
  loadWorkAnnotations(workId: string): Promise<WorkAnnotations | null>
  /** One change to a work's comment threads (docs/plans/multiplayer-comments.md). The
   *  host stamps who did it and answers the whole sidecar; everyone who can open the
   *  work hears `annotations.changed`. */
  applyWorkComment(workId: string, command: WorkCommentCommand): Promise<WorkAnnotations>
  /** The caller's own read mark on a thread; a viewer may leave one. */
  markWorkCommentRead(workId: string, commentId: string): Promise<WorkAnnotations>
  readWorkGoogleComments(workId: string): Promise<WorkExternalComments>
  refreshWorkGoogleComments(workId: string): Promise<WorkExternalComments>
  sendWorkGoogleComment(workId: string, command: ExternalCommentCommand): Promise<WorkExternalComments>
  readWorkExternalComments(workId: string): Promise<WorkExternalComments>
  refreshWorkExternalComments(workId: string): Promise<WorkExternalComments>
  sendWorkExternalComment(workId: string, command: ExternalCommentCommand): Promise<WorkExternalComments>
  /** An agent's save. `expectedContentVersion` is the `contentVersion` the agent read;
   *  a save against a later body is refused, never merged. */
  agentSaveWork(id: string, updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>, expectedContentVersion: number): Promise<Work>
  /** Every checkpoint of the work, oldest first, without bodies. */
  loadWorkRevisions(workId: string): Promise<WorkRevisionSummary[]>
  loadWorkRevision(workId: string, revisionId: number): Promise<WorkRevision>
  /** Make one checkpoint's body current again, as a new `restore` checkpoint.
   *  Nothing is deleted. `expectedContentVersion` is the body the reader compared
   *  it against; a newer body is refused, never displaced unseen. */
  restoreWorkRevision(workId: string, revisionId: number, expectedContentVersion: number): Promise<Work>
  /** Work review (docs/plans/work-review-and-live-editing.md): the reviewers,
   *  their decisions, whether each is stale, and the derived review state. */
  workReviewGet(workId: string): Promise<WorkReview>
  /** Ask members to review the body at `expectedContentVersion`. A member who
   *  cannot open the work is given it as a commenter. Needs `editor`. */
  workReviewRequest(workId: string, request: WorkReviewRequest): Promise<WorkReview>
  workReviewRemove(workId: string, reviewerId: string): Promise<WorkReview>
  /** The caller's decision. The host names the reviewer from the principal and
   *  the hash from the named checkpoint. Needs `commenter`. */
  workReviewDecide(workId: string, decide: WorkReviewDecide): Promise<WorkReview>
  /** The works that wait for the caller's review. */
  workReviewInbox(): Promise<WorkReviewInboxItem[]>
  /** The review state of every work the caller can open that has reviewers. */
  workReviewStates(): Promise<WorkReviewStateEntry[]>
  /** Live editing (docs/plans/work-review-and-live-editing.md, phase 3b): join the
   *  work's room and exchange what each side lacks. The room hears
   *  `workLive.update`, `workLive.awareness`, and `workLive.state`. */
  workLiveOpen(request: WorkLiveOpenRequest): Promise<WorkLiveOpenResult>
  /** This client's edits, durable on the host before the answer. Needs `editor`. */
  workLivePush(request: WorkLivePushRequest): Promise<WorkLivePushResult>
  /** This client's cursor and selection, relayed to the room and never stored. */
  workLiveAwareness(request: WorkLiveAwarenessRequest): Promise<void>
  workLiveClose(request: WorkLiveCloseRequest): Promise<void>
  setWorkPinned(id: string, pinned: boolean): Promise<void>

  docProviderStatuses(): Promise<DocProviderStatus[]>
  docDestinations(provider: DocProviderId): Promise<DocDestination[]>
  /** `destination` is required on the first publish and ignored afterwards;
   *  `force` publishes over an upstream change the user chose to discard. */
  publishWork(id: string, opts?: WorkPublishRequest): Promise<WorkPublishResult>
  pullWorkUpstream(id: string): Promise<WorkPullResult>
  /** Version metadata only — the presence-scoped staleness check. */
  refreshWorkUpstream(id: string): Promise<WorkExternalLink | null>
  unlinkWorkUpstream(id: string): Promise<void>
  publishPlan(request: PlanPublishRequest): Promise<WorkPublishResult>
  pullPlanUpstream(sessionId: string, planToolUseId: string): Promise<WorkPullResult>
  refreshPlanUpstream(sessionId: string, planToolUseId: string): Promise<WorkExternalLink | null>
  unlinkPlanUpstream(sessionId: string, planToolUseId: string): Promise<void>
  importDocFromUrl(url: string, cwd?: string): Promise<Work>
  getPluginCommands(workingDirectory: string, ctx?: IpcContext): Promise<PluginCommandsResult>

  /**
   * The person's task sources, as this host last read them for the caller
   * (docs/tasks.md). Tasks belong to no project: the client sends the sources
   * from the person's settings. The call also says that the caller wants these
   * sources: the host reads each one that is not fresh, or every one with
   * `refresh: 'force'`, and `tasks.sourcesChanged` says when a read ends. The
   * tasks themselves come with `tasksSidebarSnapshot`.
   */
  tasksSources(sources: TaskSource[], opts?: { refresh?: 'stale' | 'force' }): Promise<TaskSourceState[]>
  /** What the caller can choose as a task source. */
  tasksLoadMore(source: TaskSource): Promise<void>
  tasksSourceOptions(): Promise<TaskSourceOptions>
  /** Ask the provider for the tasks of these sources that match `query`.
   *  The only way to reach a task that a truncated source did not list. */
  tasksSearch(sources: TaskSource[], query: string, involvement?: TaskInvolvement): Promise<TaskSummary[]>
  tasksSidebarSnapshot(filter?: TaskSidebarFilter): Promise<TaskSidebarSnapshot>
  /** The tasks whose comments hold every word of a query (docs/plans/unified-search.md §7). */
  tasksSearchComments(query: TaskCommentSearchQuery): Promise<TaskCommentHit[]>
  /** Read one task from its provider, with its comments and its attachments on
   *  this host. Answers the host's last copy, with `fromCache`, when the
   *  provider does not answer. */
  tasksGet(id: string, read?: TaskDetailsRead): Promise<TaskDetails>
  tasksGet(id: string, read: TaskProviderRead): Promise<TaskProviderData>
  tasksGet(id: string, read?: TaskReadOptions): Promise<TaskDetails | TaskProviderData>
  tasksReact(id: string, targetId: string, content: TaskReactionContent, add: boolean): Promise<void>
  tasksTemplates(source: TaskSource): Promise<TaskTemplate[]>
  /** Resolve an issue URL. Clients that load history separately request details only. */
  tasksResolve(url: string, options?: { detailsOnly?: boolean }): Promise<TaskExternalIssue>
  /** The attachments of a task on a host that does not read the task itself. */
  tasksAttachments(id: string): Promise<TaskAttachments>
  /** Create a task on the provider. */
  tasksCreate(input: TaskCreateInput): Promise<Task>
  tasksPrepareForSession(input: PrepareSessionTaskRequest): Promise<PrepareSessionTaskResult>
  tasksSnapshot(taskId: string): Promise<TaskSnapshot>
  /** Change a task's fields on the provider. */
  tasksUpdate(id: string, patch: TaskUpdatePatch): Promise<Task>
  /** Move a task to a column of one source, or to a status category. */
  tasksMove(id: string, target: TaskMoveTarget): Promise<Task>
  /** Delete a draft item from its GitHub Project. An issue is closed or moved, never deleted. */
  tasksDelete(id: string): Promise<boolean>
  tasksMarkRead(id: string, read: boolean): Promise<Task>
  /** Hide the task from the caller's own task lists until `until`, or wake it
   *  now with null. Nobody else's lists change, and its agents keep working
   *  (docs/task-snooze.md). Answers the caller's snooze, null once woken. */
  tasksSnooze(id: string, until: number | null, note?: string): Promise<TaskSnooze | null>
  /** The caller's own task snoozes. `tasks.snoozesChanged` says to read again. */
  tasksSnoozes(): Promise<TaskSnooze[]>
  /** Post a comment to the provider. A comment the provider did not take stays
   *  on this host as `unsent`. */
  tasksComment(id: string, body: string): Promise<TaskDetails>
  /** Send an unsent comment again. */
  tasksRetryComment(id: string, commentId: string): Promise<TaskDetails>
  /** Discard an unsent comment. A sent comment is deleted on the provider, not here. */
  tasksDeleteComment(id: string, commentId: string): Promise<TaskDetails>
  /** The people the provider permits to be assigned: for one task, or for a
   *  new task in one source. */
  tasksListAssigneeCandidates(target: { taskId: string } | { source: TaskSource }): Promise<TaskAssigneeCandidate[]>
  tasksLinkSession(
    taskId: string,
    sessionId: string,
    role?: TaskSessionRole,
    /** Where the agent ran, when that is not this host. See `SessionExecutionHost`. */
    execution?: SessionExecutionHost | null,
  ): Promise<void>
  /** Detach a session from a task. The reverse of `tasksLinkSession`. */
  tasksUnlinkSession(taskId: string, sessionId: string): Promise<void>
  tasksSessions(taskId?: string): Promise<Record<string, TaskSessionLink[]>>
  tasksForSession(sessionId: string): Promise<TaskForSessionResult | null>
  tasksLink(taskId: string, input: TaskLinkInput): Promise<TaskAttachments>
  tasksUnlink(taskId: string, kind: TaskLinkKind, targetKey: string, targetScope?: string): Promise<TaskAttachments>
  /** The reverse read: which tasks on this host link each target. A card
   *  batches the targets it shows; the answer lists one row per edge. */
  tasksLinkedTo(targets: TaskLinkTarget[]): Promise<TaskLinkedTask[]>
  /** Render a linked `artifact` work to a still and post it, with the HTML
   *  where the provider takes files, as a comment on the task. */
  tasksAttachArtifact(taskId: string, workId: string): Promise<TaskDetails>

  outboxList(): Promise<OutboxOp[]>
  outboxAck(appliedIds: string[], failures?: Array<{ id: string; error: string }>): Promise<void>
  outboxApply(ops: OutboxOp[]): Promise<OutboxApplyResult>

  /** `executionPreferences` is the creator's preferences the automation runs with (plans/018 §6); absent from an older client. */
  automationCreate(name: string, action: AutomationAction, enabled?: boolean, trigger?: AutomationTrigger, executionPreferences?: ExecutionPreferences): Promise<Automation>
  automationList(): Promise<Automation[]>
  automationRead(id: string): Promise<Automation | null>
  /** A patch that carries `executionPreferences` replaces the automation's captured snapshot (plans/018 §6). */
  automationUpdate(id: string, patch: { archived?: boolean; name?: string; enabled?: boolean; favorite?: boolean; action?: Partial<AutomationAction>; trigger?: AutomationTrigger; executionPreferences?: ExecutionPreferences }): Promise<Automation | null>
  automationDelete(id: string): Promise<boolean>
  automationSetEnabled(id: string, enabled: boolean): Promise<Automation | null>
  automationRun(id: string): Promise<AutomationRun | null>
  automationCancel(id: string): Promise<boolean>
  automationListRuns(id: string): Promise<AutomationRun[]>
  /** The newest `perAutomation` runs of every automation, newest first within each. */
  automationRecentRuns(perAutomation: number): Promise<AutomationRunPoint[]>
  automationReadRun(automationId: string, runId: string): Promise<AutomationRun | null>

  /** Every webhook the caller may see (docs/plans/webhooks.md §4). Never the token. */
  webhookList(): Promise<Webhook[]>
  /** One webhook; with its URL and token only for its owner. */
  webhookRead(id: string): Promise<Webhook | WebhookWithUrl | null>
  webhookCreate(input: WebhookCreateInput): Promise<WebhookWithUrl>
  /** Pause and resume are `enabled`; `copiedUrl` records the URL the owner copied. */
  webhookUpdate(id: string, patch: WebhookUpdateInput): Promise<Webhook | null>
  webhookDelete(id: string): Promise<boolean>
  /** A new token: the old URL stops working at once. */
  webhookRotate(id: string): Promise<WebhookWithUrl | null>
  webhookListDeliveries(id: string, query?: WebhookDeliveryQuery): Promise<WebhookDeliverySummary[]>
  webhookReadDelivery(id: string, deliveryId: string): Promise<WebhookDelivery | null>
  /** Runs a stored delivery again, for every action or for one (plan §3.3). */
  webhookReplay(id: string, deliveryId: string, actionId?: string): Promise<WebhookDeliverySummary>
  /** Sends a test request, signed with the stored secret, through the receiver: the log keeps it as a delivery. */
  webhookSendTest(id: string): Promise<WebhookDeliverySummary>
  /** Tests a sample request against actions; starts nothing, stores nothing. `webhookId` also checks its verification. */
  webhookDryRun(request: WebhookDryRunRequest): Promise<WebhookDryRunResult>
  hostWebhookSettingsRead(): Promise<HostWebhookSettings>
  hostWebhookSettingsUpdate(patch: HostWebhookSettingsPatch): Promise<HostWebhookSettings>
  /** Answers a `secret` card: one value for each of its questions, in order, null for each secret declined. The values go to the host's secret-ref store only, never to the transcript. */
  secretRequestAnswer(sessionId: string, questionId: string, values: (string | null)[]): Promise<boolean>
  /** The Solus API: the organization webhooks of every host, for an organization admin. */
  webhookAdminList(organizationId: string): Promise<WebhookAdminOutcome<WebhookAdminList>>
  /** The Solus API: an admin pause. The forwarder refuses the webhook at once; the host within 5 minutes. */
  webhookAdminPause(ref: WebhookAdminRef): Promise<WebhookAdminOutcome<null>>
  webhookAdminResume(ref: WebhookAdminRef): Promise<WebhookAdminOutcome<null>>

  skillsList(): Promise<import('./skill-types').SkillListResult>
  skillsRemove(name: string): Promise<import('./skill-types').SkillRemoveResult>
  skillsSearch(query: string): Promise<RemoteSkill[]>
  skillsInstall(id: string): Promise<SkillInstallResult>

  pinnedSessionsList(): Promise<PinnedSession[]>
  togglePinnedSession(session: PinnedSession): Promise<PinnedSession[]>
  /** Move a session's read boundary: a timestamp records a read, null returns
   *  it to unread. Answers with the boundary the host settled on, which can be
   *  older than the one sent — a read never moves the boundary backward. */
  setSessionReadState(sessionId: string, viewedAt: number | null): Promise<number | null>
  /** Foreground heartbeat: hosts skip watch-fired freshness work while no
   *  client holds a live lease (dispatch-client step 7). */
  activityLease(foreground: boolean): Promise<{ ok: boolean }>
  /** The phone's Live Activity card and its push token: while the phone is
   *  suspended, this host reports its rows of the card to the control plane,
   *  which sends the card through APNs (docs/plans/live-activity-push.md). */
  liveActivityRegister(registration: LiveActivityRegistration): Promise<void>
  /** The card ended, or the token no longer belongs to it. */
  liveActivityUnregister(pushToken: string): Promise<void>

  worktreeListProject(ctx: IpcContext): Promise<WorktreeEntry[]>
  diff(ctx: IpcContext, request: DiffRequest): Promise<DiffResult | null>
  diffFileContents(ctx: IpcContext, request: DiffFileContentsRequest): Promise<DiffFileContentsResult | null>
  diffStats(ctx: IpcContext, request: DiffRequest): Promise<ChangedFileStat[]>
  /** `diffStats` for several scopes of one checkout in one call, answered in
   *  request order: the turn cards of a conversation ask together. At most
   *  `DIFF_STATS_BATCH_LIMIT` requests. */
  diffStatsBatch(ctx: IpcContext, requests: DiffRequest[]): Promise<ChangedFileStat[][]>
  listTurnSnapshots(ctx: IpcContext): Promise<TurnSnapshot[]>
  gitRunAction(ctx: IpcContext, request: GitActionRequest): Promise<GitActionResult>
  gitDiscard(ctx: IpcContext): Promise<GitDiscardResult>
  gitSync(ctx: IpcContext): Promise<GitSyncResult>
  /** `create` makes the branch from HEAD; otherwise the branch must exist.
   *  The host reads the refs again: a branch already in another worktree
   *  names that worktree instead of a switch, and a remote branch becomes a
   *  local branch that tracks it. `remoteOnly` says the person picked the
   *  remote branch, so a local branch of that name must track it. */
  gitCheckoutBranch(ctx: IpcContext, branch: string, options?: { create?: boolean; remoteOnly?: boolean }): Promise<GitCheckoutBranchResult>
  /** `skipFetch` lists the refs on disk now instead of after a fetch. */
  worktreeBranches(ctx: IpcContext, options?: { remoteOnly?: boolean; skipFetch?: boolean }): Promise<BranchRef[]>
  worktreeRestore(ctx: IpcContext, worktreePath: string): Promise<GitCheckout | null>
  continueInWorktree(ctx: IpcContext, namePrompt?: string): Promise<GitCheckoutBranchResult>
  /** Answer a `worktree_offered` activity: switch the session into the agent's
   *  worktree, or keep its current checkout. Returns the recorded resolution;
   *  an offer already answered returns its answer unchanged. */
  decideWorktreeOffer(ctx: IpcContext, offerId: string, decision: 'switch' | 'keep'): Promise<WorktreeOfferResolution>
  checkoutSnapshot(paths: string[]): Promise<CheckoutSnapshot>
  gitRefreshState(cwd: string, options?: GitStateOptions): Promise<GitState | null>
  gitIdentity(cwd: string): Promise<GitIdentity | null>
  gitRegisterEnvironment(ctx: IpcContext, cwd: string, gitContext: GitCheckout | null): Promise<void>
  /** Whether `cwd` is a Git repository at all — distinct from `GitState`, which
   *  is also null for a repository with no commits yet. */
  gitRepositoryStatus(cwd: string): Promise<GitRepositoryStatus>
  /** Runs `git init` on a non-repository folder. Never creates a commit. */
  gitInitRepository(cwd: string): Promise<GitInitRepositoryResult>
  /** Creates or reuses a GitHub repository, adds a credential-free remote, and
   *  pushes existing commits. Resolves with every stage's outcome even when a
   *  later stage fails, so a created repository is never silently dropped. */
  githubPublishRepository(ctx: IpcContext, request: GithubPublishRepositoryRequest): Promise<GithubPublishRepositoryResult>
  projectConfigLoad(cwd: string): Promise<ProjectConfig | null>
  projectConfigSave(cwd: string, config: ProjectConfig): Promise<ProjectConfig>
  listProjects(): Promise<ProjectEntry[]>
  listProjectIdentities(): Promise<ProjectIdentity[]>
  resolveDispatchHistoryRoots(repoKeys: string[]): Promise<DispatchHistoryRoot[]>
  deleteProject(projectPath: string): Promise<void>
  /** Takes a folder off this host's project list. Its tasks, sessions and
   *  files stay; adding the folder again lists it again. */
  untrackProject(projectPath: string): Promise<void>
  isVisible(ctx?: IpcContext): Promise<boolean>
  getAppGlobalShortcuts(): Promise<AppGlobalShortcuts>
  setAppGlobalShortcuts(shortcuts: AppGlobalShortcuts): Promise<SetAppGlobalShortcutsResult>
  restartApp(): Promise<void>
  getPlatform(): string
  getLocalConnection(): Promise<LocalConnectionInfo | null>

  updateAgentFiles(ctx: IpcContext, text: string): Promise<{ success: boolean; files?: string[]; err?: string }>


  /** Native-only: resolves the OS path for a File. Web stub returns ''. */
  getPathForFile(file: File): string

  /** Tell main which conversation owns the current text selection, gating the
   *  native transcript context-menu actions and preserving their source tab. */
  setQuoteContext(tabId: string | null): void
  /** Fires when the user picks "Quote in reply" on selected conversation text. */
  onQuoteSelection(callback: (text: string, sourceTabId: string) => void): () => void
  /** Fires when selected conversation text should seed a forked split session. */
  onAskSelectionInNewSession(callback: (text: string, sourceTabId: string) => void): () => void

  /** Native context-menu action for a URL selected in a conversation. */
  onOpenSelectedLink(callback: (url: string, sourceTabId: string) => void): () => void

  /** Running dev servers this host can offer as browser targets. Discovery
   *  only: Solus does not own these processes. */
  browserRuntimeStatus(): Promise<BrowserRuntimeStatus>
  browserRuntimeInstall(): Promise<BrowserRuntimeStatus>
  browserListTargets(ctx?: IpcContext): Promise<BrowserDiscoveredTarget[]>
  browserListPages(): Promise<BrowserPage[]>
  browserOpen(request: BrowserOpenRequest): Promise<BrowserPage>
  /** Close a page, unless an agent is using it. A refusal is an answer, not an
   *  error; `force` is what the user's "close anyway" carries back (ADR 0024). */
  browserClose(browserPageId: string, force?: boolean): Promise<BrowserCloseResult>
  browserNavigate(browserPageId: string, op: BrowserNavigateOp): Promise<void>
  browserSetViewport(browserPageId: string, request: BrowserViewportRequest): Promise<void>
  browserSetAppearance(browserPageId: string, appearance: BrowserAppearance): Promise<void>
  /** One of `BROWSER_ZOOM_LEVELS`. */
  browserSetZoom(browserPageId: string, zoomFactor: number): Promise<void>
  /** Answer the page's open JavaScript dialog. Null when none was open. */
  browserAnswerDialog(browserPageId: string, answer: BrowserDialogAnswer): Promise<BrowserPageDialog | null>
  /** Sign an upload of one file for the page's open file chooser. */
  browserFileUploadToken(browserPageId: string, request: AttachmentUploadTokenRequest): Promise<AttachmentUploadTokenResult>
  /** Give the page's file chooser the files uploaded for it, or cancel it with null. */
  browserAnswerFileChooser(browserPageId: string, hostPaths: string[] | null): Promise<void>
  browserSnapshot(browserPageId: string, options?: BrowserSnapshotOptions): Promise<BrowserSnapshot>
  browserInteract(browserPageId: string, op: BrowserInteractOp): Promise<BrowserInteractResult>
  /** A desktop client hands its mounted `<webview>` to the server, which drives
   *  it in-process from Electron main. Desktop-local only. */
  browserAttachSurface(browserPageId: string, webContentsId: number): Promise<void>
  browserDetachSurface(browserPageId: string, reason?: BrowserDetachReason): Promise<void>
  browserReportSurface(browserPageId: string, report: BrowserSurfaceReport): Promise<void>
  /** Forget one of the caller's browser profiles: its cookies and storage. The
   *  host takes the person from the connection, so a caller clears only their
   *  own jar (docs/plans/member-isolation.md §6). */
  browserClearProfile(projectRoot: string | undefined, profileId: string): Promise<void>
  /** Start receiving streamed frames for a page: how a client with no native
   *  surface (web, mobile) sees it. The host streams only while at least one
   *  client is subscribed, so a hidden pane costs no frames. The subscribing
   *  client is taken from the connection, not an argument. `caps` are the
   *  device pixels the client's pane can show; absent means the page's own. */
  browserSubscribeFrames(browserPageId: string, caps?: BrowserFrameCaps): Promise<void>
  browserUnsubscribeFrames(browserPageId: string): Promise<void>
  /** A subscribed client's pane grew: stream up to these device pixels. */
  browserSetFrameCaps(browserPageId: string, caps: BrowserFrameCaps): Promise<void>
  /**
   * Capture the page and file the result.
   *
   * The capture becomes a host-owned asset either way; `attach` is what turns it
   * into evidence — a comment on the task the work belongs to, or a comment on
   * the pull request a human will read. This is the same path an agent's
   * `browser_snapshot` uses, so a capture taken by hand and a capture taken by
   * an agent are the same kind of thing.
   */
  browserCaptureEvidence(request: BrowserCaptureRequest): Promise<BrowserEvidence>
  /** Start recording a page on the host. Idempotent: a page that is already
   *  recording keeps its recording. */
  browserRecordingStart(browserPageId: string): Promise<BrowserRecordingState>
  /** Stop, store as MP4, and optionally file the recording. */
  browserRecordingStop(request: BrowserRecordingStopRequest): Promise<BrowserRecordingResult>
  /** What this page's capture could be filed against — the worktree it is
   *  serving, and the pull request open on that branch, if any. */
  browserEvidenceOptions(browserPageId: string): Promise<BrowserEvidenceOptions>
  /**
   * Open Chromium's own DevTools on the page's guest, detached.
   *
   * The whole browser inspector, on the same emulated guest the pane shows —
   * elements, styles, network, the console — rather than a reimplementation of
   * it inside Solus. It costs the CDP session while it is open, so the page
   * cannot be driven, snapshotted, or streamed until DevTools is closed; the
   * page says so through `devToolsOpen`, and Solus takes the session back and
   * re-applies the emulation by itself when the window closes.
   */
  browserOpenDevTools(browserPageId: string): Promise<void>
  /** Arm an annotation tool on a page, or disarm with null. The overlay lives in
   *  the guest, so this serves the native and the streamed surface alike. */
  browserSetAnnotationTool(browserPageId: string, tool: BrowserAnnotationTool | null): Promise<BrowserAnnotationState>
  /** What the user has marked so far. Read on demand rather than pushed: the
   *  marks are made in the guest, and only the pane showing them needs them. */
  browserAnnotationState(browserPageId: string): Promise<BrowserAnnotationState>
  browserAnnotate(browserPageId: string, op: BrowserAnnotateOp): Promise<BrowserAnnotationState>

  // ─── Native devices (docs/plans/native-devices.md) ───
  /** The current revisioned device snapshot. No discovery, install or start. */
  deviceState(): Promise<DeviceState>
  /** Discover devices on every device host. Starts the hub only once setup enabled it. */
  deviceList(): Promise<DeviceState>
  /** Re-read tool versions and platforms. Never installs or starts anything. */
  deviceToolInspect(): Promise<DeviceState>
  /** Settings and foreground app as read from the device. */
  deviceDetail(target: DeviceTarget): Promise<DeviceDetail>
  deviceConfigure(request: DeviceConfigureRequest): Promise<DeviceState>
  /** Add or replace one SSH or Simlock device source on this Solus host. */
  deviceHostSave(config: DeviceHostConfig): Promise<DeviceState>
  deviceHostRemove(deviceHostId: string): Promise<DeviceState>
  /** Read-only source check: SSH tools, Expo account, or Simlock identity. Starts no devices. */
  deviceHostTest(config: DeviceHostConfig): Promise<DeviceHostTestResult>
  deviceToolUpdate(request: DeviceToolUpdateRequest): Promise<DeviceState>
  deviceHostRetry(deviceHostId: string): Promise<DeviceState>
  /** Ask a connected iPhone or iPad to pair with the device host. Waits until the person accepts on the device. */
  devicePair(target: DeviceTarget): Promise<DeviceState>
  /** Show a device in a session, booting it when asked. */
  deviceOpen(request: DeviceOpenRequest): Promise<DevicePreview>
  /** Remove a session's preview. The last cloud preview also ends its session or lease. */
  deviceClose(request: DeviceCloseRequest): Promise<void>
  /** Power a device off. Every session's preview of it ends. */
  deviceShutdown(request: DeviceShutdownRequest): Promise<void>
  deviceAction(request: DeviceActionRequest): Promise<DeviceDetail>
  /** A short-lived path that opens this device's video and input socket through the host's hub proxy. */
  deviceStreamUrl(target: DeviceTarget): Promise<DeviceStreamUrl>
  deviceScreenshot(request: DeviceScreenshotRequest): Promise<DeviceScreenshotResult>
  /** Take control of a device. From an agent, pauses its device actions. */
  deviceControlAcquire(request: DeviceControlRequest): Promise<DeviceControlResult>
  deviceControlRelease(target: DeviceTarget): Promise<void>
  /** Let agents act on this device again after a takeover. */
  deviceControlResume(target: DeviceTarget): Promise<void>
  /** Install a recorded build on a device under the caller's control lease, then open it. */
  deviceInstall(request: DeviceInstallRequest): Promise<DeviceBuild>
  /** Remove a build from the host's list, and the copy Solus keeps of it. Agent and project outputs stay on disk. */
  deviceBuildRemove(buildId: string): Promise<void>
  /** Whether the project at this host path builds a mobile app. Reads names only, to a fixed depth. */
  deviceProjectDetect(projectPath: string): Promise<DeviceProjectInfo>
  /** The Apple teams this host can sign iPhone and iPad builds for. Empty when it has no Apple certificate. */
  deviceSigningTeams(): Promise<DeviceSigningTeam[]>
  /** Build a project run profile in a checkout, then install and open it on a device. */
  deviceRunStart(request: DeviceRunStartRequest): Promise<DeviceRun>
  /** Stop a run's build. Only the process the host started is stopped. */
  deviceRunCancel(runId: string): Promise<void>
  deviceRunLog(runId: string): Promise<DeviceRunLog>

  /** The caller's named identities in a project. Host-owned, because the cookie
   *  jars live there; personal, so a caller lists and changes only their own
   *  profiles. The built-in default is always first. */
  browserListProfiles(projectRoot?: string): Promise<BrowserProfileSet>
  browserCreateProfile(projectRoot: string | undefined, name: string): Promise<BrowserProfileSet>
  browserRenameProfile(projectRoot: string | undefined, profileId: string, name: string): Promise<BrowserProfileSet>
  /** Forget a profile and everything signed in to it. Refused for the built-in
   *  default, and refused while a page is open on it — a live login is not
   *  something to lose to a mis-click on a list. */
  browserDeleteProfile(projectRoot: string | undefined, profileId: string): Promise<BrowserProfileSet>
  /** Which profile a newly opened page in this project takes. */
  browserSetDefaultProfile(projectRoot: string | undefined, profileId: string): Promise<BrowserProfileSet>
  /** Browser profiles on *this host* that could be imported from. The host
   *  answers, because the copy lands in a jar on the host. */
  browserListCookieSources(): Promise<BrowserCookieSourceScan>
  /** Open the host's operating-system setting that grants access to a source the
   *  scan listed as unavailable with `canRequestAccess`. The host chooses the
   *  destination from the source id; a client never names a URL on the host. */
  browserRequestCookieAccess(sourceId: string): Promise<void>
  /** Copy one browser profile's cookies into one Solus profile, once. Only
   *  counts cross back; no cookie name, value, or domain does. */
  browserImportCookies(request: BrowserCookieImportRequest): Promise<BrowserCookieImportResult>

}

/** Why an account-plane settings call returned no document. */
export type SettingsRequestFailure =
  /** 401, or no account session: sign in again. */
  | { kind: 'signed-out' }
  /** The account website did not answer. Nothing is known about a write. */
  | { kind: 'offline' }
  /** Any other refusal, or an answer the schema does not accept. */
  | { kind: 'error'; code: string; message: string | null }

export type AccountSettingsResult =
  | { kind: 'ok'; settings: AccountSettingsResponse }
  /** 409: a stale revision, or a cleared generation. `current` is the stored document. */
  | { kind: 'conflict'; reason: 'settings_conflict' | 'settings_generation_changed'; current: AccountSettingsResponse }
  | SettingsRequestFailure

/** The account agent profile (plans/020-agent-profile.md §3), the same way. */
export type AccountAgentProfileResult =
  | { kind: 'ok'; profile: AccountAgentProfileResponse }
  /** 409: a stale revision, or a cleared generation. `current` is the stored document. */
  | { kind: 'conflict'; reason: 'profile_conflict' | 'profile_generation_changed'; current: AccountAgentProfileResponse }
  | SettingsRequestFailure

/** The person's account vault (docs/plans/cloud-vault.md §2.3): every connection's status, read and started from a client. */
export type AccountVaultResult =
  | { kind: 'ok'; connections: VaultConnection[] }
  | SettingsRequestFailure
export type AccountVaultConnectResult =
  | { kind: 'ok'; start: VaultConnectResult }
  /** The server is not in the person's profile and is no usable public server, or its sign-in could not start. */
  | { kind: 'refused'; message: string }
  | SettingsRequestFailure

/** An answer of the policy API (plans/030 §5.2). */
export type PolicyApiResult<Value> =
  | { kind: 'ok'; value: Value }
  /** 409: another owner saved first. */
  | { kind: 'conflict'; revision: number; document: unknown }
  /** 422: the validator refused the document, or another organization owns the host's `host` section. */
  | { kind: 'rejected'; reason: 'policy_invalid' | 'host_owned_by_other_organization'; issues: string[] }
  /** 403 or 404: not a member, not an owner for a write, or the organization is gone. */
  | { kind: 'forbidden' }
  | SettingsRequestFailure

/** A key chord a focused browser page gives to Solus. `mod` is already resolved
 *  to Command or Control for this platform, so main matches it as written. */
export interface GuestShortcut {
  code: string
  alt: boolean
  shift: boolean
  meta: boolean
  ctrl: boolean
}

export interface NativeSolusAPI {
  serverForwardStart(request: NativeServerForwardRequest): Promise<NativeServerForward>
  serverForwardStop(forwardId: string): Promise<void>
  serverForwardList(): Promise<NativeServerForward[]>
  getPlatform(): string
  /** Null when the local host is off (docs/plans/desktop-remote-only.md). */
  getLocalConnection(): Promise<LocalConnectionInfo | null>
  /** Re-invokes the local-connection bootstrap to pull a fresh session token over IPC. */
  refreshLocalSessionToken(): Promise<string>
  /** Turns this computer's host on or off: saves the choice and relaunches the app. */
  setLocalHostEnabled(enabled: boolean): Promise<void>
  openExternal(url: string, options?: { hideAppAfterOpen?: boolean }): Promise<boolean>
  setActivityBadge(sessionKeys: string[]): Promise<void>
  onActivityAcknowledged(callback: () => void): () => void
  showNotification(request: ClientNotificationRequest): Promise<boolean>
  logNotificationSound(row: NotificationSoundLog): void
  logShareDialog(row: ShareDialogLog): void
  rendererReady(): void
  rendererMounted(): void
  getPathForFile(file: File): string
  readAttachmentBytes(path: string, mime: string): Promise<{ dataUrl: string; size: number }>
  /** Applies UI zoom to this window's webContents; main clamps the factor. */
  setZoomFactor(factor: number): void
  setQuoteContext(tabId: string | null): void
  onQuoteSelection(callback: (text: string, sourceTabId: string) => void): () => void
  onAskSelectionInNewSession(callback: (text: string, sourceTabId: string) => void): () => void
  onOpenSelectedLink(callback: (url: string, sourceTabId: string) => void): () => void
  /** A location the app was asked to open from outside the renderer — today a
   *  notification click; the payload is a serialized route. */
  onOpenRoute(callback: (route: string) => void): () => void
  onThemeChange(callback: (isDark: boolean) => void): () => void
  onWindowShown(callback: () => void): () => void
  onWindowHidden(callback: () => void): () => void
  /** Chromium brackets each trackpad scroll, momentum included, with a begin
   *  and an end. DOM wheel events carry no such phase; the history swipe
   *  reads the end as the fingers lifting. */
  onTrackpadScroll(callback: (phase: 'begin' | 'end') => void): () => void
  /** The Solus shortcuts that must still work while a browser page has focus.
   *  A `<webview>` guest is its own process, so its keys never reach the
   *  renderer's listener; main takes these out of the guest and sends them back. */
  setGuestShortcuts(shortcuts: GuestShortcut[]): void
  onGuestShortcut(callback: (shortcut: GuestShortcut) => void): () => void
  /** The Solus account this install is signed in to. Owned by the main process;
   *  the renderer never sees the refresh token. */
  accountState(): Promise<AccountState>
  /** Runs the whole browser sign-in (authorization code with PKCE); resolves when it ends. */
  accountSignIn(): Promise<SignInEnd>
  accountCancelSignIn(): void
  accountSignOut(): Promise<void>
  /** Re-checks a stored session with the website now. */
  accountRetryVerify(): Promise<void>
  onAccountStateChange(callback: (state: AccountState) => void): () => void
  /** Personal Uplink, on behalf of the signed-in account. Null when signed out or
   *  the website did not answer; the account token itself never crosses. */
  uplinkListDirectory(): Promise<UplinkDirectory | null>
  /** An access token for one host or the Solus API, never for the account plane.
   *  `refused` names a kept token the host refused: it is not given out again. */
  accountAccessToken(resource: ConnectionTokenResource, options?: { refused?: string }): Promise<string | null>
  uplinkIssueEnrollmentTicket(): Promise<UplinkEnrollmentTicket | null>
  /** People and teams of one organization, for the share dialog. */
  uplinkOrganizationDirectory(organizationId: string): Promise<OrganizationDirectory | null>
  /** Start the organization's managed host; the lifecycle it is in afterwards. */
  uplinkStartManagedHost(hostId: string): Promise<ManagedHostLifecycle | null>
  /** Stop a managed host (it keeps its disk), or restart a running one's service; the lifecycle afterwards. */
  uplinkStopManagedHost(hostId: string): Promise<ManagedHostLifecycle | null>
  uplinkRestartManagedHost(hostId: string): Promise<ManagedHostLifecycle | null>
  /** Change a managed host's packages or setup script; true when something changed, null when refused. */
  uplinkUpdateManagedHostSpec(hostId: string, change: ManagedHostSpecChangeRequest): Promise<boolean | null>
  /** Destroy a managed host's machine; true when the account no longer has it, so it is idempotent. */
  uplinkDeleteManagedHost(hostId: string): Promise<boolean>
  /** Create an organization's managed host; its host id, or why Solus Cloud did not. */
  uplinkCreateManagedHost(organizationId: string, options: { label?: string; spec?: ManagedHostSpecRequest }): Promise<CreateManagedHostOutcome>
  /** The signed-in account: organizations and the managed host size catalog. */
  uplinkReadAccount(): Promise<AccountResponse | null>
  /** End the registration of a host the account owns; true when the account no longer
   *  lists it, so it is idempotent. False when refused or unanswered. */
  uplinkRemoveHost(hostId: string): Promise<boolean>
  /** Account settings sync and organization settings (plans/018 §4), on behalf of
   *  the signed-in account. Main adds the token; each answer is decoded there. */
  accountSettingsGet(): Promise<AccountSettingsResult>
  accountSettingsPatch(request: AccountSettingsPatchRequest): Promise<AccountSettingsResult>
  accountSettingsDelete(): Promise<AccountSettingsResult>
  /** The account agent profile (plans/020-agent-profile.md §3), on behalf of the signed-in account, decoded in main. */
  accountAgentProfileGet(): Promise<AccountAgentProfileResult>
  accountAgentProfilePatch(request: AccountAgentProfilePatchRequest): Promise<AccountAgentProfileResult>
  accountAgentProfileDelete(): Promise<AccountAgentProfileResult>
  /** One call on one of the account's documents (`account-documents.ts`), with this client's sign-in. */
  accountDocument<N extends AccountDocumentName>(request: AccountDocumentRequest<N>): Promise<AccountDocumentResult<N>>
  /** The person's account vault (docs/plans/cloud-vault.md §2.3): every connection's status, start a sign-in, paste a key, disconnect. */
  accountVault(): Promise<AccountVaultResult>
  accountVaultConnect(request: VaultConnectRequest): Promise<AccountVaultConnectResult>
  accountVaultSaveKey(request: VaultSaveKeyRequest): Promise<AccountVaultResult>
  accountVaultDisconnect(request: VaultDisconnectRequest): Promise<AccountVaultResult>
  /** The organization's policy and its host policies (plans/030 §5.2), on behalf of the signed-in account. */
  organizationPolicyGet(organizationId: string): Promise<PolicyApiResult<OrganizationPolicyResponse>>
  organizationPolicyPut(organizationId: string, request: PolicyWriteRequest): Promise<PolicyApiResult<OrganizationPolicyResponse>>
  hostPoliciesGet(organizationId: string): Promise<PolicyApiResult<HostPoliciesResponse>>
  hostPolicyCreate(organizationId: string, request: HostPolicyCreateRequest): Promise<PolicyApiResult<HostPolicySummary>>
  hostPolicyPut(organizationId: string, policyId: string, request: PolicyWriteRequest): Promise<PolicyApiResult<HostPolicySummary>>
  hostPolicyDelete(organizationId: string, policyId: string): Promise<PolicyApiResult<null>>
  hostPolicyAssign(organizationId: string, hostId: string, request: HostPolicyAssignRequest): Promise<PolicyApiResult<PolicyHost>>
  hostPolicyUnassign(organizationId: string, hostId: string): Promise<PolicyApiResult<PolicyHost>>
  /** The desktop update status. Owned by the main process, which runs the
   *  checks and holds the auto-download setting. `docs/plans/desktop-updates.md`. */
  updateStatus(): Promise<DesktopUpdateStatus>
  checkForUpdate(): Promise<void>
  downloadUpdate(): Promise<void>
  /** Quit and install a ready update. Runs at once; the caller decides timing. */
  restartToUpdate(): void
  setUpdateAutoDownload(enabled: boolean): Promise<void>
  onUpdateStatusChange(callback: (status: DesktopUpdateStatus) => void): () => void
}
