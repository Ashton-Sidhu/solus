import { z } from 'zod'
import type { RpcMethod } from './rpc'
import type { ResourceRole, ShareResourceKind } from './sharing'

/**
 * Permissions (docs/plans/permissions.md, docs/plans/access-model.md §1). What a
 * person may do is named as a dotted path for the person, never for the wire:
 * `host.git.write`, `session.drive`. Two kinds:
 *
 * - a **permission** is held on the host as a whole and follows the host role.
 *   A held permission is a prefix: `host.git` covers `host.git.read`,
 *   `host.git.write`, and anything added under it later; `host` covers
 *   everything. Deny is absence. The host computes a connection's permissions
 *   once (`permissionsFor`) and sends them on the server info. Splitting a
 *   permission is one row here and one `may` call; every holder of the parent
 *   keeps it.
 * - a **resource action** is `<kind>.<verb>` on one resource (a session, work,
 *   task, automation, project, or notification), and follows the resource role
 *   `roleOf` gives (`ROLE_VERBS`). It is never held on the host.
 *
 * This file is the one registry: the server's gate and every client's controls
 * read the same tables, so a control is disabled exactly when the host refuses.
 */

/** Every dotted prefix of a path, the path itself included. */
type Prefixes<S extends string> = S extends `${infer Head}.${infer Tail}` ? Head | `${Head}.${Prefixes<Tail>}` : S

/** The ordinary use of the host: files, tasks, works, browser, devices, settings reads, and the rest. */
export const HOST_USE = 'host.use'

/**
 * The permission of every method that is not a resource method. The two tables
 * together name every method (`UNCLASSIFIED_METHODS` below fails the build
 * otherwise), so a new method is closed to everyone until its author writes
 * who may call it (docs/plans/custom-roles.md D4).
 */
