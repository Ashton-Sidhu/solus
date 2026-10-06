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

/** Ask for permission to stream one file to the host over HTTP. The bytes do
 *  not cross the RPC: base64 in a WebSocket frame cannot carry a 50 MB video. */
export interface AttachmentUploadTokenRequest {
  name: string
  mime: string
  /** Exact byte count. The upload route refuses a body of any other length. */
  size: number
}

export interface AttachmentUploadTokenResult {
  /** `POST` the raw bytes here, relative to the host origin. No other auth. */
  relativeUrl: string
  /** Where the file will be once the upload succeeds. */
  hostPath: string
  expiresAt: number
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

export interface AssetFindUrlRequest {
  /** Existing host paths in preference order. The first servable file wins. */
  paths: string[]
}

export interface AssetFindUrlResult extends AssetCreateUrlResult {
  /** The candidate that was served. */
  path: string
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
  'stopBackgroundTasks',
  'resetSession',
  'acceptPlan',
  'switchSessionAgent',

  // Agent conversations (cards drive sessions no client is looking at)
  'createHeadlessSession',
  'decideSessionPlan',

  // Permission / interaction
  'respondPermission',
  'respondQuestion',
  'rateLimitDecision',
  'cancelQueuedPrompt',
  'editQueuedPrompt',
  'sessionQueue',
  'sessionQueueChange',
  'writePlanFile',

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
  'attachUploadToken',
  'assetUpload',
  'assetCreateUrl',
  'assetFindUrl',
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
  'mutateHostPath',
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
  'sharedSessionAvailable',
  'sharedSessionPrompt',
  'sessionRecordUpsert',
  'workspaceProjectList',
  'workspaceProjectAdd',
  'workspaceProjectRemove',
  'workspaceProjectUpdate',
  'loadSession',
  'loadSessionPage',
  'loadSessionToolInputs',
  'loadSessionPreview',
  'loadSessionMessageWindow',
  'getSessionInfo',
  'getSessionInfos',
  'describeSession',
  'generateSessionMetadata',
  'ensureBackgroundSessionTitle',
  'setSessionTitle',
  'setSessionBranch',
  'sessionPullRequestsList',
  'sessionPullRequestLink',
  'sessionPullRequestUnlink',
  'sessionShelfList',
  'sessionSetSettled',
  'sessionSnooze',
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
  'decideWorktreeOffer',
  'checkoutSnapshot',
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
  'skillsList',
  'skillsRemove',

  // Pinned sessions (sidebar pins persisted to ~/.solus/pinned-sessions.json)
  'pinnedSessionsList',
  'togglePinnedSession',

  // Read state. Server-owned so every client agrees on what has been read;
  // the host broadcasts `session.readStateChanged` after the write.
  'setSessionReadState',

  // Client activity lease: foreground heartbeat gating host freshness work
  'activityLease',

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
  'uplinkDetachOrganization',
  'uplinkStatus',
  // Organization scope (docs/plans/organization-scope.md): this host's standing, its Insights opt-ins, and publication
  'hostOrganizations',
  'hostSetInsightsOptIn',
  'publicationStart',
  'publicationList',
  // Cloud sharing (docs/plans/cloud-sharing.md): a Local work read from its host, uploaded to the Solus API, then removed
  'workExportForCloud',
  'workMarkMoved',
  'workUpload',
  'taskExportForCloud',
  'taskMarkMoved',
  'taskUpload',
  // Sharing: who may open one session or work on this host
  'shareGet',
  'shareSet',
  'shareSetLink',
  'shareTransfer',
  // Provider seats: a member's own Claude or Codex login on this host
  'seatList',
  'seatConnectStart',
  'seatConnectSubmitCode',
  'seatConnectCancel',
  'seatConnectToken',
  'seatDisconnect',
  'seatRemove',
  // Agent sign-ins beyond the seat: Claude Design and one MCP server's OAuth, in the caller's seat
  'agentAuthStart',
  'agentAuthSubmit',
  'agentAuthCancel',
  'agentAuthSignOut',
  // Agent profile: a member's own instructions and skills, copied into their seats
  'agentProfileRead',
  'agentProfileApply',
  'agentProfileStatus',
  // Presence: who is here, what they are looking at, and whether they are typing
  'presenceSnapshot',
  'presenceSetFocus',
  'presenceSetComposing',
  'presenceSetEditing',

  // Host config — the tier that follows a user between clients
  'typeSafeKeySet',
  'configGet',
  'configUpdate',

  'textGenerationSettingsGet',
  'otelSettingsGet',
  'discoverServers',
  'getServerCapabilities',
  'setProjectsBaseDirectory',
  'setupInstallAgentCli',
  'setupCheckAgentAuth',
  'setupListGithubRepos',
  'setupPrepareProject',
  'setupCloneProject',
  'setupSyncProject',
  'setupAdoptProject',
  'setupCreateProject',
  'setupHostReadiness',
  'setupInstallGit',
  'setupInstallGh',
  'setupSetGitIdentity',
  'setupCheckSshAccess',
  'setupAuthorizeGhCli',
  'setupInstallGitCredentialHelper',

  // Host and provider updates: the host's own release check and its CLIs'
  'hostUpdateStatus',
  'hostCheckForUpdates',
  'hostInstallUpdate',
  'hostCancelUpdate',

