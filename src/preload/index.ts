import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { AgentId, AgentTaskLifecyclePolicy, AgentUsageLimits, ReasoningEffort, IpcContext, PromptOptions, PromptDelivery, PromptDispatchResult, Attachment, SessionMeta, SessionSearchResult, SessionGeneratedMetadata, RecentProject, DetectedEditor, DetectedTerminal, OpenInEditorRequest, FilePreviewRequest, FilePreviewResult, ProjectContentSearchRequest, ProjectContentSearchResult, ProjectFilesRequest, ProjectFilesResult, WriteFileRequest, WriteFileResult, FileMatch, DirectoryListResult, CreateDirectoryResult, DesignAnnotation, PluginCommandsResult, RemoteSkill, SkillInstallResult, GitCheckout, TurnSnapshot, DiffResult, DiffFileContentsRequest, DiffFileContentsResult, ChangedFileStat, WorktreeEntry, GitActionRequest, GitActionResult, GitDiscardResult, GitSyncResult, GitCheckoutBranchResult, GitIdentity, GitState, GitStateOptions, ProjectConfig, ProjectEntry, ProjectIdentity, DispatchHistoryRoot, PlanDescriptor, PlanAnnotations, DiffRequest, RateLimitDecisionAction, RuntimeSessionInfo, SessionHandoffResolution, SessionProviderSwitchResult, ThreadGoal, ThreadGoalSetRequest, Work, WorkMeta, WorkAnnotations, WorkPrevious, PinnedSession, SavedPrompt, AppGlobalShortcuts, SetAppGlobalShortcutsResult, StartInfo, Automation, AutomationAction, AutomationCreator, AutomationRun, AutomationTrigger, AuthStatus, PrCheckoutContext, PrReviewContext, MergeMethod, PrMergeResult, PrConflictResolutionResult, ServerCapabilities, HostCapabilities, DiscoveredServer, SshBootstrapResult, WebPushSubscriptionJSON, SetupAgent, SetupAdoptProjectResult, SetupAgentAuthCheckResult, SetupCloneProjectRequest, SetupCloneProjectResult, SetupPrepareProjectRequest, SetupPrepareProjectResult, SetupSyncProjectRequest, SetupGithubReposResult, SetupSshAccessResult, SetupStepResult, HostReadiness, GitCommitIdentity, VoiceModelStatus, HeadlessSessionRequest, GithubDelegatedCredential, PrRepoCheckoutResult } from '../shared/types'
import type { PrDiffFileContents, PrDiffFileContentsRequest, PrDiffRequest, PrDiffSlice, PrEffortRequest, PrEffortResult, PrFilter, PrLifecycleAction, PrListPage, PrReviewer, PrReviewerCandidate, PrReviewTarget, PullRequestDetail, PullRequestOverview, PullRequestSummary, PullRequestUpdate, ReviewThread, ReviewComment, PrCommit, PrConversationItem, DraftReview } from '../shared/providers'
import type { CandidateTicket, PrepareSessionTaskRequest, PrepareSessionTaskResult, SessionExecutionHost, Task, TaskCandidateOptions, TaskCreateInput, TaskDetails, TaskExternalLink, TaskForSessionResult, TaskLinkInput, TaskLinkKind, TaskListFilter, TaskListResult, TaskProviderStatus, TaskSessionLink, TaskSessionRole, TaskSidebarSnapshot, TaskSnapshot, TaskSnoozeInput, TaskUpdatePatch } from '../shared/task-types'
import type { OutboxApplyResult, OutboxOp } from '../shared/outbox-types'
import type { SessionPreviewResult, WireSessionLoadMessage } from '../shared/session-history'
import type { AttentionEntry } from '../shared/attention-types'
import type { ReviewLedger, ReviewContext, ReviewGuide, ReviewState, ReviewGuideStatusEvent, PrGuideMetadata, PrGuideMetadataRequest } from '../shared/review'
import type { StackGraph } from '../shared/stack-types'
import type { PrChecksSnapshot } from '../shared/checks-rpc-types'
import type { AssetCreateUrlRequest, AssetCreateUrlResult, AttachmentUploadRequest, SearchSessionsRequest } from '../shared/rpc'
import type { ClientNotificationRequest } from '../shared/notification-types'

