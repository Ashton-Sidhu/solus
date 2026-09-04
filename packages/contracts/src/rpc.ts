// ─── RPC method/topic registry ───
//
// Single source of truth for every request name in the Solus client/server
// protocol. Host events are declared separately in `host-events.ts`.
//
// The renderer calls a host-addressed API handle. The preload
// (or web client) wraps each call into a single envelope `{ method, args }`
// sent on one channel (`solus:rpc` for Electron, `/ws` JSON frames for web).
//
// To add a new method, add the name here and register a handler against
// `SolusServer`.

/** Maximum decoded size of one attachment uploaded across a host boundary. */
export const MAX_ATTACHMENT_UPLOAD_BYTES = 10 * 1024 * 1024
/** Maximum uploaded attachment files retained for one session. */
export const MAX_ATTACHMENT_UPLOAD_COUNT = 8

export interface AttachmentUploadRequest {
  name: string
  mime: string
  dataUrl: string
}

export interface AssetCreateUrlRequest {
  /** Existing host path authored by an agent. Mutually exclusive with assetId. */
  path?: string
  /** Content-addressed asset created through assetUpload. */
  assetId?: string
  /** Suggested download name for a stored attachment. */
  name?: string
}

export interface AssetCreateUrlResult {
  relativeUrl: string
  expiresAt: number
}

export type AssetUploadRequest = AttachmentUploadRequest

export interface AssetUploadResult {
  id: string
  uri: string
  mime: string
  size: number
}