  // Model list: the host's copy of the published model profiles
  'modelProfilesStatus',
  'modelProfilesRefresh',

  // Attention (server-side per-session needs-attention state; outlives clients)
  'listAttention',

  // Notifications hub: the caller's own notifications at this home (plans/015)
  'notificationsCapability',
  'notificationsList',
  'notificationsCount',
  'notificationsSetRead',
  'notificationsSetArchived',

  // Folio / works
  'duplicateWork',
  'linkWorkSession',
  'worksExport',
  'loadWorkAnnotations',
  'applyWorkComment',
  'markWorkCommentRead',
  'readWorkGoogleComments',
  'refreshWorkGoogleComments',
  'sendWorkGoogleComment',
  'readWorkExternalComments',
  'refreshWorkExternalComments',
  'sendWorkExternalComment',
  'agentSaveWork',
  'loadWorkRevisions',
  'loadWorkRevision',
  'restoreWorkRevision',
  'workReviewGet',
  'workReviewRequest',
  'workReviewRemove',
  'workReviewDecide',
  'workReviewInbox',
  'workReviewStates',
  'workLiveOpen',
  'workLivePush',
  'workLiveAwareness',
  'workLiveClose',
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
  'providerRepositories',

  // PR review mode (read PRs, enter review, comment, threads)
  'prList',
  'prListProjects',
  'prSetInterest',
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
  'prEnableAutoMerge',
  'prDisableAutoMerge',
  'prUpdateBranch',
  'prRevert',
  'prPrepareConflictResolution',
  'prRefresh',

  // Review guide (agent code-review ledger + guided walkthrough)
  'readLedger',
  'writeLedger',
  'getReviewContext',
  'generateGuide',
  'requestReviewGuide',
  'reviewGuideStatus',
  'sessionGuideStatuses',
  'prGuideStatuses',
  'cancelGenerateGuide',
  'readGuide',
  'readReviewState',
  'writeReviewState',

  // Review lens (one generated HTML artifact per review target)
  'readReviewLens',
  'prLensRevisions',
  'requestReviewLens',
  'editReviewLens',
  'cancelReviewLens',
  'restoreReviewLens',
  'updateReviewLensComments',
  'postReviewLensComment',
  'retractReviewLensComment',

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
  'tasksSidebarSnapshot',
  'tasksLogOpenTiming',
  'tasksSearchComments',
  'tasksReadExtras',
  'tasksMarkRead',
  'tasksSnooze',
  'tasksSnoozes',
  'tasksRecordActivity',
  'tasksComment',
  'tasksDeleteComment',
  'tasksPublishComments',
  'tasksLinkSession',
  'tasksUnlinkSession',
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

  // Watches (docs/plans/watches.md): list one session's watches and control them
  'watchList',
  'watchPause',
  'watchResume',
  'watchCancel',


  // PR checks cache + renderer activity hint
  'prChecks',

  // Subscription quota per agent provider
  'usageLimits',

  // Browser (viewing and driving a running UI at a chosen viewport)
  'browserRuntimeStatus',
  'browserRuntimeInstall',
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
  'browserRecordingStart',
  'browserRecordingStop',
  'browserEvidenceOptions',
  'browserOpenDevTools',
  'browserSetAnnotationTool',
  'browserAnnotationState',
  'browserAnnotate',
  'browserListProfiles',
  'browserCreateProfile',
  'browserRenameProfile',
  'browserDeleteProfile',
  'browserSetDefaultProfile',
  'browserListCookieSources',
  'browserRequestCookieAccess',
  'browserImportCookies',

  // Native devices (docs/plans/native-devices.md): simulators and emulators on this host or its SSH device hosts
  'deviceState',
  'deviceList',
  'deviceToolInspect',
  'deviceDetail',
  'deviceConfigure',
  'deviceHostSave',
  'deviceHostRemove',
  'deviceHostTest',
  'deviceToolUpdate',
  'deviceHostRetry',
  'deviceOpen',
  'deviceClose',
  'deviceShutdown',
  'deviceAction',
  'deviceStreamUrl',
  'deviceScreenshot',
  'deviceControlAcquire',
  'deviceControlRelease',
  'deviceControlResume',
  'deviceInstall',
  'deviceBuildImport',
  'deviceBuildDelete',
  'deviceProjectDetect',
  'deviceRunStart',
  'deviceRunCancel',
  'deviceRunLog',

  // Observability / Insights (metrics.db query engine)
  'metricsQuery',
  'metricsRunSql',
  'metricsTurnPage',
  'metricsTurnListingSummary',
  'metricsValidateSql',
  'metricsCompileNl',
  'metricsSchema',
  'metricsDistinctValues',
  'metricsListSavedQueries',
  'metricsSaveQuery',
  'metricsDeleteQuery',
  'metricsSessionSummary',
  'metricsTurnTrace',
  'metricsListTurnFlags',
  'metricsSetTurnFlag',
  'metricsClearTurnFlag',
  'logFilePath',
] as const

export type RpcInvokeMethod = (typeof RPC_INVOKE_METHODS)[number]
export type RpcMethod = RpcInvokeMethod

export interface RpcEnvelope {
  method: RpcMethod
  args: unknown[]
}
