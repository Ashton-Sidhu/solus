import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentId, ReasoningEffort, IpcContext, PromptOptions, NormalizedEvent, EnrichedError, Attachment, SessionMeta, SessionSearchResult, SessionScanEvent, SessionIndexUpdatedEvent, RecentProject, DetectedEditor, DetectedTerminal, OpenInEditorRequest, FilePreviewRequest, FilePreviewResult, ProjectFilesRequest, ProjectFilesResult, WriteFileRequest, WriteFileResult, FileMatch, DirectoryListResult, DesignAnnotation, PluginCommandsResult, SkillStatus, RemoteSkill, SkillInstallResult, GitCheckout, TurnSnapshot, DiffResult, ChangedFileStat, WorktreeEntry, WorktreePRResult, GitCommitPushResult, GitSyncResult, GitCheckoutBranchResult, GitIdentity, GitState, GitStateOptions, RunStatus, RunProjectStatus, RunLogLine, RunLogBatch, ProjectConfig, ProjectEntry, PlanDescriptor, PlanAnnotations, DiffRequest, RateLimitDecisionAction, RuntimeSessionInfo, SessionProviderSwitchResult, ThreadGoal, ThreadGoalSetRequest, Work, WorkMeta, WorkAnnotations, WorkPrevious, PinnedSession, AppGlobalShortcuts, SetAppGlobalShortcutsResult, StartInfo, Automation, AutomationAction, AutomationCreator, AutomationRun, AutomationsChangedEvent, AutomationTrigger, AuthStatus, DeviceCodePrompt, PrReviewContext, MergeMethod, PrMergeResult, PrConflictResolutionResult, ServerCapabilities, DiscoveredServer, WebPushSubscriptionJSON, SetupAgent, SetupAgentAuthCheckResult, SetupCloneProjectResult, SetupGithubReposResult, SetupLogEvent, SetupStatusEvent, SetupStepResult, VoiceModelStatus } from '../shared/types'
import type { PrEffortRequest, PrEffortResult, PrFilter, PrListPage, PrReviewer, PullRequestDetail, PullRequestOverview, PullRequestSummary, ReviewThread, ReviewComment, PrCommit, PrConversationItem, DraftReview } from '../shared/providers'
import type { Task, TaskListResult, TaskProviderStatus, TaskSessionLink } from '../shared/task-types'
import type { SessionLoadMessage, SessionPreviewResult } from '../shared/session-history'
import type { AttentionEntry } from '../shared/attention-types'
import type { ReviewLedger, ReviewContext, ReviewGuide, ReviewState, ReviewProgressEvent, PrGuideMetadata, PrGuideMetadataRequest, PrGuideStatusEvent } from '../shared/review'
import type { StackGraph } from '../shared/stack-types'
import type { PrChecksSnapshot } from '../shared/checks-rpc-types'
import type { SearchSessionsRequest } from '../shared/rpc'

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
  createTab(tabId?: string): Promise<{ tabId: string }>
  prompt(ctx: IpcContext, options: PromptOptions): Promise<void>
  stopTab(ctx: IpcContext): Promise<boolean>
  retry(ctx: IpcContext, options: PromptOptions): Promise<void>
  closeTab(ctx: IpcContext): Promise<void>
  switchSessionAgent(tabId: string, provider: AgentId): Promise<SessionProviderSwitchResult>
  selectDirectory(ctx?: IpcContext): Promise<string | null>
  saveFileDialog(defaultName: string, content: string): Promise<string | null>
  openExternal(url: string, options?: { hideAppAfterOpen?: boolean }): Promise<boolean>
  openInTerminal(ctx: IpcContext): Promise<boolean>
  openWorktreeTerminal(ctx: IpcContext): Promise<boolean>
  attachFiles(ctx?: IpcContext): Promise<Attachment[] | null>
  attachFilePaths(paths: string[], ctx?: IpcContext): Promise<Attachment[] | null>
  takeScreenshot(ctx?: IpcContext): Promise<Attachment | null>
  pasteImage(dataUrl: string, ctx?: IpcContext): Promise<Attachment | null>
  transcribeAudio(audio: Float32Array | string, ctx?: IpcContext): Promise<{ error: string | null; transcript: string | null }>
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
  listDirectory(path: string, showHidden?: boolean): Promise<DirectoryListResult>
  readProjectFile(ctx: IpcContext, request: FilePreviewRequest): Promise<FilePreviewResult>
  listProjectFiles(ctx: IpcContext, request?: ProjectFilesRequest): Promise<ProjectFilesResult>
  writeFile(ctx: IpcContext, request: WriteFileRequest): Promise<WriteFileResult>
  respondPermission(ctx: IpcContext, questionId: string, optionId: string, updatedPlan?: string): Promise<boolean>
  writePlanFile(filePath: string, content: string, ctx?: IpcContext): Promise<{ ok: boolean; error?: string }>
  respondQuestion(ctx: IpcContext, questionId: string, answers: Record<string, string>): Promise<boolean>
  rateLimitDecision(ctx: IpcContext, action: RateLimitDecisionAction): Promise<boolean>
  cancelQueuedPrompt(ctx: IpcContext, queueId: string): Promise<boolean>
  bindRuntimeSession(ctx: IpcContext): Promise<RuntimeSessionInfo | null>
  resetTabSession(ctx: IpcContext): Promise<void>
  listSessions(projectPath?: string, ctx?: IpcContext, provider?: AgentId, streamId?: string, limit?: number): Promise<SessionMeta[]>
  searchSessions(request: SearchSessionsRequest): Promise<SessionSearchResult[]>
  loadSession(sessionId: string, projectPath?: string, ctx?: IpcContext, provider?: AgentId, limit?: number): Promise<SessionLoadMessage[]>
  loadSessionPreview(sessionId: string, projectPath?: string, ctx?: IpcContext, provider?: AgentId): Promise<SessionPreviewResult>
  getSessionInfo(sessionId: string): Promise<SessionMeta | null>
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
  onThemeChange(callback: (isDark: boolean) => void): () => void

  googleUploadDoc(args: { title: string; markdown: string }): Promise<{ docUrl: string } | { error: string }>
  googleDisconnect(): Promise<void>

  connectionsGetServerInfo(): Promise<{ host: string; port: number; allowLan: boolean; installationId: string; remoteAccess: boolean; requireAuth: boolean }>
  connectionsListEndpoints(): Promise<Array<{ kind: 'loopback' | 'lan' | 'tailnet'; label: string; host: string; port: number }>>
  connectionsGeneratePairToken(): Promise<{ token: string; code: string; expiresAt: number }>
  connectionsListSessions(): Promise<Array<{ id: string; deviceLabel: string; deviceId: string | null; connectedAt: number; connectionCount: number; connectionIds: string[] }>>
  connectionsRevokeDevice(args: { deviceId: string }): Promise<{ ok: boolean; revoked: string[] }>
  connectionsSetRemoteAccess(args: { remoteAccess: boolean }): Promise<{ remoteAccess: boolean; host: string; port: number; allowLan: boolean; requireAuth: boolean }>
  discoverServers(): Promise<DiscoveredServer[]>
  getServerCapabilities(): Promise<ServerCapabilities>
  setServerName(name: string): Promise<{ name?: string }>
  setupInstallAgentCli(args: { agent: SetupAgent }): Promise<SetupStepResult>
  setupCheckAgentAuth(args: { agent: SetupAgent }): Promise<SetupAgentAuthCheckResult>
  setupListGithubRepos(): Promise<SetupGithubReposResult>
  setupCloneProject(args: { cloneUrl: string; name?: string }): Promise<SetupCloneProjectResult>
  onSetupLog(callback: (event: SetupLogEvent) => void): () => void
  onSetupStatus(callback: (event: SetupStatusEvent) => void): () => void

  /** Active per-session needs-attention entries (server-side, outlive clients). */
  listAttention(): Promise<AttentionEntry[]>
  pushGetPublicKey(): Promise<string>
  pushSubscribe(subscription: WebPushSubscriptionJSON): Promise<{ ok: boolean }>
  pushUnsubscribe(): Promise<{ ok: boolean }>
  /** Fires with the full active attention list whenever it changes. */
  onAttentionChanged(callback: (entries: AttentionEntry[]) => void): () => void

  providerStatus(ctx: IpcContext): Promise<AuthStatus>
  providerConnect(ctx: IpcContext): Promise<AuthStatus>
  /** Abort an in-flight providerConnect; its promise rejects with a cancellation. */
  providerCancelConnect(ctx: IpcContext): Promise<void>
  providerDisconnect(ctx: IpcContext): Promise<void>
  providerViewer(ctx: IpcContext): Promise<string>
  /** Fires with the device/user code while `providerConnect` polls. */
  onProviderDeviceCode(callback: (prompt: DeviceCodePrompt) => void): () => void

  // PR review mode
  prList(ctx: IpcContext, filter?: PrFilter, page?: number): Promise<PrListPage>
  prNeedsReview(ctx: IpcContext): Promise<PullRequestSummary[]>
  prGetEfforts(ctx: IpcContext, requests: PrEffortRequest[]): Promise<PrEffortResult[]>
  prGuideMetadata(ctx: IpcContext, requests: PrGuideMetadataRequest[]): Promise<PrGuideMetadata[]>
  /** Fetch + check out the PR worktree and return the assembled review context. */
  prOpenReview(ctx: IpcContext, number: number): Promise<PrReviewContext>
  /** Fetch the PR's body, author, and state for the Activity overview. */
  prGetDetail(ctx: IpcContext, number: number): Promise<PullRequestDetail>
  /** Fetch the PR detail, commits, and reviewers for the PR list detail pane. */
  prGetOverview(ctx: IpcContext, number: number): Promise<PullRequestOverview>
  /** Per-file +/- counts from the code host for the PR's changed files. */
  prChangedFiles(ctx: IpcContext, number: number): Promise<ChangedFileStat[]>
  prListThreads(ctx: IpcContext, number: number): Promise<ReviewThread[]>
  prListComments(ctx: IpcContext, number: number): Promise<PrConversationItem[]>
  prListCommits(ctx: IpcContext, number: number): Promise<PrCommit[]>
  prListReviewers(ctx: IpcContext, number: number): Promise<PrReviewer[]>
  prSubmitReview(ctx: IpcContext, number: number, review: DraftReview): Promise<void>
  prAddIssueComment(ctx: IpcContext, number: number, body: string): Promise<void>
  prInterdiff(ctx: IpcContext, pr: PrReviewContext): Promise<import('../shared/types').PrInterdiffResult>
  prReplyThread(ctx: IpcContext, number: number, threadId: string, body: string): Promise<ReviewComment>
  prResolveThread(ctx: IpcContext, number: number, threadId: string): Promise<void>
  prUnresolveThread(ctx: IpcContext, number: number, threadId: string): Promise<void>
  /** Queue background guide generation for these PRs; resolves once queued.
   *  Per-PR progress streams over `onPrGuideStatus`. */
  prGenerateGuides(ctx: IpcContext, numbers: number[]): Promise<void>
  onPrGuideStatus(callback: (event: PrGuideStatusEvent) => void): () => void
  prMerge(ctx: IpcContext, number: number, method: MergeMethod): Promise<PrMergeResult>
  prPrepareConflictResolution(ctx: IpcContext, number: number): Promise<PrConflictResolutionResult>
  /** Cached checks for the repository's open PRs; failures are represented in the snapshot. */
  prChecks(ctx: IpcContext, numbers?: number[]): Promise<PrChecksSnapshot>
  /** Power/cadence hint from the active renderer surface. */
  prChecksActivity(ctx: IpcContext, reviewSurfaceOpen: boolean, active: boolean): Promise<void>
  onPrChecksUpdate(callback: (snapshot: PrChecksSnapshot) => void): () => void

  readLedger(ctx: IpcContext): Promise<ReviewLedger | null>
  writeLedger(ctx: IpcContext, ledger: ReviewLedger): Promise<boolean>
  getReviewContext(ctx: IpcContext): Promise<ReviewContext | null>
  generateGuide(ctx: IpcContext, opts?: { agent?: AgentId; model?: string | null; reasoningEffort?: ReasoningEffort | null; scope?: 'branch' | 'session'; ownDeltaBase?: { parent: number; headSha: string } }): Promise<{ key: string; guide: ReviewGuide; persisted: boolean } | null>
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
  tasksList(cwd: string, opts?: { assignedToMe?: boolean }): Promise<TaskListResult>
  tasksGet(cwd: string, id: string): Promise<Task>
  tasksCreate(cwd: string, input: Partial<Task>): Promise<Task>
  tasksUpdate(cwd: string, id: string, patch: Partial<Task>): Promise<Task>
  tasksDelete(cwd: string, id: string): Promise<boolean>
  tasksComment(cwd: string, id: string, body: string): Promise<Task>
  tasksLinkSession(cwd: string, taskId: string, sessionId: string): Promise<void>
  tasksSessions(cwd: string): Promise<Record<string, TaskSessionLink[]>>
  /** Fires with the project cwd whenever any path (renderer, agent tool, session
   *  write-back) mutates that project's tasks. */
  onTasksChanged(callback: (cwd: string) => void): () => void
  /** Fires with the project cwd whenever an agent mutates PR review state. */
  onPrsChanged(callback: (cwd: string) => void): () => void

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
  /** Fires on every automation mutation in main — saves, deletes, and run
   *  transitions, including background scheduler fires. */
  onAutomationsChanged(callback: (event: AutomationsChangedEvent) => void): () => void

  skillsSearch(query: string): Promise<RemoteSkill[]>
  skillsInstall(id: string): Promise<SkillInstallResult>

  pinnedSessionsList(): Promise<PinnedSession[]>
  togglePinnedSession(session: PinnedSession): Promise<PinnedSession[]>

  worktreeListProject(ctx: IpcContext): Promise<WorktreeEntry[]>
  diff(ctx: IpcContext, request: DiffRequest): Promise<DiffResult | null>
  diffStats(ctx: IpcContext, request: DiffRequest): Promise<ChangedFileStat[]>
  listTurnSnapshots(ctx: IpcContext): Promise<TurnSnapshot[]>
  worktreePR(ctx: IpcContext): Promise<WorktreePRResult>
  gitCommitPush(ctx: IpcContext): Promise<GitCommitPushResult>
  gitSync(ctx: IpcContext): Promise<GitSyncResult>
  gitCheckoutBranch(ctx: IpcContext, branch: string): Promise<GitCheckoutBranchResult>
  worktreeBranches(ctx: IpcContext): Promise<string[]>
  worktreeRestore(ctx: IpcContext, worktreePath: string, options?: { includePr?: boolean }): Promise<GitCheckout | null>
  continueInWorktree(ctx: IpcContext, namePrompt?: string): Promise<GitCheckoutBranchResult>
  gitRefreshState(cwd: string, options?: GitStateOptions): Promise<GitState | null>
  gitIdentity(cwd: string): Promise<GitIdentity | null>
  gitRegisterEnvironment(ctx: IpcContext, cwd: string, gitContext: GitCheckout | null): Promise<void>
  runStatus(cwd: string): Promise<RunProjectStatus>
  runStart(cwd: string, commandId: string): Promise<RunProjectStatus>
  runStop(cwd: string, commandId: string): Promise<RunProjectStatus>
  runRestart(cwd: string, commandId: string): Promise<RunProjectStatus>
  runLogs(cwd: string, commandId: string): Promise<RunLogLine[]>
  projectConfigLoad(cwd: string): Promise<ProjectConfig | null>
  projectConfigSave(cwd: string, config: ProjectConfig): Promise<ProjectConfig>
  listProjects(): Promise<ProjectEntry[]>
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
  onEnterDesignMode(callback: () => void): () => void

  onEvent(callback: (tabId: string, event: NormalizedEvent) => void): () => void
  onError(callback: (tabId: string, error: EnrichedError) => void): () => void
  onSkillStatus(callback: (status: SkillStatus) => void): () => void
  onWindowShown(callback: (cursorPos: { x: number; y: number } | null) => void): () => void
  onWindowHidden(callback: () => void): () => void
  onSessionScan(callback: (event: SessionScanEvent) => void): () => void
  onSessionIndexUpdated(callback: (event: SessionIndexUpdatedEvent) => void): () => void
  onReviewProgress(callback: (event: ReviewProgressEvent) => void): () => void
  onResetRuntime(callback: () => void): () => void
  onRunStatus(callback: (status: RunStatus) => void): () => void
  onRunLog(callback: (batch: RunLogBatch) => void): () => void
  onVoiceModelStatus(callback: (status: VoiceModelStatus) => void): () => void
  /** Native-only: resolves the OS path for a File. Web stub returns ''. */
  getPathForFile(file: File): string

  /** Tell main whether the current text selection is inside the conversation
   *  view, gating the native "Quote in reply" context-menu item. */
  setQuoteContext(active: boolean): void
  /** Fires when the user picks "Quote in reply" on selected conversation text. */
  onQuoteSelection(callback: (text: string) => void): () => void

  stackGet(ctx: IpcContext): Promise<{ repoRoot: string; graph: StackGraph }>
  stackDetect(ctx: IpcContext): Promise<{ repoRoot: string; graph: StackGraph }>
  stackAddManualEdge(ctx: IpcContext, parent: number, child: number): Promise<StackGraph>
  stackRemoveManualEdge(ctx: IpcContext, parent: number, child: number): Promise<StackGraph>
  onStackGraphUpdate(callback: (repoRoot: string, graph: StackGraph) => void): () => void
}

