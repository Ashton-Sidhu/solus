import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { ELECTRON_RPC_CHANNEL, ELECTRON_RPC_SEND_CHANNEL, ELECTRON_EVENT_CHANNEL, RPC_INVOKE_METHODS, RPC_SEND_METHODS } from '../shared/rpc'
import type { RpcInvokeMethod, RpcSendMethod, RpcEventEnvelope, RpcTopic } from '../shared/rpc'
import type { AgentId, ReasoningEffort, IpcContext, PromptOptions, NormalizedEvent, EnrichedError, Attachment, SessionMeta, SessionScanEvent, RecentProject, DetectedEditor, DetectedTerminal, OpenInEditorRequest, FilePreviewRequest, FilePreviewResult, ProjectFilesRequest, ProjectFilesResult, WriteFileRequest, WriteFileResult, FileMatch, DesignAnnotation, PluginCommandsResult, SkillStatus, RemoteSkill, SkillInstallResult, TabGitContext, TurnSnapshot, DiffResult, ChangedFileStat, WorktreeEntry, WorktreePRResult, GitCommitPushResult, GitSyncResult, GitCheckoutBranchResult, GitProjectStatus, RunStatus, RunProjectStatus, RunLogLine, RunLogBatch, ProjectConfig, ProjectEntry, PlanDescriptor, PlanAnnotations, DiffRequest, RateLimitDecisionAction, RuntimeSessionInfo, ThreadGoal, ThreadGoalSetRequest, Work, WorkMeta, WorkAnnotations, WorkPrevious, PinnedSession, AppGlobalShortcuts, SetAppGlobalShortcutsResult, StartInfo, Automation, AutomationAction, AutomationCreator, AutomationRun, AutomationTrigger, AuthStatus, DeviceCodePrompt, PrReviewContext } from '../shared/types'
import type { PrFilter, PrReviewer, PullRequestSummary, PullRequestDetail, PullRequestOverview, ReviewThread, ReviewComment, PrCommit, DraftReview } from '../shared/providers'
import type { Task, TaskSessionLink } from '../shared/task-types'
import type { SessionLoadMessage, SessionPreviewResult } from '../shared/claude-types'
import type { ReviewLedger, ReviewContext, ReviewGuide, ReviewState, ReviewProgressEvent } from '../shared/review'

// Renderer-facing surface. Each method dispatches over a single IPC channel
// (`solus:rpc` for invoke, `solus:rpc-send` for send), routed by name to the
// SolusServer in main. Adding a method = appending to RPC_INVOKE_METHODS in
// shared/rpc.ts and registering a handler against SolusServer.
export interface SolusAPI {
  start(): Promise<StartInfo>
  createTab(tabId?: string): Promise<{ tabId: string }>
  startAgentSession(ctx: IpcContext, options: PromptOptions): Promise<{ agentSessionId: string }>
  dispatchToAgentSession(ctx: IpcContext, agentSessionId: string, options: PromptOptions): Promise<void>
  prompt(ctx: IpcContext, options: PromptOptions): Promise<void>
  stopTab(ctx: IpcContext): Promise<boolean>
  retry(ctx: IpcContext, options: PromptOptions): Promise<void>
  closeTab(ctx: IpcContext): Promise<void>
  selectDirectory(ctx?: IpcContext): Promise<string | null>
  saveFileDialog(defaultName: string, content: string): Promise<string | null>
  openExternal(url: string, options?: { hideAppAfterOpen?: boolean }): Promise<boolean>
  openInTerminal(ctx: IpcContext): Promise<boolean>
  openWorktreeTerminal(ctx: IpcContext): Promise<boolean>
  attachFiles(ctx?: IpcContext): Promise<Attachment[] | null>
  attachFilePaths(paths: string[], ctx?: IpcContext): Promise<Attachment[] | null>
  takeScreenshot(ctx?: IpcContext): Promise<Attachment | null>
  pasteImage(dataUrl: string, ctx?: IpcContext): Promise<Attachment | null>
  transcribeAudio(audioBase64: string, ctx?: IpcContext): Promise<{ error: string | null; transcript: string | null }>
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
  listDirectory(path: string, showHidden?: boolean): Promise<{ entries: { name: string; isDir: boolean; path: string }[]; parentPath: string | null; currentPath: string }>
  readProjectFile(ctx: IpcContext, request: FilePreviewRequest): Promise<FilePreviewResult>
  listProjectFiles(ctx: IpcContext, request?: ProjectFilesRequest): Promise<ProjectFilesResult>
  writeFile(ctx: IpcContext, request: WriteFileRequest): Promise<WriteFileResult>
  respondPermission(ctx: IpcContext, questionId: string, optionId: string, updatedPlan?: string): Promise<boolean>
  writePlanFile(filePath: string, content: string, ctx?: IpcContext): Promise<{ ok: boolean; error?: string }>
  respondQuestion(ctx: IpcContext, questionId: string, answers: Record<string, string>): Promise<boolean>
  rateLimitDecision(ctx: IpcContext, action: RateLimitDecisionAction): Promise<boolean>
  cancelQueuedPrompt(ctx: IpcContext, queueId: string): Promise<boolean>
  bindRuntimeSession(ctx: IpcContext): Promise<RuntimeSessionInfo | null>
  resetTabSession(ctx: IpcContext): void
  listSessions(projectPath?: string, ctx?: IpcContext, provider?: AgentId, streamId?: string): Promise<SessionMeta[]>
  loadSession(sessionId: string, projectPath?: string, ctx?: IpcContext, provider?: AgentId, limit?: number): Promise<SessionLoadMessage[]>
  loadSessionPreview(sessionId: string, projectPath?: string, ctx?: IpcContext, provider?: AgentId): Promise<SessionPreviewResult>
  getSessionInfo(sessionId: string, projectPath?: string, ctx?: IpcContext, provider?: AgentId): Promise<SessionMeta | null>
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