const PERMISSION_OF_METHOD = {
  // Drives the window: a trusted local connection only.
  isVisible: 'host.local.window',
  getAppGlobalShortcuts: 'host.local.window',
  setAppGlobalShortcuts: 'host.local.window',
  restartApp: 'host.local.window',
  // Opens a window on the host's own screen.
  openInFileManager: 'host.local.window',
  // Acts on the host's own screen, disk, and clipboard: a native picker, a path on its disk,
  // a capture of its screen. No session role reaches them; a remote client uploads instead.
  attachFiles: 'host.local.window',
  attachFilePaths: 'host.local.window',
  takeScreenshot: 'host.local.window',
  pasteImage: 'host.local.window',
  // Changes how the host is reached: local only, and never on a managed host, where Solus cloud owns reach.
  connectionsSetRemoteAccess: 'host.local.reach',
  connectionsSetTrustLocalNetwork: 'host.local.reach',
  connectionsGeneratePairToken: 'host.local.reach',
  connectionsBootstrapDiscoveredServer: 'host.local.reach',
  uplinkRegister: 'host.local.reach',
  uplinkLink: 'host.local.reach',
  uplinkUnlink: 'host.local.reach',
  uplinkDetachOrganization: 'host.local.reach',
  // Administers the machine: credentials, updates, host config.
  connectionsRevokeDevice: 'host.admin',
  // Introductions give one host a token for another: a local owner's, never on a managed host (host-reach.md §4).
  hostIntroductionsList: 'host.local.reach',
  hostIntroductionIssue: 'host.local.reach',
  hostIntroductionAccept: 'host.local.reach',
  hostIntroductionForget: 'host.local.reach',
  hostIntroductionAllow: 'host.local.reach',
  configUpdate: 'host.admin',
  setProjectsBaseDirectory: 'host.admin',
  deleteProject: 'host.admin',
  hostCheckForUpdates: 'host.admin',
  hostInstallUpdate: 'host.admin',
  hostCancelUpdate: 'host.admin',
  modelProfilesRefresh: 'host.admin',
  setupInstallAgentCli: 'host.admin',
  setupInstallGit: 'host.admin',
  setupInstallGh: 'host.admin',
  setupSetGitIdentity: 'host.admin',
  setupAuthorizeGhCli: 'host.admin',
  setupInstallGitCredentialHelper: 'host.admin',
  seatRemove: 'host.admin',
  agentProfileRead: 'host.admin',
  githubExportCredential: 'host.admin',
  codeIntelInstall: 'host.admin',
  browserRuntimeInstall: 'host.admin',
  browserRequestCookieAccess: 'host.admin',
  browserImportCookies: 'host.admin',
  hostSetInsightsOptIn: 'host.admin',
  // Arbitrary SQL cannot be held to the caller's own turns, so it reads every turn: an administrator's (access-model.md §4 D2).
  metricsRunSql: 'host.admin',
  deviceConfigure: 'host.admin',
  deviceHostSave: 'host.admin',
  deviceHostRemove: 'host.admin',
  deviceHostTest: 'host.admin',
  deviceToolUpdate: 'host.admin',
  deviceHostRetry: 'host.admin',
  // The machine's one GitHub, Google, Atlassian, or TypeSafe credential on a host; each
  // person's own row on the workspace service, where every member holds this leaf.
  typeSafeKeySet: 'host.admin.connections',
  googleConnect: 'host.admin.connections',
  googleDisconnect: 'host.admin.connections',
  atlassianStartOAuth: 'host.admin.connections',
  atlassianCancelOAuth: 'host.admin.connections',
  atlassianDisconnect: 'host.admin.connections',
  providerConnect: 'host.admin.connections',
  providerCancelConnect: 'host.admin.connections',
  providerDisconnect: 'host.admin.connections',
  // A report from a runner: the host itself, never a person.
  sessionRecordUpsert: 'host.system',
  // What a client needs to boot and keep its socket; nothing about the host leaks through them.
  connectionsGetServerInfo: 'host.connect',
  authRenew: 'host.connect',
  accountPresent: 'host.connect',
  // A `/v1` request over the socket: each operation checks its own scope and access, as over HTTP.
  solusApiRequest: 'host.connect',
  serverGetCapabilities: 'host.connect',
  activityLease: 'host.connect',
  listAttention: 'host.connect',
  presenceSnapshot: 'host.connect',
  presenceSetFocus: 'host.connect',
  // What the composer offers: the agents here and the models they run.
  start: 'host.agents.read',
  modelProfilesStatus: 'host.models.read',
  // The card shows the statuses of sessions the caller can list.
  liveActivityRegister: 'host.sessions.read',
  liveActivityUnregister: 'host.sessions.read',
  pinnedSessionsList: 'host.sessions.read',
  tasksSidebarSnapshot: 'host.sessions.read',
  tasksSnoozes: 'host.sessions.read',
  createHeadlessSession: 'host.sessions.start',
  listProjects: 'host.projects.read',
  listRecentProjects: 'host.projects.read',
  // Git: reading a checkout, and changing one.
  gitRefreshState: 'host.git.read',
  gitIdentity: 'host.git.read',
  gitRepositoryStatus: 'host.git.read',
  checkoutSnapshot: 'host.git.read',
  worktreeListProject: 'host.git.read',
  worktreeBranches: 'host.git.read',
  gitRunAction: 'host.git.write',
  gitDiscard: 'host.git.write',
  gitSync: 'host.git.write',
  gitCheckoutBranch: 'host.git.write',
  worktreeRestore: 'host.git.write',
  gitRegisterEnvironment: 'host.git.write',
  gitInitRepository: 'host.git.write',
  githubPublishRepository: 'host.git.write',
  // A change to a pull request is a repository write. When the pull request is
  // part of sessions, the handler also asks for session.edit on one of them
  // (access-model.md §2.3; `writePullRequest`).
  prUpdate: 'host.git.write',
  prRequestReviewers: 'host.git.write',
  prRemoveRequestedReviewer: 'host.git.write',
  prSetLabels: 'host.git.write',
  prUpdateLifecycle: 'host.git.write',
  prSubmitReview: 'host.git.write',
  prAddIssueComment: 'host.git.write',
  prDeleteIssueComment: 'host.git.write',
  prReplyThread: 'host.git.write',
  prResolveThread: 'host.git.write',
  prUnresolveThread: 'host.git.write',
  prMerge: 'host.git.write',
  prEnableAutoMerge: 'host.git.write',
  prDisableAutoMerge: 'host.git.write',
  prUpdateBranch: 'host.git.write',
  prRevert: 'host.git.write',
  prMergeStack: 'host.git.write',
  prApproveWorkflowRuns: 'host.git.write',
  openWorktreeTerminal: 'host.terminal',
  usageLimits: 'host.usage.read',
  // Project files: reading a checkout's files, and changing them.
  searchFiles: 'host.files.read',
  searchProjectContents: 'host.files.read',
  listDirectory: 'host.files.read',
  readProjectFile: 'host.files.read',
  listProjectFiles: 'host.files.read',
  createDirectory: 'host.files.write',
  mutateHostPath: 'host.files.write',
  mutateProjectFile: 'host.files.write',
  writeFile: 'host.files.write',
  updateAgentFiles: 'host.files.write',
  // The ordinary use of the host: everything a person on it may do and a guest may not.
  // Written out, not a default, so a new method names its action before it compiles.
  saveFileDialog: HOST_USE, openExternal: HOST_USE, openInTerminal: HOST_USE, resolveTerminal: HOST_USE,
  assetUpload: HOST_USE, assetCreateUrl: HOST_USE, assetFindUrl: HOST_USE, transcribeAudio: HOST_USE,
  warmTranscription: HOST_USE, voiceModelStatus: HOST_USE, voiceModelRetry: HOST_USE,
  logVoiceTranscription: HOST_USE, codeIntelSymbolAt: HOST_USE, codeIntelReferences: HOST_USE,
  codeIntelDocs: HOST_USE, codeIntelStatus: HOST_USE, codeIntelReindex: HOST_USE, workspaceProjectList: HOST_USE,
  workspaceProjectAdd: HOST_USE, generateSessionMetadata: HOST_USE, trackRecentProject: HOST_USE,
  listPlans: HOST_USE, detectEditors: HOST_USE, openInEditor: HOST_USE, getPluginCommands: HOST_USE,
  continueInWorktree: HOST_USE, decideWorktreeOffer: HOST_USE, projectConfigLoad: HOST_USE,
  projectConfigSave: HOST_USE, listProjectIdentities: HOST_USE, resolveDispatchHistoryRoots: HOST_USE,
  untrackProject: HOST_USE, skillsSearch: HOST_USE, skillsInstall: HOST_USE, skillsList: HOST_USE,
  skillsRemove: HOST_USE, connectionsListEndpoints: HOST_USE, connectionsListSessions: HOST_USE,
  uplinkStatus: HOST_USE, hostOrganizations: HOST_USE, workUpload: HOST_USE, taskUpload: HOST_USE,
  shareLinkOrigin: HOST_USE, seatList: HOST_USE, seatConnectStart: HOST_USE, seatConnectSubmitCode: HOST_USE,
  seatConnectCancel: HOST_USE, seatConnectToken: HOST_USE, seatDisconnect: HOST_USE, agentAuthStart: HOST_USE,
  agentAuthSubmit: HOST_USE, agentAuthCancel: HOST_USE, agentAuthSignOut: HOST_USE, integrationCatalogList: HOST_USE,
  integrationProbe: HOST_USE, integrationList: HOST_USE, integrationGet: HOST_USE, integrationCreate: HOST_USE,
  integrationUpdate: HOST_USE, integrationRemove: HOST_USE, integrationTools: HOST_USE,
  integrationConnectionList: HOST_USE, integrationConnectStart: HOST_USE, integrationConnectSubmit: HOST_USE,
  integrationConnectCancel: HOST_USE, integrationDisconnect: HOST_USE, agentProfileApply: HOST_USE,
  agentProfilePull: HOST_USE, agentProfileStatus: HOST_USE, typeSafeKeyStatus: HOST_USE, configGet: HOST_USE,
  textGenerationSettingsGet: HOST_USE, otelSettingsGet: HOST_USE, discoverServers: HOST_USE,
  setupCheckAgentAuth: HOST_USE, setupListGithubRepos: HOST_USE, setupPrepareProject: HOST_USE,
  setupCloneProject: HOST_USE, setupSyncProject: HOST_USE, setupAdoptProject: HOST_USE, setupCreateProject: HOST_USE,
  setupHostReadiness: HOST_USE, setupCheckSshAccess: HOST_USE, hostUpdateStatus: HOST_USE,
  notificationsCapability: HOST_USE, notificationsList: HOST_USE, notificationsCount: HOST_USE,
  workReviewInbox: HOST_USE, workReviewStates: HOST_USE, docProviderStatuses: HOST_USE, docDestinations: HOST_USE,
  importDocFromUrl: HOST_USE, googleStatus: HOST_USE, atlassianStatus: HOST_USE, atlassianJiraProjects: HOST_USE,
  providerStatus: HOST_USE, providerViewer: HOST_USE, providerRepositories: HOST_USE, prList: HOST_USE,
  prListProjects: HOST_USE, prSetInterest: HOST_USE, prGuideMetadata: HOST_USE, prOpenReview: HOST_USE,
  prGetDiff: HOST_USE, prGetDiffFileContents: HOST_USE, prPrepareCheckout: HOST_USE, prGetDetail: HOST_USE,
  prGetOverview: HOST_USE, prChangedFiles: HOST_USE, prListThreads: HOST_USE, prListComments: HOST_USE,
  prListCommits: HOST_USE, prGetStack: HOST_USE, prListReviewers: HOST_USE, prListReviewerCandidates: HOST_USE,
  prListLabelCandidates: HOST_USE, prInterdiff: HOST_USE, prGenerateGuides: HOST_USE, prMediaUrl: HOST_USE,
  prPendingWorkflowRuns: HOST_USE, prViewedFiles: HOST_USE, prSetFilesViewed: HOST_USE,
  prPrepareConflictResolution: HOST_USE, prRefresh: HOST_USE, getReviewContext: HOST_USE, generateGuide: HOST_USE,
  requestReviewGuide: HOST_USE, reviewGuideStatus: HOST_USE, sessionGuideStatuses: HOST_USE,
  prGuideStatuses: HOST_USE, cancelGenerateGuide: HOST_USE, readGuide: HOST_USE, readReviewState: HOST_USE,
  writeReviewState: HOST_USE, readReviewLens: HOST_USE, prLensRevisions: HOST_USE, requestReviewLens: HOST_USE,
  editReviewLens: HOST_USE, cancelReviewLens: HOST_USE, restoreReviewLens: HOST_USE,
  updateReviewLensComments: HOST_USE, postReviewLensComment: HOST_USE, retractReviewLensComment: HOST_USE,
  tasksProviderStatus: HOST_USE, inboxListUpstream: HOST_USE, tasksListUpstream: HOST_USE,
  tasksGetUpstream: HOST_USE, tasksUpdateUpstream: HOST_USE, tasksCommentUpstream: HOST_USE,
  tasksListAssigneeCandidates: HOST_USE, tasksListCandidates: HOST_USE, tasksImport: HOST_USE,
  tasksSearchComments: HOST_USE, tasksPrepareForSession: HOST_USE, tasksLinkedTo: HOST_USE, outboxList: HOST_USE,
  outboxAck: HOST_USE, outboxApply: HOST_USE, automationCreate: HOST_USE, automationList: HOST_USE,
  automationRecentRuns: HOST_USE, prChecks: HOST_USE, browserRuntimeStatus: HOST_USE, browserListTargets: HOST_USE,
  browserListPages: HOST_USE, browserOpen: HOST_USE, browserClose: HOST_USE, browserNavigate: HOST_USE,
  browserSetViewport: HOST_USE, browserSetAppearance: HOST_USE, browserSnapshot: HOST_USE, browserInteract: HOST_USE,
  browserAttachSurface: HOST_USE, browserDetachSurface: HOST_USE, browserReportSurface: HOST_USE,
  browserClearProfile: HOST_USE, browserSubscribeFrames: HOST_USE, browserUnsubscribeFrames: HOST_USE,
  browserSetFrameCaps: HOST_USE, browserCaptureEvidence: HOST_USE, browserRecordingStart: HOST_USE,
  browserRecordingStop: HOST_USE, browserEvidenceOptions: HOST_USE, browserOpenDevTools: HOST_USE,
  browserSetAnnotationTool: HOST_USE, browserAnnotationState: HOST_USE, browserAnnotate: HOST_USE,
  browserListProfiles: HOST_USE, browserCreateProfile: HOST_USE, browserRenameProfile: HOST_USE,
  browserDeleteProfile: HOST_USE, browserSetDefaultProfile: HOST_USE, browserListCookieSources: HOST_USE,
  deviceState: HOST_USE, deviceList: HOST_USE, deviceToolInspect: HOST_USE, deviceDetail: HOST_USE,
  devicePair: HOST_USE, deviceShutdown: HOST_USE, deviceAction: HOST_USE, deviceStreamUrl: HOST_USE,
  deviceScreenshot: HOST_USE, deviceControlAcquire: HOST_USE, deviceControlRelease: HOST_USE,
  deviceControlResume: HOST_USE, deviceInstall: HOST_USE, deviceBuildRemove: HOST_USE, deviceProjectDetect: HOST_USE,
  deviceSigningTeams: HOST_USE, deviceRunStart: HOST_USE, deviceRunCancel: HOST_USE, deviceRunLog: HOST_USE,
  metricsQuery: HOST_USE, metricsTurnPage: HOST_USE, metricsTurnListingSummary: HOST_USE,
  metricsValidateSql: HOST_USE, metricsCompileNl: HOST_USE, metricsSchema: HOST_USE, metricsDistinctValues: HOST_USE,
  metricsListSavedQueries: HOST_USE, metricsSaveQuery: HOST_USE, metricsDeleteQuery: HOST_USE,
  metricsTurnTrace: HOST_USE, metricsListTurnFlags: HOST_USE, metricsSetTurnFlag: HOST_USE,
  metricsClearTurnFlag: HOST_USE, logFilePath: HOST_USE,
} as const satisfies Partial<Record<RpcMethod, string>>