export interface NativeSolusAPI {
  getPlatform(): string
  getLocalConnection(): Promise<LocalConnectionInfo>
  /** Re-invokes the local-connection bootstrap to pull a fresh session token over IPC. */
  refreshLocalSessionToken(): Promise<string>
  rendererReady(mode: 'pill' | 'editor'): void
  rendererMounted(mode: 'pill' | 'editor'): void
  getPathForFile(file: File): string
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean; focus?: boolean }): void
  setQuoteContext(active: boolean): void
  onQuoteSelection(callback: (text: string) => void): () => void
}

// Main has finished booting the local server before it creates either renderer
// window. Start this immutable bootstrap lookup while the preload itself is
// evaluating so HTML parsing and renderer startup do not sit behind a fresh IPC
// round trip.
const localConnectionPromise = ipcRenderer.invoke(LOCAL_CONNECTION_CHANNEL) as Promise<LocalConnectionInfo>

const nativeApi: NativeSolusAPI = {
  getPlatform: () => process.platform,
  getLocalConnection: () => localConnectionPromise,
  refreshLocalSessionToken: () =>
    (ipcRenderer.invoke(LOCAL_CONNECTION_CHANNEL) as Promise<LocalConnectionInfo>).then((info) => info.token),
  rendererReady: (mode: 'pill' | 'editor') => ipcRenderer.send('solus:renderer-ready', mode),
  rendererMounted: (mode: 'pill' | 'editor') => ipcRenderer.send('solus:renderer-mounted', mode),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean; focus?: boolean }) =>
    ipcRenderer.send('solus:set-ignore-mouse-events', ignore, options || {}),
  setQuoteContext: (active: boolean) =>
    ipcRenderer.send('solus:set-quote-context', active),
  onQuoteSelection: (cb: (text: string) => void) => {
    const handler = (_e: unknown, text: string) => cb(text)
    ipcRenderer.on('solus:quote-selection', handler)
    return () => ipcRenderer.removeListener('solus:quote-selection', handler)
  },
}

contextBridge.exposeInMainWorld('solusNative', nativeApi)
