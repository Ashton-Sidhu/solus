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

/**
 * The permission leaves: each method not listed here needs `host.use`, the
 * ordinary use of the host's catalog and tools. A method is listed only when a
 * principal must be able to hold it apart from `host.use`.
 */
const PERMISSION_OF_METHOD = {
  // Drives the window: a trusted local connection only.
  isVisible: 'host.local.window',
  getAppGlobalShortcuts: 'host.local.window',
  setAppGlobalShortcuts: 'host.local.window',
  restartApp: 'host.local.window',
  // Opens a window on the host's own screen.
  openInFileManager: 'host.local.window',
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
} as const satisfies Partial<Record<RpcMethod, string>>

/** The ordinary use of the host: files, tasks, works, browser, devices, settings reads, and the rest. */
export const HOST_USE = 'host.use'

type PermissionLeaf = (typeof PERMISSION_OF_METHOD)[keyof typeof PERMISSION_OF_METHOD] | typeof HOST_USE
/** A permission leaf or any prefix of one: what a connection may hold, and what a control may ask for. */
export type Permission = Prefixes<PermissionLeaf>

/** Every kind of resource (docs/plans/access-model.md §1). An insight is one turn and its spans in Insights; a browserProfile is one person's cookie jar in a project (member-isolation.md §6). */
export type ResourceKind = ShareResourceKind | 'integration' | 'notification' | 'automation' | 'project' | 'insight' | 'browserProfile'

/** A resource a control acts on: its kind and id, and the reader's role on it when the host sent one (§2.7). */
export interface ResourceRef {
  kind: ResourceKind
  id: string
  role?: ResourceRole
}

/** The resource verbs, lowest first; a role holds a set of them on every kind. */
export const RESOURCE_VERBS = ['read', 'comment', 'drive', 'edit', 'share', 'own'] as const
export type ResourceVerb = (typeof RESOURCE_VERBS)[number]
export type ResourceAction = `${ResourceKind}.${ResourceVerb}`

/**
 * What each share role holds on a resource. A commenter comments on a work; on a
 * session or a task the verb never applies, so a commenter there is a viewer.
 * `drive` is a session's turns and cards; `edit` is its record (title, links,
 * goal, plans) or a work's or task's body; `share` is the share list; `own` is
 * transfer and taking the record off its host.
 */
export const ROLE_VERBS = {
  none: [],
  viewer: ['read'],
  commenter: ['read', 'comment'],
  editor: ['read', 'comment', 'drive', 'edit', 'share'],
  owner: ['read', 'comment', 'drive', 'edit', 'share', 'own'],
} as const satisfies Record<ResourceRole, readonly ResourceVerb[]>

export function roleAllows(role: ResourceRole, verb: ResourceVerb): boolean {
  const verbs: readonly ResourceVerb[] = ROLE_VERBS[role]
  return verbs.includes(verb)
}

/**
 * Whether the role a resource carries allows `verb` (docs/plans/access-model.md
 * §2.7). A resource the host sent no role on is the reader's own until the host
 * refuses, so an owner's controls never flicker off.
 */
export function resourceAllows(resource: Pick<ResourceRef, 'role'>, verb: ResourceVerb): boolean {
  return resource.role === undefined || roleAllows(resource.role, verb)
}

export function isResourceVerb(value: string): value is ResourceVerb {
  const verbs: readonly string[] = RESOURCE_VERBS
  return verbs.includes(value)
}

