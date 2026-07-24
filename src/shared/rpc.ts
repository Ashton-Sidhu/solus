// ─── RPC method/topic registry ───
//
// Single source of truth for every channel name in the Solus client/server
// protocol. The WebSocket transport dispatches through
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
  'switchMode',
  'getAppGlobalShortcuts',
  'setAppGlobalShortcuts',
  'restartApp',

  // Tabs / agent
  'createTab',
  'prompt',
  'stopTab',
  'retry',
  'closeTab',
  'resetTabSession',
  'switchSessionAgent',

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
  'voiceModelStatus',
  'voiceModelRetry',
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
  'searchSessions',
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
  'diffStats',
  'listTurnSnapshots',
  'worktreePR',
  'gitCommitPush',
  'gitSync',
  'gitCheckoutBranch',
  'worktreeBranches',
  'worktreeRestore',
  'continueInWorktree',
  'gitRefreshState',
  'gitIdentity',
  'gitRegisterEnvironment',
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
  'designModeReady',
  'exitDesignMode',
  'submitDesignAnnotations',

  // Connections (server-side multi-client + pairing)
  'connectionsListEndpoints',
  'connectionsGeneratePairToken',
  'connectionsListSessions',
  'connectionsRevokeDevice',
  'connectionsGetServerInfo',
  'connectionsSetRemoteAccess',
  'discoverServers',
  'getServerCapabilities',
  'setServerName',
  'setupInstallAgentCli',
  'setupCheckAgentAuth',
  'setupListGithubRepos',
  'setupCloneProject',

  // Attention (server-side per-session needs-attention state; outlives clients)
  'listAttention',

  // Web Push notifications for paired web devices
  'pushGetPublicKey',
  'pushSubscribe',
  'pushUnsubscribe',

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
  'providerViewer',

  // PR review mode (read PRs, enter review, comment, threads)
  'prList',
  'prNeedsReview',
  'prGetEfforts',
  'prGuideMetadata',
  'prOpenReview',
  'prGetDetail',
  'prGetOverview',
  'prChangedFiles',
  'prListThreads',
  'prListComments',
  'prListCommits',
  'prListReviewers',
  'prSubmitReview',
  'prAddIssueComment',
  'prInterdiff',
  'prReplyThread',
  'prResolveThread',
  'prUnresolveThread',
  'prGenerateGuides',
  'prMerge',
  'prPrepareConflictResolution',

  // Review guide (agent code-review ledger + guided walkthrough)
  'readLedger',
  'writeLedger',
  'getReviewContext',
  'generateGuide',
  'cancelGenerateGuide',
  'readGuide',
  'readReviewState',
  'writeReviewState',

  // Tasks (provider-backed tickets: list/get/CRUD behind one interface)
  'tasksProviderStatus',
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

  // PR stack detection + manual pins
  'stackGet',
  'stackDetect',
  'stackAddManualEdge',
  'stackRemoveManualEdge',

  // PR checks cache + renderer activity hint
  'prChecks',
  'prChecksActivity',
] as const

export type RpcInvokeMethod = (typeof RPC_INVOKE_METHODS)[number]
export type RpcMethod = RpcInvokeMethod

export interface SearchSessionsRequest {
  query: string
  /** Omit to search every project; set to scope to one git-root. */
  projectRoot?: string
  providers?: string[]
  role?: 'user' | 'assistant'
  sinceTs?: number
  limit?: number
}

export const RPC_TOPICS = [
  'normalized-event',
  'enriched-error',
  'skill-status',
  'theme-changed',
  'enter-design-mode',
  'window-shown',
  'window-hidden',
  'presence',
  'session-scan',
  'session-index-updated',
  'run-status',
  'run-log',
  'setup-status',
  'setup-log',
  'voice-model-status',
  'automations-changed',
  'provider-device-code',
  'review-progress',
  'tasks-changed',
  'prs-changed',
  'attention-changed',
  'stack-graph-update',
  'pr-checks-update',
  'pr-guide-status',
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