type PermissionLeaf = (typeof PERMISSION_OF_METHOD)[keyof typeof PERMISSION_OF_METHOD]
/** A permission leaf or any prefix of one: what a connection may hold, and what a control may ask for. */
export type Permission = Prefixes<PermissionLeaf>

/** Every kind of resource (docs/plans/access-model.md §1). An insight is one turn and its spans in Insights; a browserProfile is one person's cookie jar in a project (member-isolation.md §6). */
export type ResourceKind = ShareResourceKind | 'integration' | 'notification' | 'automation' | 'project' | 'insight' | 'browserProfile'

/**
 * A resource a control acts on: its kind and id, and the reader's standing on it
 * when the host sent one (§2.7). `actions` is there only for a custom role.
 */
export interface ResourceRef {
  kind: ResourceKind
  id: string
  role?: ResourceRole
  actions?: readonly SessionActionLeaf[]
}

/** The resource verbs, lowest first; a preset role holds a set of them on every kind. */
export const RESOURCE_VERBS = ['read', 'comment', 'drive', 'edit', 'share', 'own'] as const
export type ResourceVerb = (typeof RESOURCE_VERBS)[number]

/**
 * The leaves under a session's `read` and `drive` (docs/plans/custom-roles.md §3).
 * Every session method names a leaf, never its parent, so a preset that holds the
 * parent covers each leaf, including one added later, and a custom role holds only
 * the leaves it lists. Add a leaf here and point its methods at it.
 */