export const RPC_INVOKE_METHODS = [
  // Lifecycle / window
  'start',
  'isVisible',
  'switchMode',
  'getAppGlobalShortcuts',
  'setAppGlobalShortcuts',
  'restartApp',
  'serverGetCapabilities',

  // Sessions / agent
  'watchSession',
  'unwatchSession',
  'prompt',
  'retry',
  'stopSession',
  'resetSession',
  'switchSessionAgent',

  // Agent conversations (cards drive sessions no client is looking at)
  'createHeadlessSession',
  'promptSession',

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
  'resolveTerminal',
  'attachFiles',
  'attachFilePaths',
  'attachUpload',
  'assetUpload',
  'assetCreateUrl',
  'takeScreenshot',
  'pasteImage',
  'transcribeAudio',
  'warmTranscription',
  'voiceModelStatus',
  'voiceModelRetry',
  'logVoiceTranscription',
  'searchFiles',
  'searchProjectContents',
  'listDirectory',
  'createDirectory',
  'readProjectFile',
  'listProjectFiles',
  'mutateProjectFile',
  'writeFile',
  'updateAgentFiles',

  // Code intelligence
  'codeIntelSymbolAt',
  'codeIntelReferences',
  'codeIntelDocs',
  'codeIntelStatus',
  'codeIntelInstall',
  'codeIntelReindex',

  // Sessions / plans / projects
  'bindRuntimeSession',
  'listSessions',
  'searchSessions',
  'loadSession',
  'loadSessionPreview',
  'getSessionInfo',
  'getSessionInfos',
  'resolveSessionLineage',
  'generateSessionMetadata',
  'setSessionTitle',
  'setSessionBranch',
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

  // Plugins
  'getPluginCommands',

  // Worktree / diff / git
  'worktreeListProject',
  'diff',
  'diffFileContents',
  'diffStats',
  'listTurnSnapshots',
  'gitRunAction',
  'gitDiscard',
  'gitSync',
  'gitCheckoutBranch',
  'worktreeBranches',
  'worktreeRestore',
  'continueInWorktree',
  'gitRefreshState',
  'gitIdentity',
  'gitRegisterEnvironment',
  'gitRepositoryStatus',
  'gitInitRepository',
  'githubPublishRepository',
  'projectConfigLoad',
  'projectConfigSave',
  'listProjects',
  'listProjectIdentities',
  'resolveDispatchHistoryRoots',
  'deleteProject',

  // Skills (skills.sh registry — opt-in install across active providers)
  'skillsSearch',
  'skillsInstall',

  // Pinned sessions (sidebar pins persisted to ~/.solus/pinned-sessions.json)
  'pinnedSessionsList',
  'togglePinnedSession',

  // Client activity lease: foreground heartbeat gating host freshness work
  'activityLease',

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
  'connectionsSetTrustLocalNetwork',
  // Personal Uplink: the host's link to the owner's Solus cloud account (local-only)
  'uplinkLink',
  'uplinkUnlink',
  'uplinkStatus',
  'setAnalyticsConsent',

  // Host config — the tier that follows a user between clients
  'configGet',
  'configUpdate',

  'textGenerationSettingsGet',
  'otelSettingsGet',
  'discoverServers',
  'getServerCapabilities',
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

  // Upstream doc mirror for works (Confluence pages, Google Docs)
  'docProviderStatuses',
  'docDestinations',
  'publishWork',
  'pullWorkUpstream',
  'refreshWorkUpstream',
  'unlinkWorkUpstream',
  'publishPlan',
  'pullPlanUpstream',
  'refreshPlanUpstream',
  'unlinkPlanUpstream',
  'importDocFromUrl',

  // Google Drive integration
  'googleStatus',
  'googleConnect',
  'googleDisconnect',

  // Cloudflare deployment credentials
  'cloudflareStatus',
  'cloudflareConnect',
  'cloudflareDisconnect',

  // Atlassian site credentials (Confluence docs + Jira tasks)
  'atlassianStatus',
  'atlassianStartOAuth',
  'atlassianCancelOAuth',
  'atlassianDisconnect',
  'atlassianJiraProjects',

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
  'prGetDiff',
  'prGetDiffFileContents',
  'prPrepareCheckout',
  'prGetDetail',
  'prUpdate',
  'prGetOverview',
  'prChangedFiles',
  'prListThreads',
  'prListComments',
  'prListCommits',
  'prListReviewers',
  'prListReviewerCandidates',
  'prRequestReviewers',
  'prRemoveRequestedReviewer',
  'prListLabelCandidates',
  'prSetLabels',
  'prUpdateLifecycle',
  'prSubmitReview',
  'prAddIssueComment',
  'prDeleteIssueComment',
  'prInterdiff',
  'prReplyThread',
  'prResolveThread',
  'prUnresolveThread',
  'prGenerateGuides',
  'prMerge',
  'prPrepareConflictResolution',
  'prInvalidate',

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

  // Tasks (global native store plus project-scoped upstream providers)
  'tasksProviderStatus',
  'inboxListUpstream',
  'tasksListUpstream',
  'tasksGetUpstream',
  'tasksUpdateUpstream',
  'tasksCommentUpstream',
  'tasksListAssigneeCandidates',
  'tasksListCandidates',
  'tasksImport',
  'tasksPublish',
  'tasksSyncNow',
  'tasksList',
  'tasksSidebarSnapshot',
  'tasksGet',
  'tasksCreate',
  'tasksUpdate',
  'tasksMarkRead',
  'tasksRecordActivity',
  'tasksDelete',
  'tasksComment',
  'tasksDeleteComment',
  'tasksPublishComments',
  'tasksLinkSession',
  'tasksUnlinkSession',
  'tasksRekeySession',
  'tasksSessions',
  'tasksForSession',
  'tasksPrepareForSession',
  'tasksSnapshot',
  'tasksLink',
  'tasksUnlink',
  'tasksLinkedTo',
  'tasksAttachArtifact',

  // Host outbox (cross-host writes, ferried by clients — ADR-0007)
  'outboxList',
  'outboxAck',
  'outboxApply',

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

  // Browser (viewing and driving a running UI at a chosen viewport)
  'browserListTargets',
  'browserListPages',
  'browserOpen',
  'browserClose',
  'browserNavigate',
  'browserSetViewport',
  'browserSetAppearance',
  'browserSnapshot',
  'browserInteract',
  'browserAttachSurface',
  'browserDetachSurface',
  'browserReportSurface',
  'browserClearProfile',
  'browserSubscribeFrames',
  'browserUnsubscribeFrames',
  'browserCaptureEvidence',
  'browserEvidenceOptions',
  'browserOpenDevTools',
  'browserSetAnnotationTool',
  'browserAnnotationState',
  'browserAnnotate',

  // Observability / Insights (metrics.db query engine)
  'metricsQuery',
  'metricsRunSql',
  'metricsTurnPage',
  'metricsValidateSql',
  'metricsCompileNl',
  'metricsSchema',
  'metricsDistinctValues',
  'metricsListSavedQueries',
  'metricsSaveQuery',
  'metricsDeleteQuery',
  'metricsSessionSummary',
  'metricsTurnTrace',
  'logFilePath',
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