  providerStatus(ctx: IpcContext): Promise<AuthStatus>
  providerConnect(ctx: IpcContext): Promise<AuthStatus>
  /** Abort an in-flight providerConnect; its promise rejects with a cancellation. */
  providerCancelConnect(ctx: IpcContext): Promise<void>
  providerDisconnect(ctx: IpcContext): Promise<void>
  /** Fires with the device/user code while `providerConnect` polls. */
  onProviderDeviceCode(callback: (prompt: DeviceCodePrompt) => void): () => void

  // PR review mode
  prList(ctx: IpcContext, filter?: PrFilter): Promise<PullRequestSummary[]>
  /** Fetch + check out the PR worktree and return the assembled review context. */
  prOpenReview(ctx: IpcContext, number: number): Promise<PrReviewContext>
  /** Fetch the PR's body, author, and state for the Activity overview. */
  prGetDetail(ctx: IpcContext, number: number): Promise<PullRequestDetail>
  /** Fetch the PR detail, commits, and reviewers for the PR list detail pane. */
  prGetOverview(ctx: IpcContext, number: number): Promise<PullRequestOverview>
  /** Per-file +/- counts for the PR's change set (numstat), for the changed-files
   *  rail — avoids shipping the whole patch just to tally lines. */
  prChangedFiles(ctx: IpcContext, baseSha: string): Promise<ChangedFileStat[]>
  prListThreads(ctx: IpcContext, number: number): Promise<ReviewThread[]>
  prListCommits(ctx: IpcContext, number: number): Promise<PrCommit[]>
  prListReviewers(ctx: IpcContext, number: number): Promise<PrReviewer[]>
  prSubmitReview(ctx: IpcContext, number: number, review: DraftReview): Promise<void>
  prReplyThread(ctx: IpcContext, number: number, threadId: string, body: string): Promise<ReviewComment>
  prResolveThread(ctx: IpcContext, number: number, threadId: string): Promise<void>
  prUnresolveThread(ctx: IpcContext, number: number, threadId: string): Promise<void>

  readLedger(ctx: IpcContext): Promise<ReviewLedger | null>
  writeLedger(ctx: IpcContext, ledger: ReviewLedger): Promise<boolean>
  getReviewContext(ctx: IpcContext): Promise<ReviewContext | null>
  generateGuide(ctx: IpcContext, opts?: { agent?: AgentId; model?: string | null; reasoningEffort?: ReasoningEffort | null; scope?: 'branch' | 'session' }): Promise<{ key: string; guide: ReviewGuide } | null>
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

  tasksList(cwd: string, opts?: { query?: string; assignedToMe?: boolean }): Promise<Task[]>
  tasksGet(cwd: string, id: string): Promise<Task>
  tasksCreate(cwd: string, input: Partial<Task>): Promise<Task>
  tasksUpdate(cwd: string, id: string, patch: Partial<Task>): Promise<Task>
  tasksDelete(cwd: string, id: string): Promise<boolean>
  tasksComment(cwd: string, id: string, body: string): Promise<Task>
  tasksLinkSession(cwd: string, taskId: string, sessionId: string): Promise<void>
  tasksSessions(cwd: string): Promise<Record<string, TaskSessionLink[]>>

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

  worktreeListProject(ctx: IpcContext): Promise<WorktreeEntry[]>
  diff(ctx: IpcContext, request: DiffRequest): Promise<DiffResult | null>
  listTurnSnapshots(ctx: IpcContext): Promise<TurnSnapshot[]>
  worktreePR(ctx: IpcContext): Promise<WorktreePRResult>
  gitCommitPush(ctx: IpcContext): Promise<GitCommitPushResult>
  gitSync(ctx: IpcContext): Promise<GitSyncResult>
  gitCheckoutBranch(ctx: IpcContext, branch: string): Promise<GitCheckoutBranchResult>
  worktreeBranches(ctx: IpcContext): Promise<string[]>
  worktreeRestore(ctx: IpcContext, worktreePath: string, options?: { includePr?: boolean }): Promise<TabGitContext | null>
  continueInWorktree(ctx: IpcContext, namePrompt?: string): Promise<GitCheckoutBranchResult>
  gitProjectStatus(cwd: string): Promise<GitProjectStatus | null>
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
  notifyViewMode(mode: 'pill' | 'editor'): Promise<void>
  /** Switch to the given mode's window (toggles when omitted). Shows/creates the
   *  target window and hides the current one unless both were visible. */
  switchMode(mode?: 'pill' | 'editor'): Promise<void>
  getAppGlobalShortcuts(): Promise<AppGlobalShortcuts>
  setAppGlobalShortcuts(shortcuts: AppGlobalShortcuts): Promise<SetAppGlobalShortcutsResult>
  restartApp(): Promise<void>
  getPlatform(): string