export const SESSION_ACTION_LEAVES = [
  'read.transcript', 'read.diffs', 'read.files',
  'drive.propose', 'drive.prompt', 'drive.attach', 'drive.approve', 'drive.devices', 'drive.apps',
] as const
export type SessionActionLeaf = (typeof SESSION_ACTION_LEAVES)[number]
export const sessionActionLeafSchema = z.enum(SESSION_ACTION_LEAVES)

/** What one resource method needs: a verb, or a session leaf under one. */
export type ResourceActionPath = ResourceVerb | SessionActionLeaf
export type ResourceAction = `${ResourceKind}.${ResourceActionPath}`

/** A role with a name: what it holds is written here, not on the entry. */
export type PresetRole = Exclude<ResourceRole, 'custom'>

/**
 * What each preset role holds on a resource. A commenter comments on a work; on a
 * session or a task the verb never applies, so a commenter there is a viewer.
 * `drive` is a session's turns and cards; `edit` is its record (title, links,
 * goal, plans) or a work's or task's body; `share` is the share list; `own` is
 * transfer and taking the record off its host. A custom role holds the leaves its
 * entry lists instead.
 */
export const ROLE_VERBS = {
  none: [],
  viewer: ['read'],
  commenter: ['read', 'comment'],
  editor: ['read', 'comment', 'drive', 'edit', 'share'],
  owner: ['read', 'comment', 'drive', 'edit', 'share', 'own'],
} as const satisfies Record<PresetRole, readonly ResourceVerb[]>

