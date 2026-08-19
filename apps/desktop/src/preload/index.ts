import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { AgentId, AgentTaskLifecyclePolicy, AgentUsageLimits, ReasoningEffort, IpcContext, PromptOptions, PromptDelivery, PromptDispatchResult, Attachment, SessionMeta, SessionSearchResult, SessionGeneratedMetadata, RecentProject, DetectedEditor, DetectedTerminal, ResolvedTerminal, TerminalAppId, OpenInEditorRequest, FilePreviewRequest, FilePreviewResult, ProjectContentSearchRequest, ProjectContentSearchResult, ProjectFilesRequest, ProjectFilesResult, ProjectFileMutationRequest, ProjectFileMutationResult, WriteFileRequest, WriteFileResult, FileMatch, DirectoryListResult, CreateDirectoryResult, DesignAnnotation, PluginCommandsResult, RemoteSkill, SkillInstallResult, GitCheckout, TurnSnapshot, DiffResult, DiffFileContentsRequest, DiffFileContentsResult, ChangedFileStat, WorktreeEntry, GitActionRequest, GitActionResult, GitDiscardResult, GitSyncResult, GitCheckoutBranchResult, GitIdentity, GitState, GitStateOptions, GitRepositoryStatus, GitInitRepositoryResult, GithubPublishRepositoryRequest, GithubPublishRepositoryResult, ProjectConfig, ProjectEntry, ProjectIdentity, DispatchHistoryRoot, PlanDescriptor, PlanAnnotations, DiffRequest, RateLimitDecisionAction, RuntimeSessionInfo, SessionLineageResolution, SessionProviderSwitchResult, ThreadGoal, ThreadGoalSetRequest, Work, WorkMeta, WorkAnnotations, WorkPrevious, GoogleUploadDocRequest, PinnedSession, SavedPrompt, AppGlobalShortcuts, SetAppGlobalShortcutsResult, StartInfo, Automation, AutomationAction, AutomationCreator, AutomationRun, AutomationTrigger, AuthStatus, PrCheckoutContext, PrReviewContext, MergeMethod, PrMergeResult, PrConflictResolutionResult, ServerCapabilities, HostCapabilities, DiscoveredServer, SshBootstrapResult, WebPushSubscriptionJSON, SetupAgent, SetupAdoptProjectResult, SetupAgentAuthCheckResult, SetupCloneProjectRequest, SetupCloneProjectResult, SetupPrepareProjectRequest, SetupPrepareProjectResult, SetupSyncProjectRequest, SetupGithubReposResult, SetupSshAccessResult, SetupStepResult, HostReadiness, GitCommitIdentity, VoiceModelStatus, HeadlessSessionRequest, GithubDelegatedCredential, PrRepoCheckoutResult } from '@solus/contracts/types'
import type { PrDiffFileContents, PrDiffFileContentsRequest, PrDiffRequest, PrDiffSlice, PrEffortRequest, PrEffortResult, PrFilter, PrLifecycleAction, PrListPage, PrReviewer, PrReviewerCandidate, PrReviewTarget, PullRequestDetail, PullRequestOverview, PullRequestSummary, PullRequestUpdate, ReviewThread, ReviewComment, PrCommit, PrConversationItem, DraftReview } from '@solus/contracts/providers'
import type { CandidateTicket, PrepareSessionTaskRequest, PrepareSessionTaskResult, SessionExecutionHost, Task, TaskCandidateOptions, TaskCreateInput, TaskDetails, TaskExternalLink, TaskForSessionResult, TaskLinkInput, TaskLinkKind, TaskListFilter, TaskListResult, TaskProviderStatus, TaskSessionLink, TaskSessionRole, TaskSidebarSnapshot, TaskSnapshot, TaskSnoozeInput, TaskUpdatePatch } from '@solus/contracts/task-types'
import type { OutboxApplyResult, OutboxOp } from '@solus/contracts/outbox-types'
import type { SessionPreviewResult, WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { AttentionEntry } from '@solus/contracts/attention-types'
import type { ReviewLedger, ReviewContext, ReviewGuide, ReviewState, ReviewGuideStatusEvent, PrGuideMetadata, PrGuideMetadataRequest } from '@solus/contracts/review'
import type { StackGraph } from '@solus/contracts/stack-types'
import type { PrChecksSnapshot } from '@solus/contracts/checks-rpc-types'
import type { AssetCreateUrlRequest, AssetCreateUrlResult, AttachmentUploadRequest, SearchSessionsRequest } from '@solus/contracts/rpc'
import type { MetricsNlCompileResult, MetricsQueryResult, MetricsQuerySpec, MetricsSchema, MetricsSessionSummary, MetricsSqlValidation, MetricsTurnTrace, MetricsValue, SavedMetricsQuery } from '@solus/contracts/observability-types'
import type { ClientNotificationRequest } from '@solus/contracts/notification-types'

import type {
  OtelSettings,
  OtelSettingsSnapshot,
  TextGenerationSettings,
  TextGenerationSettingsSnapshot,
} from '@solus/contracts/types'

const LOCAL_CONNECTION_CHANNEL = 'solus:local-connection'

export type { LocalConnectionInfo, SolusAPI } from '@solus/contracts/host-api'
import type { LocalConnectionInfo, SolusAPI } from '@solus/contracts/host-api'

export type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { NativeSolusAPI } from '@solus/contracts/host-api'

// Main has finished booting the local server before it creates either renderer
// window. Start this immutable bootstrap lookup while the preload itself is
// evaluating so HTML parsing and renderer startup do not sit behind a fresh IPC
// round trip.
const localConnectionPromise: Promise<LocalConnectionInfo> = ipcRenderer.invoke(LOCAL_CONNECTION_CHANNEL)

// One IPC listener per channel, fanned out to however many callers subscribe.
// A listener per caller crossed Node's ten-listener warning threshold on
// `solus:window-shown`: the renderer keeps every tab mounted, so each tab
// holding a composer added its own.
function channelFanOut<Args extends unknown[]>(channel: string): (cb: (...args: Args) => void) => () => void {
  const callbacks = new Set<(...args: Args) => void>()
  ipcRenderer.on(channel, (_event: IpcRendererEvent, ...args: unknown[]) => {
    // SAFETY: main sends exactly `Args` on this channel — the channel name and
    // the payload type are fixed together at each `channelFanOut` call below.
    const payload = args as Args
    for (const cb of callbacks) cb(...payload)
  })
  return (cb) => {
    callbacks.add(cb)
    return () => { callbacks.delete(cb) }
  }
}

const subscribeQuoteSelection = channelFanOut<[text: string, sourceTabId: string]>('solus:quote-selection')
const subscribeAskSelectionInNewSession
  = channelFanOut<[text: string, sourceTabId: string]>('solus:ask-selection-in-new-session')
const subscribeOpenRoute = channelFanOut<[route: string]>('solus:open-route')
const subscribeThemeChange = channelFanOut<[isDark: boolean]>('solus:theme-changed')
const subscribeWindowShown = channelFanOut<[cursorPos: { x: number; y: number } | null]>('solus:window-shown')
const subscribeWindowHidden = channelFanOut<[]>('solus:window-hidden')

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
  onQuoteSelection: subscribeQuoteSelection,
  onAskSelectionInNewSession: subscribeAskSelectionInNewSession,
  /** A location the app was asked to open from outside the renderer — today a
   *  notification click; the payload is a serialized route. */
  onOpenRoute: subscribeOpenRoute,
  onThemeChange: subscribeThemeChange,
  onWindowShown: subscribeWindowShown,
  onWindowHidden: subscribeWindowHidden,
}

contextBridge.exposeInMainWorld('solusNative', nativeApi)