import type { TextGenerationSettings, TextGenerationSettingsSnapshot } from '../shared/types'

const LOCAL_CONNECTION_CHANNEL = 'solus:local-connection'

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
  attachFiles(ctx?: IpcContext): Promise<Attachment[] | null>
  attachFilePaths(paths: string[], ctx?: IpcContext): Promise<Attachment[] | null>
  attachUpload(ctx: IpcContext, request: AttachmentUploadRequest): Promise<string>
  assetCreateUrl(ctx: IpcContext, request: AssetCreateUrlRequest): Promise<AssetCreateUrlResult>
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
  writeFile(ctx: IpcContext, request: WriteFileRequest): Promise<WriteFileResult>
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
  resolveSessionHandoff(provider: AgentId, providerSessionId: string): Promise<SessionHandoffResolution | null>
  /** Name a session and describe its task from the opening prompt. */
  generateSessionMetadata(promptText: string, cwd: string): Promise<SessionGeneratedMetadata | null>
  /** Persist a session name; null clears it back to the derived title. */
  setSessionTitle(
    sessionId: string,
    title: string | null,
    source?: 'generated' | 'manual',
    generatedDescription?: string,
    publishEvent?: boolean,
  ): Promise<void>
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
  getTheme(): Promise<{ isDark: boolean }>

  googleUploadDoc(args: { title: string; markdown: string; oauthCallbackBaseUrl?: string }): Promise<
    | { docUrl: string }
    | { error: string }
    | { authUrl: string; expiresAt: number }
  >
  googleDisconnect(): Promise<void>

  cloudflareStatus(): Promise<{ connected: boolean; accountName?: string; accountId?: string; source?: 'env' | 'stored'; expiresOn?: number }>
  cloudflareConnect(args: { apiToken: string; accountId?: string }): Promise<
    | { ok: true; accountName?: string }
    | { ok: false; kind: 'invalid' | 'network' | 'accounts-forbidden' | 'encryption-unavailable'; error: string }
    | { ok: false; kind: 'choose-account'; accounts: Array<{ id: string; name: string }> }
  >
  cloudflareDisconnect(): Promise<void>
  connectionsGetServerInfo(): Promise<{ host: string; port: number; allowLan: boolean; installationId: string; remoteAccess: boolean; requireAuth: boolean }>
  connectionsListEndpoints(): Promise<Array<{ kind: 'loopback' | 'lan' | 'tailnet'; label: string; host: string; port: number }>>
  connectionsGeneratePairToken(): Promise<{ token: string; code: string; expiresAt: number }>
  connectionsListSessions(): Promise<Array<{ id: string; deviceLabel: string; deviceId: string | null; connectedAt: number; connectionCount: number; connectionIds: string[] }>>
  connectionsBootstrapDiscoveredServer(args: { server: DiscoveredServer; sshTarget?: string; authSecret?: string; attempt?: number; deviceLabel?: string }): Promise<SshBootstrapResult>
  connectionsRevokeDevice(args: { deviceId: string }): Promise<{ ok: boolean; revoked: string[] }>
  connectionsSetRemoteAccess(args: { remoteAccess: boolean }): Promise<{ remoteAccess: boolean; host: string; port: number; allowLan: boolean; requireAuth: boolean }>
  setAnalyticsConsent(enabled: boolean): Promise<void>
  setAgentTaskLifecyclePolicy(policy: AgentTaskLifecyclePolicy): Promise<{ agentTaskLifecyclePolicy: AgentTaskLifecyclePolicy }>
  textGenerationSettingsGet(): Promise<TextGenerationSettingsSnapshot>
  textGenerationSettingsUpdate(patch: Partial<TextGenerationSettings>): Promise<TextGenerationSettingsSnapshot>
  discoverServers(): Promise<DiscoveredServer[]>
  getServerCapabilities(): Promise<ServerCapabilities>
  setServerName(name: string): Promise<{ name?: string }>
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
  providerViewer(ctx: IpcContext): Promise<string>

  // PR review mode
  prList(ctx: IpcContext, filter?: PrFilter, page?: number): Promise<PrListPage>
  prNeedsReview(ctx: IpcContext): Promise<PullRequestSummary[]>
  prGetEfforts(ctx: IpcContext, requests: PrEffortRequest[]): Promise<PrEffortResult[]>
  prGuideMetadata(ctx: IpcContext, requests: PrGuideMetadataRequest[]): Promise<PrGuideMetadata[]>
  /** Resolve the exact host revision without changing local repository state. */
  prOpenReview(ctx: IpcContext, number: number): Promise<PrReviewTarget>
  prGetDiff(ctx: IpcContext, request: PrDiffRequest): Promise<PrDiffSlice>
  prGetDiffFileContents(ctx: IpcContext, request: PrDiffFileContentsRequest): Promise<PrDiffFileContents>
  prPrepareCheckout(ctx: IpcContext, target: PrReviewTarget): Promise<PrCheckoutContext>
  /** Explicit "check out here" destination: switches the current repository
   *  itself onto the pull request's head instead of an isolated worktree. */
  prCheckoutInRepo(ctx: IpcContext, target: PrReviewTarget): Promise<PrRepoCheckoutResult>
  /** Fetch the PR's body, author, and state for the Activity overview. */
  prGetDetail(ctx: IpcContext, number: number): Promise<PullRequestDetail>
  prUpdate(ctx: IpcContext, number: number, patch: PullRequestUpdate): Promise<PullRequestDetail>
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
  prUpdateLifecycle(ctx: IpcContext, number: number, action: Exclude<PrLifecycleAction, 'merge'>, expectedHeadSha: string): Promise<PullRequestDetail>
  prSubmitReview(ctx: IpcContext, number: number, review: DraftReview): Promise<void>
  prAddIssueComment(ctx: IpcContext, number: number, body: string): Promise<void>
  prInterdiff(ctx: IpcContext, pr: PrReviewContext): Promise<import('../shared/types').PrInterdiffResult>
  prReplyThread(ctx: IpcContext, number: number, threadId: string, body: string): Promise<ReviewComment>
  prResolveThread(ctx: IpcContext, number: number, threadId: string): Promise<void>
  prUnresolveThread(ctx: IpcContext, number: number, threadId: string): Promise<void>
  /** Queue background guide generation for these PRs; resolves once queued. */
  prGenerateGuides(ctx: IpcContext, numbers: number[]): Promise<void>
  prMerge(ctx: IpcContext, number: number, method: MergeMethod, expectedHeadSha: string): Promise<PrMergeResult>
  prPrepareConflictResolution(ctx: IpcContext, number: number): Promise<PrConflictResolutionResult>
  /** Cached checks for the repository's open PRs; failures are represented in the snapshot. */
  prChecks(ctx: IpcContext, numbers?: number[]): Promise<PrChecksSnapshot>
  /** Power/cadence hint from the active renderer surface. */
  prChecksActivity(ctx: IpcContext, reviewSurfaceOpen: boolean, active: boolean): Promise<void>

  /** Cached subscription quota per provider. Asking also keeps the backend's
   *  poll alive — it suspends itself once nobody is watching. */
  usageLimits(): Promise<AgentUsageLimits[]>

  readLedger(ctx: IpcContext): Promise<ReviewLedger | null>
  writeLedger(ctx: IpcContext, ledger: ReviewLedger): Promise<boolean>
  getReviewContext(ctx: IpcContext): Promise<ReviewContext | null>
  generateGuide(ctx: IpcContext, opts?: { agent?: AgentId; model?: string | null; reasoningEffort?: ReasoningEffort | null; scope?: 'branch' | 'session'; ownDeltaBase?: { parent: number; headSha: string } }): Promise<{ key: string; guide: ReviewGuide; persisted: boolean } | null>
  requestReviewGuide(ctx: IpcContext, opts?: { agent?: AgentId; model?: string | null; reasoningEffort?: ReasoningEffort | null; scope?: 'branch' | 'session'; ownDeltaBase?: { parent: number; headSha: string } }): Promise<ReviewGuideStatusEvent | null>
  reviewGuideStatus(ctx: IpcContext, opts?: { scope?: 'branch' | 'session'; ownDeltaBase?: { parent: number; headSha: string } }): Promise<ReviewGuideStatusEvent | null>
  cancelGenerateGuide(ctx: IpcContext, opts?: { scope?: 'branch' | 'session'; ownDeltaBase?: { parent: number; headSha: string } }): Promise<boolean>
  readGuide(ctx: IpcContext, key: string): Promise<ReviewGuide | null>
  readReviewState(ctx: IpcContext, key: string): Promise<ReviewState | null>
  writeReviewState(ctx: IpcContext, state: ReviewState): Promise<boolean>

  createWork(title: string, type: 'doc' | 'slides' | 'diagram', content: string | undefined, preview: string | undefined, sessionId: string | undefined, agentProvider: AgentId, cwd?: string, id?: string): Promise<Work>
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
  getPluginCommands(workingDirectory: string, ctx?: IpcContext): Promise<PluginCommandsResult>

  tasksProviderStatus(cwd: string, opts?: { checkAccess?: boolean }): Promise<TaskProviderStatus>
  tasksListUpstream(cwd: string, opts?: { refresh?: boolean }): Promise<TaskListResult>
  tasksGetUpstream(cwd: string, id: string): Promise<Task>
  tasksUpdateUpstream(cwd: string, id: string, patch: TaskUpdatePatch): Promise<Task>
  tasksCommentUpstream(cwd: string, id: string, body: string): Promise<Task>
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
  tasksSnooze(id: string, input: TaskSnoozeInput): Promise<Task>
  tasksMarkRead(id: string, read: boolean): Promise<Task>
  tasksRecordActivity(id: string): Promise<Task>
  tasksDelete(id: string): Promise<boolean>
  tasksComment(id: string, body: string, opts?: { pushToExternal?: boolean }): Promise<TaskDetails>
  /** Queue comments that were written while auto-posting was off. */
  tasksPublishComments(id: string, commentIds: string[]): Promise<TaskDetails>
  tasksLinkSession(
    taskId: string,
    sessionId: string,
    role?: TaskSessionRole,
    /** Where the agent ran, when that is not this host. See `SessionExecutionHost`. */
    execution?: SessionExecutionHost | null,
    /** The resolved checkout branch. A remote worktree can differ from the task
     *  host's branch, so capture it only after the execution host starts. */
    branch?: string | null,
  ): Promise<void>
  /** Detach a session from a task. The reverse of `tasksLinkSession`. */
  tasksUnlinkSession(taskId: string, sessionId: string): Promise<void>
  tasksRekeySession(sourceSessionId: string, targetSessionId: string): Promise<void>
  tasksSessions(taskId?: string): Promise<Record<string, TaskSessionLink[]>>
  tasksForSession(sessionId: string): Promise<TaskForSessionResult | null>
  tasksLink(taskId: string, input: TaskLinkInput): Promise<TaskDetails>
  tasksUnlink(taskId: string, kind: TaskLinkKind, targetKey: string, targetScope?: string): Promise<TaskDetails>

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
  worktreeRestore(ctx: IpcContext, worktreePath: string, options?: { includePr?: boolean }): Promise<GitCheckout | null>
  continueInWorktree(ctx: IpcContext, namePrompt?: string): Promise<GitCheckoutBranchResult>
  gitRefreshState(cwd: string, options?: GitStateOptions): Promise<GitState | null>
  gitIdentity(cwd: string): Promise<GitIdentity | null>
  gitRegisterEnvironment(ctx: IpcContext, cwd: string, gitContext: GitCheckout | null): Promise<void>
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
}