/**
 * A principal's standing on one resource: the highest preset role its entries
 * give (or `custom` when only custom entries name it), and the leaves those
 * custom entries list.
 */
export interface ResourceStanding {
  role: ResourceRole
  actions?: readonly SessionActionLeaf[]
}

/** Whether a standing allows one action on its resource. */
export function standingAllows(standing: ResourceStanding, action: ResourceActionPath): boolean {
  const verbs: readonly string[] = standing.role === 'custom' ? [] : ROLE_VERBS[standing.role]
  return permissionsAllow(verbs, action) || permissionsAllow(standing.actions ?? [], action)
}

export function roleAllows(role: PresetRole, action: ResourceActionPath): boolean {
  return standingAllows({ role }, action)
}

/**
 * Whether the standing a resource carries allows `action` (docs/plans/access-model.md
 * §2.7). A resource the host sent no role on is the reader's own until the host
 * refuses, so an owner's controls never flicker off.
 */
export function resourceAllows(resource: Partial<ResourceStanding>, action: ResourceActionPath): boolean {
  return resource.role === undefined || standingAllows({ role: resource.role, actions: resource.actions }, action)
}

export function isResourceActionPath(value: string): value is ResourceActionPath {
  const paths: readonly string[] = [...RESOURCE_VERBS, ...SESSION_ACTION_LEAVES]
  return paths.includes(value)
}

