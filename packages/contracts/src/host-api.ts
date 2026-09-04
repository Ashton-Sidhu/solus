import type { AgentId, AgentTaskLifecyclePolicy, AgentUsageLimits, IpcContext, PromptOptions, PromptDelivery, PromptDispatchResult, Attachment, SessionMeta, SessionSearchResult, SessionGeneratedMetadata, SessionMetadataGenerationContext, RecentProject, DetectedEditor, DetectedTerminal, ResolvedTerminal, TerminalAppId, OpenInEditorRequest, FilePreviewRequest, FilePreviewResult, ProjectContentSearchRequest, ProjectContentSearchResult, ProjectFilesRequest, ProjectFilesResult, ProjectFileMutationRequest, ProjectFileMutationResult, WriteFileRequest, WriteFileResult, FileMatch, DirectoryListResult, CreateDirectoryResult, DesignAnnotation, PluginCommandsResult, RemoteSkill, SkillInstallResult, GitCheckout, TurnSnapshot, DiffResult, DiffFileContentsRequest, DiffFileContentsResult, ChangedFileStat, WorktreeEntry, GitActionRequest, GitActionResult, GitDiscardResult, GitSyncResult, GitCheckoutBranchResult, GitIdentity, GitState, GitStateOptions, GitRepositoryStatus, GitInitRepositoryResult, GithubPublishRepositoryRequest, GithubPublishRepositoryResult, ProjectConfig, ProjectEntry, ProjectIdentity, DispatchHistoryRoot, PlanDescriptor, PlanAnnotations, DiffRequest, RateLimitDecisionAction, RuntimeSessionInfo, SessionLineageResolution, SessionProviderSwitchResult, ThreadGoal, ThreadGoalSetRequest, Work, WorkMeta, WorkType, WorkAnnotations, WorkPrevious, PinnedSession, SavedPrompt, AppGlobalShortcuts, SetAppGlobalShortcutsResult, StartInfo, Automation, AutomationAction, AutomationCreator, AutomationRun, AutomationTrigger, AuthStatus, PrCheckoutContext, PrReviewContext, MergeMethod, PrMergeResult, PrConflictResolutionResult, ServerCapabilities, HostCapabilities, DiscoveredServer, SshBootstrapResult, WebPushSubscriptionJSON, SetupAgent, SetupAdoptProjectResult, SetupAgentAuthCheckResult, SetupCloneProjectRequest, SetupCloneProjectResult, SetupPrepareProjectRequest, SetupPrepareProjectResult, SetupSyncProjectRequest, SetupGithubReposResult, SetupSshAccessResult, SetupStepResult, HostReadiness, GitCommitIdentity, VoiceModelStatus, HeadlessSessionRequest, GithubDelegatedCredential, OtelSettings, OtelSettingsSnapshot, TextGenerationSettings, TextGenerationSettingsSnapshot } from './types'
import type { PrDiffFileContents, PrDiffFileContentsRequest, PrDiffRequest, PrDiffSlice, PrEffortRequest, PrEffortResult, PrFilter, PrLabel, PrLifecycleAction, PrListPage, PrReviewer, PrReviewerCandidate, PrReviewTarget, PullRequest, PullRequestOverview, PullRequestUpdate, ReviewThread, ReviewComment, PrCommit, PrConversationItem, DraftReview, ProviderViewer } from './providers'
import type { CandidateTicket, PrepareSessionTaskRequest, PrepareSessionTaskResult, SessionExecutionHost, Task, TaskAssigneeCandidate, TaskCandidateOptions, TaskCreateInput, TaskDetails, TaskExternalLink, TaskForSessionResult, TaskLinkInput, TaskLinkKind, TaskLinkTarget, TaskLinkedTask, TaskListFilter, TaskListResult, TaskProviderStatus, TaskSessionLink, TaskSessionRole, TaskSidebarSnapshot, TaskSnapshot, TaskUpdatePatch } from './task-types'
import type { OutboxApplyResult, OutboxOp } from './outbox-types'
import type { SessionPreviewResult, WireSessionLoadMessage } from './session-history'
import type { AttentionEntry } from './attention-types'
import type { ReviewLedger, ReviewContext, ReviewGuide, ReviewState, ReviewGuideStatusEvent, ReviewGuideRequestOptions, PrGuideMetadata, PrGuideMetadataRequest } from './review'
import type { StackGraph } from './stack-types'
import type { PrChecksSnapshot } from './checks-rpc-types'
import type { AssetCreateUrlRequest, AssetCreateUrlResult, AssetUploadRequest, AssetUploadResult, AttachmentUploadRequest, SearchSessionsRequest } from './rpc'
import type { MetricsNlCompileResult, MetricsQueryResult, MetricsQuerySpec, MetricsSchema, MetricsSessionSummary, MetricsSqlValidation, MetricsTurnPageRequest, MetricsTurnPageResult, MetricsTurnTrace, MetricsValue, SavedMetricsQuery } from './observability-types'
import type { ClientNotificationRequest, NotificationSoundLog } from './notification-types'
import type { BrowserAnnotateOp, BrowserAnnotationState, BrowserAnnotationTool, BrowserAppearance, BrowserCaptureRequest, BrowserDetachReason, BrowserDiscoveredTarget, BrowserEvidence, BrowserEvidenceOptions, BrowserInteractOp, BrowserInteractResult, BrowserNavigateOp, BrowserOpenRequest, BrowserPage, BrowserSnapshot, BrowserSnapshotOptions, BrowserSurfaceReport, BrowserViewportRequest } from './browser-types'
import type { AtlassianJiraProject, AtlassianOAuthStartResult, AtlassianStatus } from './atlassian'
import type { CodeIntelDocsRequest, CodeIntelDocsResult, CodeIntelInstallRequest, CodeIntelInstallResult, CodeIntelReferencesRequest, CodeIntelReferencesResult, CodeIntelReindexRequest, CodeIntelReindexResult, CodeIntelStatus, CodeIntelStatusRequest, CodeIntelSymbolRequest, CodeIntelSymbolResult } from './code-intel'
import type { DocDestination, DocProviderId, DocProviderStatus, PlanPublishRequest, WorkExternalLink, WorkPublishRequest, WorkPublishResult, WorkPullResult } from './docs'
import type { GoogleAuthStatus } from './google-auth'
import type { HostConfigPatch, HostConfigSnapshot } from './host-config'
import type { InboxInvolvement, InboxUpstreamResult } from './inbox-types'