/** The verb each resource method needs; the server pairs it with where the resource id sits in the call. */
export const RESOURCE_VERB_OF_METHOD = {
  // Sessions — reading
  watchSession: 'read', unwatchSession: 'read', bindRuntimeSession: 'read', loadSession: 'read', loadSessionPage: 'read',
  loadSessionSubagent: 'read', loadSessionToolInputs: 'read', loadSessionPreview: 'read', loadSessionMessageWindow: 'read', getSessionInfo: 'read',
  mcpAppRead: 'read', mcpAppToolInfo: 'drive', mcpAppCallTool: 'drive', mcpAppReadResource: 'drive',
  getSessionInfos: 'read', describeSession: 'read', loadPlanContent: 'read', loadPlanAnnotations: 'read', getThreadGoal: 'read',
  listTurnSnapshots: 'read', diff: 'read', diffFileContents: 'read', diffStats: 'read', tasksForSession: 'read',
  metricsSessionSummary: 'read', setSessionReadState: 'read', togglePinnedSession: 'read',
  // Sessions — driving: turns, cards, the queue, attachments, typing
  prompt: 'drive', compactSession: 'drive', retry: 'drive', decideSessionPlan: 'drive', promptHeadlessSession: 'drive',
  stopSession: 'drive', stopBackgroundTasks: 'drive', resetSession: 'drive', acceptPlan: 'drive', switchSessionAgent: 'drive',
  respondPermission: 'drive', respondQuestion: 'drive', rateLimitDecision: 'drive', cancelQueuedPrompt: 'drive',
  editQueuedPrompt: 'drive', sessionQueue: 'drive', sessionQueueChange: 'drive', presenceSetComposing: 'drive',
  writePlanFile: 'drive', attachFiles: 'drive', attachFilePaths: 'drive', attachUpload: 'drive', attachUploadToken: 'drive',
  takeScreenshot: 'drive', pasteImage: 'drive',
  deviceOpen: 'drive', deviceClose: 'drive',
  // Sessions — editing the record
  setSessionTitle: 'edit', ensureBackgroundSessionTitle: 'edit', setSessionBranch: 'edit',
  sessionPullRequestWatch: 'edit',
  setThreadGoal: 'edit', clearThreadGoal: 'edit', savePlanAnnotations: 'edit', toggleBookmarkPlan: 'edit', publishPlan: 'edit',
  pullPlanUpstream: 'edit', refreshPlanUpstream: 'edit', unlinkPlanUpstream: 'edit', tasksLinkSession: 'edit', tasksUnlinkSession: 'edit',
  // Works — reading
  loadWorkRevisions: 'read', loadWorkRevision: 'read', workReviewGet: 'read', workLiveOpen: 'read', workLiveAwareness: 'read',
  workLiveClose: 'read', loadWorkAnnotations: 'read', markWorkCommentRead: 'read', readWorkGoogleComments: 'read',
  readWorkExternalComments: 'read', duplicateWork: 'read', worksExport: 'read', shareGet: 'read',
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
} as const satisfies Partial<Record<RpcMethod, ResourceVerb>>

export type ResourceMethod = keyof typeof RESOURCE_VERB_OF_METHOD

export function isResourceMethod(method: RpcMethod): method is ResourceMethod {
  return method in RESOURCE_VERB_OF_METHOD
}

const PERMISSION_BY_METHOD: ReadonlyMap<string, Permission> = new Map(Object.entries(PERMISSION_OF_METHOD))

/** The permission a method needs; a resource method has none, it has a verb. */
export function permissionOf(method: RpcMethod): Permission | null {
  if (isResourceMethod(method)) return null
  return PERMISSION_BY_METHOD.get(method) ?? HOST_USE
}

export function resourceVerbOf(method: ResourceMethod): ResourceVerb {
  return RESOURCE_VERB_OF_METHOD[method]
}

export function resourceActionOf(resource: Pick<ResourceRef, 'kind'>, verb: ResourceVerb): ResourceAction {
  return `${resource.kind}.${verb}`
}

/** Whether held permissions reach one: it or any of its prefixes is held. */
export function permissionsAllow(held: readonly string[], permission: string): boolean {
  for (const prefix of held) {
    if (permission === prefix || permission.startsWith(`${prefix}.`)) return true
  }
  return false
}

/** The owner's permissions: `['host']` covers every permission. */
export const EVERY_PERMISSION: readonly Permission[] = ['host']