/** The action each resource method needs; the server pairs it with where the resource id sits in the call. */
export const RESOURCE_ACTION_OF_METHOD = {
  // Sessions — reading: the transcript, its cards and plans; every custom role holds it
  watchSession: 'read.transcript', unwatchSession: 'read.transcript', bindRuntimeSession: 'read.transcript',
  loadSession: 'read.transcript', loadSessionPage: 'read.transcript', loadSessionSubagent: 'read.transcript',
  loadSessionToolInputs: 'read.transcript', loadSessionPreview: 'read.transcript', loadSessionMessageWindow: 'read.transcript',
  getSessionInfo: 'read.transcript', getSessionInfos: 'read.transcript', describeSession: 'read.transcript', mcpAppRead: 'read.transcript',
  loadPlanContent: 'read.transcript', loadPlanAnnotations: 'read.transcript', getThreadGoal: 'read.transcript',
  tasksForSession: 'read.transcript', metricsSessionSummary: 'read.transcript', setSessionReadState: 'read.transcript',
  togglePinnedSession: 'read.transcript', sessionSuggestions: 'read.transcript',
  // Sessions — reading the changes the agent made
  listTurnSnapshots: 'read.diffs', diff: 'read.diffs', diffFileContents: 'read.diffs', diffStats: 'read.diffs',
  // Sessions — driving: turns, the queue, typing, and sending or dismissing a suggestion
  prompt: 'drive.prompt', compactSession: 'drive.prompt', retry: 'drive.prompt', promptHeadlessSession: 'drive.prompt',
  stopSession: 'drive.prompt', stopBackgroundTasks: 'drive.prompt', resetSession: 'drive.prompt', switchSessionAgent: 'drive.prompt',
  cancelQueuedPrompt: 'drive.prompt', editQueuedPrompt: 'drive.prompt', sessionQueue: 'drive.prompt', sessionQueueChange: 'drive.prompt',
  presenceSetComposing: 'drive.prompt', writePlanFile: 'drive.prompt', sessionSuggestionDecide: 'drive.prompt',
  // Sessions — a suggestion a person who may prompt sends or dismisses
  sessionSuggest: 'drive.propose', sessionSuggestionWithdraw: 'drive.propose',
  // Sessions — the agent's cards: what it may run, its questions, its plan, a rate limit
  respondPermission: 'drive.approve', respondQuestion: 'drive.approve', decideSessionPlan: 'drive.approve',
  acceptPlan: 'drive.approve', rateLimitDecision: 'drive.approve',
  attachUpload: 'drive.attach', attachUploadToken: 'drive.attach',
  deviceOpen: 'drive.devices', deviceClose: 'drive.devices',
  mcpAppToolInfo: 'drive.apps', mcpAppCallTool: 'drive.apps', mcpAppReadResource: 'drive.apps',
  // Sessions — editing the record
  setSessionTitle: 'edit', ensureBackgroundSessionTitle: 'edit', setSessionBranch: 'edit',
  sessionPullRequestWatch: 'edit',
  setThreadGoal: 'edit', clearThreadGoal: 'edit', savePlanAnnotations: 'edit', toggleBookmarkPlan: 'edit', publishPlan: 'edit',
  pullPlanUpstream: 'edit', refreshPlanUpstream: 'edit', unlinkPlanUpstream: 'edit', tasksLinkSession: 'edit', tasksUnlinkSession: 'edit',
  // Works — reading
  loadWorkRevisions: 'read', loadWorkRevision: 'read', workReviewGet: 'read', workLiveOpen: 'read', workLiveAwareness: 'read',
  workLiveClose: 'read', loadWorkAnnotations: 'read', markWorkCommentRead: 'read', readWorkGoogleComments: 'read',
  readWorkExternalComments: 'read', duplicateWork: 'read', worksExport: 'read',
  // The share list of a session or a work: a session's base read covers a work's read
  shareGet: 'read.transcript',
  // Works — commenting and reviewing
  applyWorkComment: 'comment', workReviewDecide: 'comment',
  // Works — editing
  agentSaveWork: 'edit', restoreWorkRevision: 'edit', workReviewRequest: 'edit', workReviewRemove: 'edit', workLivePush: 'edit',
  presenceSetEditing: 'edit', setWorkPinned: 'edit', linkWorkSession: 'edit', refreshWorkGoogleComments: 'edit',
  sendWorkGoogleComment: 'edit', refreshWorkExternalComments: 'edit', sendWorkExternalComment: 'edit', publishWork: 'edit',
  pullWorkUpstream: 'edit', refreshWorkUpstream: 'edit', unlinkWorkUpstream: 'edit',
  // The share list
  shareSet: 'share', shareSetLink: 'share',
  // Tasks
  tasksReadExtras: 'read', tasksSessions: 'read', tasksSnapshot: 'read', tasksMarkRead: 'read', tasksSnooze: 'read',
  tasksRecordActivity: 'read', tasksComment: 'edit', tasksDeleteComment: 'edit', tasksPublishComments: 'edit', tasksPublish: 'edit',
  tasksSyncNow: 'edit', tasksLink: 'edit', tasksUnlink: 'edit', tasksAttachArtifact: 'edit',
  // Owner only: transfer, and taking the record off its host (docs/plans/cloud-sharing.md)
  shareTransfer: 'own', workExportForCloud: 'own', workMarkMoved: 'own', taskExportForCloud: 'own', taskMarkMoved: 'own',
  // Automations (access-model.md §4 D4): the owner, or an administrator as an editor, reads,
  // changes, runs, and deletes one. Listing and creating are host-wide; a list is filtered.
  automationRead: 'read', automationListRuns: 'read', automationReadRun: 'read',
  automationUpdate: 'edit', automationSetEnabled: 'edit', automationDelete: 'edit',
  automationRun: 'drive', automationCancel: 'drive',
  // Projects: every member lists the organization's projects; changing one is its owner's or an administrator's.
  workspaceProjectUpdate: 'edit', workspaceProjectRemove: 'edit',
  // Notifications are personal: only their recipient, the owner, marks one.
  notificationsSetRead: 'edit', notificationsSetArchived: 'edit',
} as const satisfies Partial<Record<RpcMethod, ResourceActionPath>>