import type { AccountState, DeviceSignInEnd } from './account-types'
import type { HostGrantResponse, UplinkDirectory, UplinkEnrollmentTicket, UplinkLinkRequest, UplinkStatus } from './uplink'

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
  watchSession(input: { sessionId?: string; agentSessionId?: string; provider?: AgentId }): Promise<{ sessionId: string }>
  unwatchSession(sessionId: string): Promise<void>
  prompt(ctx: IpcContext, options: PromptOptions): Promise<PromptDispatchResult>
  retry(ctx: IpcContext, options: PromptOptions): Promise<void>
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
  assetUpload(request: AssetUploadRequest): Promise<AssetUploadResult>
  assetCreateUrl(ctx: IpcContext | undefined, request: AssetCreateUrlRequest): Promise<AssetCreateUrlResult>
  takeScreenshot(ctx?: IpcContext): Promise<Attachment | null>
  pasteImage(dataUrl: string, ctx?: IpcContext): Promise<Attachment | null>
  transcribeAudio(audio: Float32Array | string, ctx?: IpcContext): Promise<{ error: string | null; transcript: string | null }>
  warmTranscription(ctx?: IpcContext): Promise<void>
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
  /** Project-wide content search (live grep over the workspace index). */
  searchProjectContents(ctx: IpcContext, request: ProjectContentSearchRequest): Promise<ProjectContentSearchResult>
  /** `annotate` adds per-entry repo/branch/project marks — costs a stat per folder. */
  listDirectory(path: string, showHidden?: boolean, annotate?: boolean): Promise<DirectoryListResult>
  createDirectory(path: string): Promise<CreateDirectoryResult>
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
  respondPermission(ctx: IpcContext, questionId: string, optionId: string, updatedPlan?: string): Promise<boolean>
  writePlanFile(filePath: string, content: string, ctx?: IpcContext): Promise<{ ok: boolean; error?: string }>
  respondQuestion(ctx: IpcContext, questionId: string, answers: Record<string, string>): Promise<boolean>
  rateLimitDecision(ctx: IpcContext, action: RateLimitDecisionAction): Promise<boolean>
  cancelQueuedPrompt(ctx: IpcContext, queueId: string): Promise<boolean>
  editQueuedPrompt(ctx: IpcContext, queueId: string, text: string): Promise<boolean>
  bindRuntimeSession(ctx: IpcContext): Promise<RuntimeSessionInfo | null>
  resetSession(ctx: IpcContext): Promise<void>
  listSessions(projectPath?: string, ctx?: IpcContext, provider?: AgentId, streamId?: string, limit?: number): Promise<SessionMeta[]>
  searchSessions(request: SearchSessionsRequest): Promise<SessionSearchResult[]>
  loadSession(sessionId: string, projectPath?: string, ctx?: IpcContext, provider?: AgentId, limit?: number): Promise<WireSessionLoadMessage[]>
  loadSessionPreview(sessionId: string, projectPath?: string, ctx?: IpcContext, provider?: AgentId): Promise<SessionPreviewResult>
  getSessionInfo(sessionId: string): Promise<SessionMeta | null>
  getSessionInfos(sessionIds: string[]): Promise<Array<SessionMeta | null>>
  resolveSessionLineage(provider: AgentId, providerSessionId: string): Promise<SessionLineageResolution | null>
  /** Name a session and describe its task from the opening prompt. */
  generateSessionMetadata(
    promptText: string,
    cwd: string,
    context?: SessionMetadataGenerationContext,
  ): Promise<SessionGeneratedMetadata | null>
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
  listRecentProjects(): Promise<RecentProject[]>
  trackRecentProject(path: string): Promise<void>
  listPlans(projectPath?: string, allProjects?: boolean, ctx?: IpcContext): Promise<PlanDescriptor[]>
  loadPlanContent(sessionId: string, projectPath: string, planToolUseId: string, ctx?: IpcContext, provider?: AgentId): Promise<string | null>
  getThreadGoal(threadId: string, ctx?: IpcContext, provider?: AgentId): Promise<ThreadGoal | null>
  setThreadGoal(request: ThreadGoalSetRequest, ctx?: IpcContext, provider?: AgentId): Promise<ThreadGoal>
  clearThreadGoal(threadId: string, ctx?: IpcContext, provider?: AgentId): Promise<boolean>
  loadPlanAnnotations(sessionId: string, planToolUseId: string, ctx?: IpcContext): Promise<PlanAnnotations | null>
  savePlanAnnotations(annotations: PlanAnnotations, ctx?: IpcContext): Promise<{ ok: boolean }>
  toggleBookmarkPlan(sessionId: string, projectPath: string, cwd: string, planToolUseId: string, title: string, ctx?: IpcContext): Promise<PlanAnnotations>
  rewindFiles(ctx: IpcContext, checkpointId: string): Promise<boolean>
  detectEditors(ctx?: IpcContext): Promise<{ editors: DetectedEditor[]; terminals: DetectedTerminal[] }>
  openInEditor(ctx: IpcContext, request: OpenInEditorRequest): Promise<boolean>

  googleDisconnect(): Promise<void>
  googleStatus(): Promise<GoogleAuthStatus>
  googleConnect(callbackBaseUrl?: string): Promise<{ authUrl: string; expiresAt: number }>

  cloudflareStatus(): Promise<{ connected: boolean; accountName?: string; accountId?: string; source?: 'env' | 'stored'; expiresOn?: number }>
  cloudflareConnect(args: { apiToken: string; accountId?: string }): Promise<
    | { ok: true; accountName?: string }
    | { ok: false; kind: 'invalid' | 'network' | 'accounts-forbidden' | 'encryption-unavailable'; error: string }
    | { ok: false; kind: 'choose-account'; accounts: Array<{ id: string; name: string }> }
  >
  cloudflareDisconnect(): Promise<void>

  atlassianStatus(): Promise<AtlassianStatus>
  atlassianStartOAuth(): Promise<AtlassianOAuthStartResult>
  atlassianCancelOAuth(): Promise<void>
  atlassianDisconnect(): Promise<void>
  atlassianJiraProjects(): Promise<AtlassianJiraProject[]>
  /** `principal` is how this caller was admitted; only a `local-owner` may change how the host is reached. */
  connectionsGetServerInfo(): Promise<{ host: string; port: number; allowLan: boolean; installationId: string; remoteAccess: boolean; requireAuth: boolean; trustLocalNetwork: boolean; principal: 'local-owner' | 'remote-owner' | 'system' }>
  connectionsListEndpoints(): Promise<Array<{ kind: 'loopback' | 'lan' | 'tailnet'; label: string; host: string; port: number }>>
  connectionsGeneratePairToken(): Promise<{ token: string; code: string; expiresAt: number }>
  connectionsListSessions(): Promise<Array<{ id: string; deviceLabel: string; deviceId: string | null; connectedAt: number; connectionCount: number; connectionIds: string[] }>>
  connectionsBootstrapDiscoveredServer(args: { server: DiscoveredServer; sshTarget?: string; authSecret?: string; attempt?: number; deviceLabel?: string }): Promise<SshBootstrapResult>
  connectionsRevokeDevice(args: { deviceId: string }): Promise<{ ok: boolean; revoked: string[] }>
  connectionsSetRemoteAccess(args: { remoteAccess: boolean }): Promise<{ remoteAccess: boolean; host: string; port: number; allowLan: boolean; requireAuth: boolean }>
  connectionsSetTrustLocalNetwork(args: { trustLocalNetwork: boolean }): Promise<{ trustLocalNetwork: boolean }>
  /** Personal Uplink (local-owner only): link this host to the owner's Solus cloud account. */
  uplinkLink(args: UplinkLinkRequest): Promise<UplinkStatus>
  uplinkUnlink(): Promise<UplinkStatus>
  uplinkStatus(): Promise<UplinkStatus>
  setAnalyticsConsent(enabled: boolean): Promise<void>
  /** This host's durable config, plus whether any client has seeded it yet. */
  configGet(): Promise<HostConfigSnapshot>
  configUpdate(patch: HostConfigPatch): Promise<HostConfigSnapshot>
  textGenerationSettingsGet(): Promise<TextGenerationSettingsSnapshot>
  otelSettingsGet(): Promise<OtelSettingsSnapshot>
  discoverServers(): Promise<DiscoveredServer[]>
  getServerCapabilities(): Promise<ServerCapabilities>
  setProjectsBaseDirectory(path: string): Promise<{ projectsBaseDirectory?: string }>
  setupInstallAgentCli(args: { agent: SetupAgent }): Promise<SetupStepResult>
  setupCheckAgentAuth(args: { agent: SetupAgent }): Promise<SetupAgentAuthCheckResult>
  /** Runs the agent CLI's browser-auth flow on the host, publishing typed setup events. */
  setupAgentSignIn(args: { agent: SetupAgent }): Promise<SetupStepResult>
  /** Sends a browser-returned code to an agent sign-in waiting on stdin. */
  setupSubmitAgentSignInCode(args: { agent: SetupAgent; code: string }): Promise<{ submitted: boolean }>
  /** Stops the host's active agent browser-auth flow, if one is waiting. */
  setupCancelAgentSignIn(): Promise<{ cancelled: boolean }>
  setupListGithubRepos(): Promise<SetupGithubReposResult>
  setupPrepareProject(args: SetupPrepareProjectRequest): Promise<SetupPrepareProjectResult>
  setupCloneProject(args: SetupCloneProjectRequest): Promise<SetupCloneProjectResult>
  setupSyncProject(args: SetupSyncProjectRequest): Promise<SetupAdoptProjectResult>
  /** Registers a checkout the host already has, instead of cloning a new one. */
  setupAdoptProject(args: { path: string; cloneUrl?: string }): Promise<SetupAdoptProjectResult>
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

  /** Active per-session needs-attention entries (server-side, outlive clients). */
  listAttention(): Promise<AttentionEntry[]>
  pushGetPublicKey(): Promise<string>
  pushSubscribe(subscription: WebPushSubscriptionJSON): Promise<{ ok: boolean }>
  pushUnsubscribe(): Promise<{ ok: boolean }>

  /** Create a durable provider session with no client watching it. */
  createHeadlessSession(request: HeadlessSessionRequest): Promise<{ agentSessionId: string }>
  /** Prompt another agent no client is watching (card composer/broadcast). */
  promptSession(sessionId: string, prompt: string, delivery?: PromptDelivery): Promise<{ disposition: 'started' | 'steered' | 'queued' }>
  /** Interrupt a session, by Solus's id or the provider thread a card holds. */
  stopSession(sessionId: string): Promise<boolean>

  providerStatus(ctx: IpcContext): Promise<AuthStatus>
  providerConnect(ctx: IpcContext): Promise<AuthStatus>
  /** Abort an in-flight providerConnect; its promise rejects with a cancellation. */
  providerCancelConnect(ctx: IpcContext): Promise<void>
  providerDisconnect(ctx: IpcContext): Promise<void>
  /** Exports the local GitHub credential only to the app's own window. */
  githubExportCredential(): Promise<GithubDelegatedCredential>
  /** The connected account, with its host avatar for the surfaces that draw it. */
  providerViewer(ctx: IpcContext): Promise<ProviderViewer>

  // PR review mode
  prList(ctx: IpcContext, filter?: PrFilter, page?: number): Promise<PrListPage>
  prNeedsReview(ctx: IpcContext): Promise<PullRequest[]>
  prGetEfforts(ctx: IpcContext, requests: PrEffortRequest[]): Promise<PrEffortResult[]>
  prGuideMetadata(ctx: IpcContext, request: PrGuideMetadataRequest): Promise<PrGuideMetadata | null>
  /** Resolve the exact host revision without changing local repository state. */
  prOpenReview(ctx: IpcContext, number: number): Promise<PrReviewTarget>
  prGetDiff(ctx: IpcContext, request: PrDiffRequest): Promise<PrDiffSlice>
  prGetDiffFileContents(ctx: IpcContext, request: PrDiffFileContentsRequest): Promise<PrDiffFileContents>
  prPrepareCheckout(ctx: IpcContext, target: PrReviewTarget): Promise<PrCheckoutContext>
  /** Fetch the PR's body, author, and state for the Activity overview. */
  prGetDetail(ctx: IpcContext, number: number): Promise<PullRequest>
  prUpdate(ctx: IpcContext, number: number, patch: PullRequestUpdate): Promise<PullRequest>
  /** Fetch the PR detail, commits, and reviewers for the PR list detail pane. */
  prGetOverview(ctx: IpcContext, number: number): Promise<PullRequestOverview>
  /** Per-file +/- counts from the code host for the PR's changed files. */
  prChangedFiles(ctx: IpcContext, number: number): Promise<ChangedFileStat[]>
  prListThreads(ctx: IpcContext, number: number): Promise<ReviewThread[]>
  prListComments(ctx: IpcContext, number: number): Promise<PrConversationItem[]>
  prListCommits(ctx: IpcContext, number: number): Promise<PrCommit[]>
  prListReviewers(ctx: IpcContext, number: number): Promise<PrReviewer[]>
  prListReviewerCandidates(ctx: IpcContext, number: number): Promise<PrReviewerCandidate[]>
  prRequestReviewers(ctx: IpcContext, number: number, logins: string[]): Promise<PrReviewer[]>
  prRemoveRequestedReviewer(ctx: IpcContext, number: number, login: string): Promise<PrReviewer[]>
  prListLabelCandidates(ctx: IpcContext, number: number): Promise<PrLabel[]>
  /** Replace the label set. Answers the whole pull request, the way every
   *  other write does, so one apply path keeps list rows and detail in step. */
  prSetLabels(ctx: IpcContext, number: number, names: string[]): Promise<PullRequest>
  prUpdateLifecycle(ctx: IpcContext, number: number, action: Exclude<PrLifecycleAction, 'merge'>, expectedHeadSha: string): Promise<PullRequest>
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
   * Forget everything the host has remembered about this project's pull
   * requests, so the next read asks the code host again.
   *
   * A separate call rather than a `force` flag on each read: only a person's
   * refresh should spend host requests, and a flag on a read is something every
   * caller can set. Reads share what has already been fetched; this is the one
   * way to opt out.
   */
  prInvalidate(ctx: IpcContext): Promise<void>
  prMerge(ctx: IpcContext, number: number, method: MergeMethod, expectedHeadSha: string): Promise<PrMergeResult>
  prPrepareConflictResolution(ctx: IpcContext, number: number): Promise<PrConflictResolutionResult>
  /** Cached checks for the repository's open PRs; failures are represented in the snapshot. */
  prChecks(ctx: IpcContext, numbers?: number[]): Promise<PrChecksSnapshot>
  /** Power/cadence hint from the active renderer surface. */
  prChecksActivity(ctx: IpcContext, reviewSurfaceOpen: boolean, active: boolean): Promise<void>

  /** Cached subscription quota per provider. Asking also keeps the backend's
   *  poll alive — it suspends itself once nobody is watching. */
  usageLimits(): Promise<AgentUsageLimits[]>

  // Observability / Insights (metrics.db query engine)
  /** Grouped rows from a builder/preset QuerySpec, compiled server-side. */
  metricsQuery(spec: MetricsQuerySpec): Promise<MetricsQueryResult>
  /** Rows from guarded read-only SQL (editor and NL paths). */
  metricsRunSql(sql: string): Promise<MetricsQueryResult>
  /** One page of turns plus full-range aggregates for the normal Insights view. */
  metricsTurnPage(request: MetricsTurnPageRequest): Promise<MetricsTurnPageResult>
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

  readLedger(ctx: IpcContext): Promise<ReviewLedger | null>
  writeLedger(ctx: IpcContext, ledger: ReviewLedger): Promise<boolean>
  getReviewContext(ctx: IpcContext): Promise<ReviewContext | null>
  generateGuide(ctx: IpcContext, opts?: ReviewGuideRequestOptions): Promise<{ key: string; guide: ReviewGuide; persisted: boolean } | null>
  requestReviewGuide(ctx: IpcContext, opts?: ReviewGuideRequestOptions): Promise<ReviewGuideStatusEvent | null>
  reviewGuideStatus(ctx: IpcContext, opts?: Pick<ReviewGuideRequestOptions, 'target' | 'scope' | 'ownDeltaBase'>): Promise<ReviewGuideStatusEvent | null>
  cancelGenerateGuide(ctx: IpcContext, opts?: Pick<ReviewGuideRequestOptions, 'target' | 'scope' | 'ownDeltaBase'>): Promise<boolean>
  readGuide(ctx: IpcContext, key: string): Promise<ReviewGuide | null>
  readReviewState(ctx: IpcContext, key: string): Promise<ReviewState | null>
  writeReviewState(ctx: IpcContext, state: ReviewState): Promise<boolean>

  createWork(title: string, type: WorkType, content: string | undefined, preview: string | undefined, sessionId: string | undefined, agentProvider: AgentId, cwd?: string, id?: string): Promise<Work>
  saveWork(id: string, updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>, cwd?: string): Promise<Work>
  loadWork(id: string, cwd?: string): Promise<Work | null>
  listWorks(cwd?: string): Promise<(WorkMeta & { id: string })[]>
  deleteWork(id: string, cwd?: string): Promise<void>
  duplicateWork(id: string, cwd?: string): Promise<Work>
  linkWorkSession(id: string, sessionId: string, cwd?: string): Promise<void>
  promoteWorkToProject(id: string, projectRoot: string): Promise<Work>
  loadWorkAnnotations(workId: string): Promise<WorkAnnotations | null>
  saveWorkAnnotations(ann: WorkAnnotations): Promise<void>
  agentSaveWork(id: string, updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>, cwd?: string): Promise<Work>
  loadWorkPrevious(workId: string, cwd?: string): Promise<WorkPrevious | null>
  revertWork(id: string, cwd?: string): Promise<Work | null>
  setWorkPinned(id: string, pinned: boolean, cwd?: string): Promise<void>

  docProviderStatuses(): Promise<DocProviderStatus[]>
  docDestinations(provider: DocProviderId): Promise<DocDestination[]>
  /** `destination` is required on the first publish and ignored afterwards;
   *  `force` publishes over an upstream change the user chose to discard. */
  publishWork(id: string, opts?: WorkPublishRequest): Promise<WorkPublishResult>
  pullWorkUpstream(id: string, cwd?: string): Promise<WorkPullResult>
  /** Version metadata only — the presence-scoped staleness check. */
  refreshWorkUpstream(id: string, cwd?: string): Promise<WorkExternalLink | null>
  unlinkWorkUpstream(id: string, cwd?: string): Promise<void>
  publishPlan(request: PlanPublishRequest): Promise<WorkPublishResult>
  pullPlanUpstream(sessionId: string, planToolUseId: string): Promise<WorkPullResult>
  refreshPlanUpstream(sessionId: string, planToolUseId: string): Promise<WorkExternalLink | null>
  unlinkPlanUpstream(sessionId: string, planToolUseId: string): Promise<void>
  importDocFromUrl(url: string, cwd?: string): Promise<Work>
  getPluginCommands(workingDirectory: string, ctx?: IpcContext): Promise<PluginCommandsResult>

  tasksProviderStatus(cwd: string, opts?: { checkAccess?: boolean }): Promise<TaskProviderStatus>
  inboxListUpstream(involvement: InboxInvolvement): Promise<InboxUpstreamResult>
  /** `query` searches the provider itself rather than the loaded page, which is
   *  the only way to reach an issue older than the provider list's cap. */
  tasksListUpstream(
    cwd: string,
    opts?: { query?: string },
  ): Promise<TaskListResult>
  tasksGetUpstream(cwd: string, id: string): Promise<Task>
  tasksUpdateUpstream(cwd: string, id: string, patch: TaskUpdatePatch): Promise<Task>
  tasksCommentUpstream(cwd: string, id: string, body: string): Promise<Task>
  tasksListAssigneeCandidates(cwd: string): Promise<TaskAssigneeCandidate[]>
  tasksListCandidates(cwd: string, opts?: TaskCandidateOptions): Promise<CandidateTicket[]>
  tasksImport(cwd: string, externalIds: string[]): Promise<TaskDetails[]>
  tasksPublish(id: string, cwd: string): Promise<TaskDetails>
  tasksSyncNow(id?: string): Promise<TaskExternalLink[]>
  tasksList(filter?: TaskListFilter): Promise<TaskListResult>
  tasksSidebarSnapshot(): Promise<TaskSidebarSnapshot>
  tasksGet(id: string): Promise<TaskDetails>
  tasksCreate(input: TaskCreateInput): Promise<Task>
  tasksPrepareForSession(input: PrepareSessionTaskRequest): Promise<PrepareSessionTaskResult>
  tasksSnapshot(taskId: string): Promise<TaskSnapshot>
  tasksUpdate(id: string, patch: TaskUpdatePatch): Promise<Task>
  tasksMarkRead(id: string, read: boolean): Promise<Task>
  tasksRecordActivity(id: string): Promise<Task>
  tasksDelete(id: string): Promise<boolean>
  tasksComment(id: string, body: string, opts?: { pushToExternal?: boolean }): Promise<TaskDetails>
  tasksDeleteComment(id: string, commentId: string): Promise<TaskDetails>
  /** Queue comments that were written while auto-posting was off. */
  tasksPublishComments(id: string, commentIds: string[]): Promise<TaskDetails>
  tasksLinkSession(
    taskId: string,
    sessionId: string,
    role?: TaskSessionRole,
    /** Where the agent ran, when that is not this host. See `SessionExecutionHost`. */
    execution?: SessionExecutionHost | null,
  ): Promise<void>
  /** Detach a session from a task. The reverse of `tasksLinkSession`. */
  tasksUnlinkSession(taskId: string, sessionId: string): Promise<void>
  tasksRekeySession(sourceSessionId: string, targetSessionId: string): Promise<void>
  tasksSessions(taskId?: string): Promise<Record<string, TaskSessionLink[]>>
  tasksForSession(sessionId: string): Promise<TaskForSessionResult | null>
  tasksLink(taskId: string, input: TaskLinkInput): Promise<TaskDetails>
  tasksUnlink(taskId: string, kind: TaskLinkKind, targetKey: string, targetScope?: string): Promise<TaskDetails>
  /** The reverse read: which tasks on this host link each target. A card
   *  batches the targets it shows; the answer lists one row per edge. */
  tasksLinkedTo(targets: TaskLinkTarget[]): Promise<TaskLinkedTask[]>
  /** Render a linked `artifact` work to a still and file it, with the HTML
   *  where the provider takes files, as a task comment queued for the ticket.
   *  `cwd` locates a project-stored work. */
  tasksAttachArtifact(taskId: string, workId: string, cwd?: string): Promise<TaskDetails>

  outboxList(): Promise<OutboxOp[]>
  outboxAck(appliedIds: string[], failures?: Array<{ id: string; error: string }>): Promise<void>
  outboxApply(ops: OutboxOp[]): Promise<OutboxApplyResult>

  automationCreate(name: string, action: AutomationAction, createdBy: AutomationCreator, enabled?: boolean, trigger?: AutomationTrigger): Promise<Automation>
  automationList(): Promise<Automation[]>
  automationRead(id: string): Promise<Automation | null>
  automationUpdate(id: string, patch: { name?: string; enabled?: boolean; favorite?: boolean; action?: Partial<AutomationAction>; trigger?: AutomationTrigger }): Promise<Automation | null>
  automationDelete(id: string): Promise<boolean>
  automationSetEnabled(id: string, enabled: boolean): Promise<Automation | null>
  automationRun(id: string): Promise<AutomationRun | null>
  automationCancel(id: string): Promise<boolean>
  automationListRuns(id: string): Promise<AutomationRun[]>
  automationReadRun(automationId: string, runId: string): Promise<AutomationRun | null>

  skillsSearch(query: string): Promise<RemoteSkill[]>
  skillsInstall(id: string): Promise<SkillInstallResult>

  pinnedSessionsList(): Promise<PinnedSession[]>
  togglePinnedSession(session: PinnedSession): Promise<PinnedSession[]>
  /** Foreground heartbeat: hosts skip watch-fired freshness work while no
   *  client holds a live lease (dispatch-client step 7). */
  activityLease(foreground: boolean): Promise<{ ok: boolean }>
  savedPromptsList(projectRoot: string): Promise<SavedPrompt[]>
  savedPromptsCreate(prompt: SavedPrompt): Promise<SavedPrompt[]>
  savedPromptsDelete(projectRoot: string, id: string): Promise<SavedPrompt[]>

  worktreeListProject(ctx: IpcContext): Promise<WorktreeEntry[]>
  diff(ctx: IpcContext, request: DiffRequest): Promise<DiffResult | null>
  diffFileContents(ctx: IpcContext, request: DiffFileContentsRequest): Promise<DiffFileContentsResult | null>
  diffStats(ctx: IpcContext, request: DiffRequest): Promise<ChangedFileStat[]>
  listTurnSnapshots(ctx: IpcContext): Promise<TurnSnapshot[]>
  gitRunAction(ctx: IpcContext, request: GitActionRequest): Promise<GitActionResult>
  gitDiscard(ctx: IpcContext): Promise<GitDiscardResult>
  gitSync(ctx: IpcContext): Promise<GitSyncResult>
  gitCheckoutBranch(ctx: IpcContext, branch: string): Promise<GitCheckoutBranchResult>
  worktreeBranches(ctx: IpcContext, options?: { remoteOnly?: boolean }): Promise<string[]>
  worktreeRestore(ctx: IpcContext, worktreePath: string): Promise<GitCheckout | null>
  continueInWorktree(ctx: IpcContext, namePrompt?: string): Promise<GitCheckoutBranchResult>
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
  isVisible(ctx?: IpcContext): Promise<boolean>
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean; focus?: boolean }): void
  /** Switch to the given mode's window (toggles when omitted). Shows/creates the
   *  target window and hides the current one unless both were visible. */
  switchMode(mode?: 'pill' | 'editor'): Promise<void>
  getAppGlobalShortcuts(): Promise<AppGlobalShortcuts>
  setAppGlobalShortcuts(shortcuts: AppGlobalShortcuts): Promise<SetAppGlobalShortcutsResult>
  restartApp(): Promise<void>
  getPlatform(): string
  getLocalConnection(): Promise<LocalConnectionInfo>

  updateAgentFiles(ctx: IpcContext, text: string): Promise<{ success: boolean; files?: string[]; err?: string }>

  enterDesignMode(ctx?: IpcContext): Promise<{ id: string; name: string; path: string; dataUrl: string; size: number } | null>
  designModeReady(): Promise<void>
  exitDesignMode(): Promise<void>
  submitDesignAnnotations(data: { dataUrl: string; annotations: DesignAnnotation[] }, ctx?: IpcContext): Promise<Attachment | null>

  /** Native-only: resolves the OS path for a File. Web stub returns ''. */
  getPathForFile(file: File): string

  /** Tell main which conversation owns the current text selection, gating the
   *  native transcript context-menu actions and preserving their source tab. */
  setQuoteContext(tabId: string | null): void
  /** Fires when the user picks "Quote in reply" on selected conversation text. */
  onQuoteSelection(callback: (text: string, sourceTabId: string) => void): () => void
  /** Fires when selected conversation text should seed a forked split session. */
  onAskSelectionInNewSession(callback: (text: string, sourceTabId: string) => void): () => void

  /** Running dev servers this host can offer as browser targets. Discovery
   *  only: Solus does not own these processes. */
  browserListTargets(ctx?: IpcContext): Promise<BrowserDiscoveredTarget[]>
  browserListPages(): Promise<BrowserPage[]>
  browserOpen(request: BrowserOpenRequest): Promise<BrowserPage>
  browserClose(browserPageId: string): Promise<void>
  browserNavigate(browserPageId: string, op: BrowserNavigateOp): Promise<void>
  browserSetViewport(browserPageId: string, request: BrowserViewportRequest): Promise<void>
  browserSetAppearance(browserPageId: string, appearance: BrowserAppearance): Promise<void>
  browserSnapshot(browserPageId: string, options?: BrowserSnapshotOptions): Promise<BrowserSnapshot>
  browserInteract(browserPageId: string, op: BrowserInteractOp): Promise<BrowserInteractResult>
  /** A desktop client hands its mounted `<webview>` to the server, which drives
   *  it in-process from Electron main. Desktop-local only. */
  browserAttachSurface(browserPageId: string, webContentsId: number): Promise<void>
  browserDetachSurface(browserPageId: string, reason?: BrowserDetachReason): Promise<void>
  browserReportSurface(browserPageId: string, report: BrowserSurfaceReport): Promise<void>
  /** Forget a browser profile's cookies and storage — the way out of the
   *  persistent per-project login. The client names the partition because the
   *  client is what created it. */
  browserClearProfile(partition: string): Promise<void>
  /** Start receiving streamed frames for a page: how a client with no native
   *  surface (web, mobile) sees it. The host streams only while at least one
   *  client is subscribed, so a hidden pane costs no frames. The subscribing
   *  client is taken from the connection, not an argument. */
  browserSubscribeFrames(browserPageId: string): Promise<void>
  browserUnsubscribeFrames(browserPageId: string): Promise<void>
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

  stackGet(ctx: IpcContext): Promise<{ repoRoot: string; graph: StackGraph }>
  stackDetect(ctx: IpcContext): Promise<{ repoRoot: string; graph: StackGraph }>
  stackAddManualEdge(ctx: IpcContext, parent: number, child: number): Promise<StackGraph>
  stackRemoveManualEdge(ctx: IpcContext, parent: number, child: number): Promise<StackGraph>
}