  updateAgentFiles(ctx: IpcContext, text: string): Promise<{ success: boolean; files?: string[]; err?: string }>

  enterDesignMode(ctx?: IpcContext): Promise<{ id: string; name: string; path: string; dataUrl: string; size: number } | null>
  designModeReady(): void
  submitDesignAnnotations(data: { dataUrl: string; annotations: DesignAnnotation[] }, ctx?: IpcContext): Promise<Attachment | null>
  onEnterDesignMode(callback: () => void): () => void

  onEvent(callback: (tabId: string, event: NormalizedEvent) => void): () => void
  onError(callback: (tabId: string, error: EnrichedError) => void): () => void
  onSkillStatus(callback: (status: SkillStatus) => void): () => void
  onWindowShown(callback: (cursorPos: { x: number; y: number } | null) => void): () => void
  onWindowHidden(callback: () => void): () => void
  onSessionScan(callback: (event: SessionScanEvent) => void): () => void
  onReviewProgress(callback: (event: ReviewProgressEvent) => void): () => void
  onSeqWatermark(callback: (seqByTopic: Record<string, number>) => void): () => void
  onRunStatus(callback: (status: RunStatus) => void): () => void
  onRunLog(callback: (batch: RunLogBatch) => void): () => void
  /** Native-only: resolves the OS path for a File. Web stub returns ''. */
  getPathForFile(file: File): string

  /** Tell main whether the current text selection is inside the conversation
   *  view, gating the native "Quote in reply" context-menu item. */
  setQuoteContext(active: boolean): void
  /** Fires when the user picks "Quote in reply" on selected conversation text. */
  onQuoteSelection(callback: (text: string) => void): () => void
}

const invokeSet = new Set<string>(RPC_INVOKE_METHODS)
const sendSet = new Set<string>(RPC_SEND_METHODS)

function rpcInvoke(method: RpcInvokeMethod, args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke(ELECTRON_RPC_CHANNEL, { method, args })
}
function rpcSend(method: RpcSendMethod, args: unknown[]): void {
  ipcRenderer.send(ELECTRON_RPC_SEND_CHANNEL, { method, args })
}

// Single event channel; each push carries `{ topic, seq, payload }`. We
// fan out to per-topic subscriber sets here in the preload.
type Listener = (...payload: unknown[]) => void
const subscribers = new Map<RpcTopic, Set<Listener>>()
ipcRenderer.on(ELECTRON_EVENT_CHANNEL, (_e, env: RpcEventEnvelope) => {
  const set = subscribers.get(env.topic)
  if (!set) return
  for (const listener of set) {
    try { listener(...(env.payload as unknown[])) } catch {}
  }
})

function on(topic: RpcTopic, listener: Listener): () => void {
  let set = subscribers.get(topic)
  if (!set) { set = new Set(); subscribers.set(topic, set) }
  set.add(listener)
  return () => set!.delete(listener)
}

const eventBindings: Record<string, RpcTopic> = {
  onEvent: 'normalized-event',
  onError: 'enriched-error',
  onSkillStatus: 'skill-status',
  onThemeChange: 'theme-changed',
  onEnterDesignMode: 'enter-design-mode',
  onWindowShown: 'window-shown',
  onWindowHidden: 'window-hidden',
  onSessionScan: 'session-scan',
  onReviewProgress: 'review-progress',
  onSeqWatermark: 'seq-watermark',
  onRunStatus: 'run-status',
  onRunLog: 'run-log',
  onProviderDeviceCode: 'provider-device-code',
}

// Build the SolusAPI surface as a plain object. `Proxy` would also work, but
// an explicit map plays better with Electron's contextBridge serialization
// (Proxy traps don't survive the structured-clone barrier).
const api: Record<string, unknown> = {
  getPlatform: () => process.platform,
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

for (const method of RPC_INVOKE_METHODS) {
  api[method] = (...args: unknown[]) => rpcInvoke(method, args)
}
for (const method of RPC_SEND_METHODS) {
  api[method] = (...args: unknown[]) => rpcSend(method, args)
}
for (const [eventMethod, topic] of Object.entries(eventBindings)) {
  api[eventMethod] = (cb: Listener) => on(topic, cb)
}

// Defensive checks — if a name appears in both sets the registry is wrong.
for (const m of RPC_INVOKE_METHODS) {
  if (sendSet.has(m)) throw new Error(`RPC method "${m}" is in both invoke and send sets`)
}
for (const m of RPC_SEND_METHODS) {
  if (invokeSet.has(m)) throw new Error(`RPC method "${m}" is in both send and invoke sets`)
}

contextBridge.exposeInMainWorld('solus', api as unknown as SolusAPI)