export type ResourceMethod = keyof typeof RESOURCE_ACTION_OF_METHOD

/**
 * The methods neither table names. It must be empty: the line below fails the
 * build and lists each one, so a method is never open by omission.
 */
type UnclassifiedMethod = Exclude<RpcMethod, ResourceMethod | keyof typeof PERMISSION_OF_METHOD>
const EVERY_METHOD_CLASSIFIED: [UnclassifiedMethod] extends [never] ? true : UnclassifiedMethod = true
void EVERY_METHOD_CLASSIFIED

export function isResourceMethod(method: RpcMethod): method is ResourceMethod {
  return method in RESOURCE_ACTION_OF_METHOD
}

const PERMISSION_BY_METHOD: ReadonlyMap<string, Permission> = new Map(Object.entries(PERMISSION_OF_METHOD))

/** The permission a method needs; a resource method has none, it has an action. */
export function permissionOf(method: RpcMethod): Permission | null {
  if (isResourceMethod(method)) return null
  const permission = PERMISSION_BY_METHOD.get(method)
  if (!permission) throw new Error(`"${method}" names no action`)
  return permission
}

export function resourceActionPathOf(method: ResourceMethod): ResourceActionPath {
  return RESOURCE_ACTION_OF_METHOD[method]
}

export function resourceActionOf(resource: Pick<ResourceRef, 'kind'>, action: ResourceActionPath): ResourceAction {
  return `${resource.kind}.${action}`
}

/**
 * Whether held paths reach one: it or any of its prefixes is held. The one prefix
 * rule, for host permissions and for resource actions alike.
 */
export function permissionsAllow(held: readonly string[], permission: string): boolean {
  for (const prefix of held) {
    if (permission === prefix || permission.startsWith(`${prefix}.`)) return true
  }
  return false
}

/** The owner's permissions: `['host']` covers every permission. */
export const EVERY_PERMISSION: readonly Permission[] = ['host']