export interface NativeSolusAPI {
  getPlatform(): string
  getLocalConnection(): Promise<LocalConnectionInfo>
  /** Re-invokes the local-connection bootstrap to pull a fresh session token over IPC. */
  refreshLocalSessionToken(): Promise<string>
  openExternal(url: string, options?: { hideAppAfterOpen?: boolean }): Promise<boolean>
  showNotification(request: ClientNotificationRequest): Promise<boolean>
  logNotificationSound(row: NotificationSoundLog): void
  rendererReady(mode: 'pill' | 'editor'): void
  rendererMounted(mode: 'pill' | 'editor'): void
  getPathForFile(file: File): string
  readAttachmentBytes(path: string, mime: string): Promise<{ dataUrl: string; size: number }>
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean; focus?: boolean }): void
  /** Applies UI zoom to this window's webContents; main clamps the factor. */
  setZoomFactor(factor: number): void
  setQuoteContext(tabId: string | null): void
  onQuoteSelection(callback: (text: string, sourceTabId: string) => void): () => void
  onAskSelectionInNewSession(callback: (text: string, sourceTabId: string) => void): () => void
  /** A location the app was asked to open from outside the renderer — today a
   *  notification click; the payload is a serialized route. */
  onOpenRoute(callback: (route: string) => void): () => void
  onThemeChange(callback: (isDark: boolean) => void): () => void
  onWindowShown(callback: (cursorPos: { x: number; y: number } | null) => void): () => void
  onWindowHidden(callback: () => void): () => void
  /** The Solus account this install is signed in to. Owned by the main process;
   *  the renderer never sees the session token. */
  accountState(): Promise<AccountState>
  /** Runs the whole device sign-in flow; resolves when it ends. */
  accountSignIn(): Promise<DeviceSignInEnd>
  accountCancelSignIn(): void
  accountSignOut(): Promise<void>
  /** Re-checks a stored session with the website now. */
  accountRetryVerify(): Promise<void>
  onAccountStateChange(callback: (state: AccountState) => void): () => void
  /** Personal Uplink, on behalf of the signed-in account. Null when signed out or
   *  the website did not answer; the account token itself never crosses. */
  uplinkListDirectoryHosts(): Promise<UplinkDirectory | null>
  uplinkAcquireHostGrant(hostId: string): Promise<HostGrantResponse | null>
  uplinkIssueEnrollmentTicket(): Promise<UplinkEnrollmentTicket | null>
}