// Main has finished booting the local server before it creates either renderer
// window. Start this immutable bootstrap lookup while the preload itself is
// evaluating so HTML parsing and renderer startup do not sit behind a fresh IPC
// round trip.
const localConnectionPromise: Promise<LocalConnectionInfo> = ipcRenderer.invoke(LOCAL_CONNECTION_CHANNEL)

const nativeApi: NativeSolusAPI = {
  getPlatform: () => process.platform,
  getLocalConnection: () => localConnectionPromise,
  refreshLocalSessionToken: () =>
    ipcRenderer.invoke(LOCAL_CONNECTION_CHANNEL).then((info: LocalConnectionInfo) => info.token),
  openExternal: (url: string, options?: { hideAppAfterOpen?: boolean }) =>
    ipcRenderer.invoke('solus:open-external', url, options),
  showNotification: (request: ClientNotificationRequest) =>
    ipcRenderer.invoke('solus:show-notification', request),
  rendererReady: (mode: 'pill' | 'editor') => ipcRenderer.send('solus:renderer-ready', mode),
  rendererMounted: (mode: 'pill' | 'editor') => ipcRenderer.send('solus:renderer-mounted', mode),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  readAttachmentBytes: (path: string, mime: string) =>
    ipcRenderer.invoke('solus:read-attachment-bytes', path, mime),
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean; focus?: boolean }) =>
    ipcRenderer.send('solus:set-ignore-mouse-events', ignore, options || {}),
  setZoomFactor: (factor: number) =>
    ipcRenderer.send('solus:set-zoom-factor', factor),
  setQuoteContext: (tabId: string | null) =>
    ipcRenderer.send('solus:set-quote-context', tabId),
  onQuoteSelection: (cb: (text: string, sourceTabId: string) => void) => {
    const handler = (_event: IpcRendererEvent, text: string, sourceTabId: string) => cb(text, sourceTabId)
    ipcRenderer.on('solus:quote-selection', handler)
    return () => ipcRenderer.removeListener('solus:quote-selection', handler)
  },
  onAskSelectionInNewSession: (cb: (text: string, sourceTabId: string) => void) => {
    const handler = (_event: IpcRendererEvent, text: string, sourceTabId: string) => cb(text, sourceTabId)
    ipcRenderer.on('solus:ask-selection-in-new-session', handler)
    return () => ipcRenderer.removeListener('solus:ask-selection-in-new-session', handler)
  },
  /** A location the app was asked to open from outside the renderer — today a
   *  notification click; the payload is a serialized route. */
  onOpenRoute: (cb: (route: string) => void) => {
    const handler = (_event: IpcRendererEvent, route: string) => cb(route)
    ipcRenderer.on('solus:open-route', handler)
    return () => ipcRenderer.removeListener('solus:open-route', handler)
  },
  onThemeChange: (cb: (isDark: boolean) => void) => {
    const handler = (_event: IpcRendererEvent, isDark: boolean) => cb(isDark)
    ipcRenderer.on('solus:theme-changed', handler)
    return () => ipcRenderer.removeListener('solus:theme-changed', handler)
  },
  onWindowShown: (cb: (cursorPos: { x: number; y: number } | null) => void) => {
    const handler = (_event: IpcRendererEvent, cursorPos: { x: number; y: number } | null) => cb(cursorPos)
    ipcRenderer.on('solus:window-shown', handler)
    return () => ipcRenderer.removeListener('solus:window-shown', handler)
  },
  onWindowHidden: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('solus:window-hidden', handler)
    return () => ipcRenderer.removeListener('solus:window-hidden', handler)
  },
}

contextBridge.exposeInMainWorld('solusNative', nativeApi)
