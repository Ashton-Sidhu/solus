// ─── RPC method/topic registry ───
//
// Single source of truth for every channel name in the Solus client/server
// protocol. Both transports (Electron IPC and WebSocket) dispatch through
// `SolusServer.handle(method, args)` and `SolusServer.broadcast(topic, ...)`.
//
// The renderer continues to call `window.solus.<method>(...args)`. The preload
// (or web client) wraps each call into a single envelope `{ method, args }`
// sent on one channel (`solus:rpc` for Electron, `/ws` JSON frames for web).
//
// To add a new method: add the name here and register a handler against
// `SolusServer`. To add a new event: add it to RPC_TOPICS and wire a publisher.

export const RPC_INVOKE_METHODS = [
  // Lifecycle / window
  'start',
  'isVisible',
  'notifyViewMode',
  'getAppGlobalShortcuts',
  'setAppGlobalShortcuts',
  'restartApp',

  // Tabs / agent
  'createTab',
  'startAgentSession',
  'dispatchToAgentSession',
  'prompt',
  'stopTab',
  'retry',
  'closeTab',

  // Permission / interaction
  'respondPermission',
  'respondQuestion',
  'rateLimitDecision',
  'cancelQueuedPrompt',
  'writePlanFile',
  'rewindFiles',

  // Files / media
  'selectDirectory',
  'saveFileDialog',
  'openExternal',
  'openInTerminal',
  'openWorktreeTerminal',
  'attachFiles',
  'attachFilePaths',
  'takeScreenshot',
  'pasteImage',
  'transcribeAudio',
  'logVoiceTranscription',
  'searchFiles',
  'listDirectory',
  'readProjectFile',
  'listProjectFiles',
  'writeFile',
  'updateAgentFiles',

  // Sessions / plans / projects
  'bindRuntimeSession',
  'listSessions',
  'loadSession',
  'loadSessionPreview',
  'getSessionInfo',
  'listRecentProjects',
  'trackRecentProject',
  'listPlans',
  'loadPlanContent',
  'getThreadGoal',
  'setThreadGoal',
  'clearThreadGoal',
  'loadPlanAnnotations',
  'savePlanAnnotations',
  'toggleBookmarkPlan',

  // Editor integration
  'detectEditors',
  'openInEditor',

  // Theme + plugins
  'getTheme',
  'getPluginCommands',

  // Worktree / diff / git
  'worktreeListProject',
  'diff',
  'listTurnSnapshots',
  'worktreePR',
  'gitCommitPush',
  'gitSync',
  'gitCheckoutBranch',
  'worktreeBranches',
  'worktreeRestore',
  'continueInWorktree',
  'gitProjectStatus',
  'runStatus',
  'runStart',
  'runStop',
  'runRestart',
  'runLogs',
  'projectConfigLoad',
  'projectConfigSave',
  'listProjects',
  'deleteProject',

  // Skills (skills.sh registry — opt-in install across active providers)
  'skillsSearch',
  'skillsInstall',

  // Pinned sessions (sidebar pins persisted to ~/.solus/pinned-sessions.json)
  'pinnedSessionsList',
  'togglePinnedSession',

  // Design mode
  'enterDesignMode',
  'submitDesignAnnotations',

  // Connections (server-side multi-client + pairing)
  'connectionsListEndpoints',
  'connectionsGeneratePairToken',
  'connectionsListSessions',
  'connectionsRevokeDevice',
  'connectionsGetServerInfo',

  // Folio / works
  'createWork',
  'saveWork',
  'loadWork',
  'listWorks',
  'deleteWork',
  'duplicateWork',
  'linkWorkSession',
  'promoteWorkToProject',
  'loadWorkAnnotations',
  'saveWorkAnnotations',
  'agentSaveWork',
  'loadWorkPrevious',
  'revertWork',
  'setWorkPinned',

  // Google Drive integration
  'googleUploadDoc',
  'googleDisconnect',

  // Git provider (code-host) auth
  'providerStatus',
  'providerConnect',
  'providerCancelConnect',
  'providerDisconnect',

  // PR review mode (read PRs, enter review, comment, threads)
  'prList',
  'prOpenReview',
  'prGetDetail',
  'prGetOverview',
  'prChangedFiles',
  'prListThreads',
  'prListCommits',
  'prListReviewers',
  'prSubmitReview',
  'prReplyThread',
  'prResolveThread',
  'prUnresolveThread',

  // Review guide (agent code-review ledger + guided walkthrough)
  'readLedger',
  'writeLedger',
  'getReviewContext',
  'generateGuide',
  'readGuide',
  'readReviewState',
  'writeReviewState',

  // Tasks (provider-backed tickets: list/get/CRUD behind one interface)
  'tasksList',
  'tasksGet',
  'tasksCreate',
  'tasksUpdate',
  'tasksDelete',
  'tasksComment',
  'tasksLinkSession',
  'tasksSessions',

  // Automations (run-now; CRUD + run history)
  'automationCreate',
  'automationList',
  'automationRead',
  'automationUpdate',
  'automationDelete',
  'automationSetEnabled',
  'automationRun',
  'automationCancel',
  'automationListRuns',
  'automationReadRun',
] as const

// Fire-and-forget messages — never wait for a result.
export const RPC_SEND_METHODS = [
  'resetTabSession',
  'designModeReady',
] as const

export type RpcInvokeMethod = (typeof RPC_INVOKE_METHODS)[number]
export type RpcSendMethod = (typeof RPC_SEND_METHODS)[number]
export type RpcMethod = RpcInvokeMethod | RpcSendMethod

export const RPC_TOPICS = [
  'normalized-event',
  'enriched-error',
  'skill-status',
  'theme-changed',
  'enter-design-mode',
  'window-shown',
  'window-hidden',
  'presence',
  'seq-watermark',
  'session-scan',
  'run-status',
  'run-log',
  'provider-device-code',
  'review-progress',
  'tasks-changed',
] as const

export type RpcTopic = (typeof RPC_TOPICS)[number]

// Single channel used by the Electron IPC transport. Each request carries
// `{ method, args }`; results return through ipcRenderer.invoke's promise.
export const ELECTRON_RPC_CHANNEL = 'solus:rpc'
export const ELECTRON_RPC_SEND_CHANNEL = 'solus:rpc-send'
export const ELECTRON_EVENT_CHANNEL = 'solus:event'

export interface RpcEnvelope {
  method: RpcMethod
  args: unknown[]
}

export interface RpcEventEnvelope {
  topic: RpcTopic
  payload: unknown[]
  /** Per-topic monotonic sequence number; used by web clients for resume. */
  seq?: number
}
