// ─── RPC method/topic registry ───
//
// Single source of truth for every request name in the Solus client/server
// protocol. Host events are declared separately in `host-events.ts`.
//
// The renderer continues to call `window.solus.<method>(...args)`. The preload
// (or web client) wraps each call into a single envelope `{ method, args }`
// sent on one channel (`solus:rpc` for Electron, `/ws` JSON frames for web).
//
// To add a new method, add the name here and register a handler against
// `SolusServer`.

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

  // Agent conversations (cards drive sessions that have no bound tab)
  'createHeadlessSession',
  'promptSession',
  'stopSession',

  // Permission / interaction
  'respondPermission',
  'respondQuestion',
  'rateLimitDecision',
  'cancelQueuedPrompt',
  'editQueuedPrompt',
  'writePlanFile',
  'rewindFiles',

  // Files / media
  'saveFileDialog',
  'openExternal',
  'openInFileManager',
  'openInTerminal',
  'openWorktreeTerminal',
  'attachFiles',
  'attachFilePaths',
  'takeScreenshot',
  'pasteImage',
  'transcribeAudio',
  'warmTranscription',
  'voiceModelStatus',
  'voiceModelRetry',
  'logVoiceTranscription',
  'searchFiles',
  'listDirectory',
  'createDirectory',
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
  'generateSessionTitle',
  'setSessionTitle',
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
  'diffFileContents',
  'diffStats',
  'listTurnSnapshots',
  'worktreePR',
  'gitCommit',
  'gitCommitPush',
  'gitDiscard',
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
  'runLogsRetain',
  'runLogsRelease',
  'projectConfigLoad',
  'projectConfigSave',
  'listProjects',
  'listProjectIdentities',
  'deleteProject',

  // Skills (skills.sh registry — opt-in install across active providers)
  'skillsSearch',
  'skillsInstall',

  // Pinned sessions (sidebar pins persisted to ~/.solus/pinned-sessions.json)
  'pinnedSessionsList',
  'togglePinnedSession',

  // Saved prompts (per-project composer drafts in ~/.solus/solus.db)
  'savedPromptsList',
  'savedPromptsCreate',
  'savedPromptsDelete',

  // Design mode
  'enterDesignMode',
  'designModeReady',
  'exitDesignMode',
  'submitDesignAnnotations',

  // Connections (server-side multi-client + pairing)
  'connectionsListEndpoints',
  'connectionsGeneratePairToken',
  'connectionsListSessions',
  'connectionsBootstrapDiscoveredServer',
  'connectionsRevokeDevice',
  'connectionsGetServerInfo',
  'connectionsSetRemoteAccess',
  'setAnalyticsConsent',
  'discoverServers',
  'getServerCapabilities',
  'setServerName',
  'setProjectsBaseDirectory',
  'setupInstallAgentCli',
  'setupCheckAgentAuth',
  'setupAgentSignIn',
  'setupSubmitAgentSignInCode',
  'setupCancelAgentSignIn',
  'setupListGithubRepos',
  'setupPrepareProject',
  'setupCloneProject',
  'setupSyncProject',
  'setupAdoptProject',
  'setupHostReadiness',
  'setupInstallGit',
  'setupInstallGh',
  'setupSetGitIdentity',
  'setupCheckSshAccess',
  'setupAuthorizeGhCli',
  'setupInstallGitCredentialHelper',

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

  // Cloudflare deployment credentials
  'cloudflareStatus',
  'cloudflareConnect',
  'cloudflareDisconnect',

  // Git provider (code-host) auth
  'providerStatus',
  'providerConnect',
  'providerCancelConnect',
  'providerDisconnect',
  'githubExportCredential',
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
  'requestReviewGuide',
  'reviewGuideStatus',
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

  // Subscription quota per agent provider
  'usageLimits',
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

export interface RpcEnvelope {
  method: RpcMethod
  args: unknown[]
}
