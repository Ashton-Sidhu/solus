import { z } from 'zod'
import type { RpcMethod } from '@solus/contracts/rpc'
import {
  HOST_USE,
  permissionsAllow,
  permissionOf,
  isResourceMethod,
  isResourceVerb,
  resourceVerbOf,
  roleAllows,
  type Permission,
  type ResourceKind,
  type ResourceMethod,
  type ResourceVerb,
} from '@solus/contracts/permissions'
import { shareResourceSchema, type ResourceRole } from '@solus/contracts/sharing'
import { hostCategory } from '../host/host-category'
import { isApiMode } from '../host/api-mode'
import { isHostAdmin, isHostOwner, type Principal, type PrincipalKind } from './principal'
import type { AccessResource } from './access'

/**
 * The access gate of one host (docs/plans/permissions.md). Every method needs one
 * action, declared once in the contracts: a permission, held on the whole host,
 * or a resource verb, held through the resource role `roleOf` gives on the
 * resource the call names. `permissionsFor` is the one place a host role's
 * permissions are written; `RESOURCE_LOCATORS` is the one place the server says
 * where a resource id sits in a call; `authorize` is the one decision, which the
 * RPC gate and the Solus API both call. Nothing else decides access.
 */

type ArgLocator = (args: readonly unknown[]) => AccessResource | null

// Call arguments are wire input: each locator parses only the id it needs.
const idSchema = z.string().min(1)
const ipcContextSchema = z.object({ session: z.object({ sessionId: z.string() }) })
const fieldSchema = (field: string) => z.object({ [field]: idSchema })

const ctxAt = (index: number): ArgLocator => (args) => {
  const ctx = ipcContextSchema.safeParse(args[index])
  return ctx.success && ctx.data.session.sessionId ? { kind: 'session', id: ctx.data.session.sessionId } : null
}
/** Attachments for a draft that has no session yet name nothing; the call is host-wide for members. */
const optionalCtxAt = (index: number): ArgLocator => (args) => (args[index] ? ctxAt(index)(args) : null)
const sessionIdAt = (index: number): ArgLocator => (args) => {
  const id = idSchema.safeParse(args[index])
  return id.success ? { kind: 'session', id: id.data } : null
}
/** A batch read names one session when it asks for exactly one; asking for several is a catalog read. */
const singleSessionIdAt = (index: number): ArgLocator => (args) => {
  const ids = z.array(idSchema).length(1).safeParse(args[index])
  return ids.success ? { kind: 'session', id: ids.data[0]! } : null
}
const workIdAt = (index: number): ArgLocator => (args) => {
  const id = idSchema.safeParse(args[index])
  return id.success ? { kind: 'work', id: id.data } : null
}
const sessionFieldAt = (index: number, field: string): ArgLocator => (args) => {
  const request = fieldSchema(field).safeParse(args[index])
  return request.success ? { kind: 'session', id: request.data[field] } : null
}
const workFieldAt = (index: number): ArgLocator => (args) => {
  const request = fieldSchema('workId').safeParse(args[index])
  return request.success ? { kind: 'work', id: request.data.workId } : null
}
const taskIdAt = (index: number): ArgLocator => (args) => {
  const id = idSchema.safeParse(args[index])
  return id.success ? { kind: 'task', id: id.data } : null
}
/** The id of a resource that is not shared (an automation, a project), as a bare argument. */
const ownedIdAt = (kind: ResourceKind, index: number): ArgLocator => (args) => {
  const id = idSchema.safeParse(args[index])
  return id.success ? { kind, id: id.data } : null
}
const notificationFieldAt = (index: number): ArgLocator => (args) => {
  const request = fieldSchema('id').safeParse(args[index])
  return request.success ? { kind: 'notification', id: request.data.id } : null
}

const shareRequestSchema = z.object({ resource: shareResourceSchema })

function sharedResourceAt(index: number): ArgLocator {
  return (args) => {
    const request = shareRequestSchema.safeParse(args[index])
    return request.success ? request.data.resource : null
  }
}

/** Where the resource id sits in each resource call; exhaustive against the contracts' verb table. */
export const RESOURCE_LOCATORS = {
  // Sessions — reading
  watchSession: sessionFieldAt(0, 'sessionId'),
  unwatchSession: sessionIdAt(0),
  bindRuntimeSession: ctxAt(0),
  loadSession: sessionIdAt(0),
  loadSessionSubagent: sessionFieldAt(0, 'sessionId'),
  loadSessionPage: sessionFieldAt(0, 'sessionId'),
  loadSessionToolInputs: sessionFieldAt(0, 'sessionId'),
  mcpAppRead: sessionFieldAt(0, 'sessionId'),
  mcpAppToolInfo: sessionFieldAt(0, 'sessionId'),
  mcpAppCallTool: sessionFieldAt(0, 'sessionId'),
  mcpAppReadResource: sessionFieldAt(0, 'sessionId'),
  loadSessionPreview: sessionIdAt(0),
  loadSessionMessageWindow: sessionFieldAt(0, 'sessionId'),
  getSessionInfo: sessionIdAt(0),
  getSessionInfos: singleSessionIdAt(0),
  describeSession: sessionIdAt(0),
  loadPlanContent: sessionIdAt(0),
  loadPlanAnnotations: sessionIdAt(0),
  getThreadGoal: sessionIdAt(0),
  listTurnSnapshots: ctxAt(0),
  diff: ctxAt(0),
  diffFileContents: ctxAt(0),
  diffStats: ctxAt(0),
  tasksForSession: sessionIdAt(0),
  metricsSessionSummary: sessionIdAt(0),
  setSessionReadState: sessionIdAt(0),
  togglePinnedSession: sessionFieldAt(0, 'sessionId'),
  // Sessions — driving
  prompt: ctxAt(0),
  compactSession: ctxAt(0),
  retry: ctxAt(0),
  decideSessionPlan: ctxAt(0),
  promptHeadlessSession: sessionFieldAt(0, 'sessionId'),
  stopSession: sessionIdAt(0),
  stopBackgroundTasks: sessionIdAt(0),
  resetSession: ctxAt(0),
  acceptPlan: ctxAt(0),
  switchSessionAgent: sessionIdAt(0),
  respondPermission: ctxAt(0),
  respondQuestion: ctxAt(0),
  rateLimitDecision: ctxAt(0),
  cancelQueuedPrompt: ctxAt(0),
  editQueuedPrompt: ctxAt(0),
  sessionQueue: ctxAt(0),
  sessionQueueChange: ctxAt(0),
  // Typing in a session is something only someone who may prompt it does.
  presenceSetComposing: sessionFieldAt(0, 'sessionId'),
  presenceSetEditing: workFieldAt(0),
  writePlanFile: optionalCtxAt(2),
  attachFiles: optionalCtxAt(0),
  attachFilePaths: optionalCtxAt(1),
  attachUpload: ctxAt(0),
  attachUploadToken: ctxAt(0),
  takeScreenshot: optionalCtxAt(0),
  pasteImage: optionalCtxAt(1),
  setSessionTitle: sessionIdAt(0),
  ensureBackgroundSessionTitle: sessionIdAt(0),
  setSessionBranch: sessionIdAt(0),
  sessionPullRequestWatch: sessionIdAt(0),
  setThreadGoal: sessionFieldAt(0, 'threadId'),
  clearThreadGoal: sessionIdAt(0),
  savePlanAnnotations: sessionFieldAt(0, 'sessionId'),
  toggleBookmarkPlan: sessionIdAt(0),
  publishPlan: sessionFieldAt(0, 'sessionId'),
  pullPlanUpstream: sessionIdAt(0),
  refreshPlanUpstream: sessionIdAt(0),
  unlinkPlanUpstream: sessionIdAt(0),
  tasksLinkSession: sessionIdAt(1),
  tasksUnlinkSession: sessionIdAt(1),
  // Works — reading
  loadWorkRevisions: workIdAt(0),
  loadWorkRevision: workIdAt(0),
  workReviewGet: workIdAt(0),
  // Live editing: anyone who can read joins the room; only an editor pushes.
  workLiveOpen: workFieldAt(0),
  workLiveAwareness: workFieldAt(0),
  workLiveClose: workFieldAt(0),
  loadWorkAnnotations: workIdAt(0),
  markWorkCommentRead: workIdAt(0),
  readWorkGoogleComments: workIdAt(0),
  readWorkExternalComments: workIdAt(0),
  shareGet: sharedResourceAt(0),
  // Works — commenting and reviewing (a commenter may; a viewer only reads)
  applyWorkComment: workIdAt(0),
  workReviewDecide: workIdAt(0),
  // Works — editing
  agentSaveWork: workIdAt(0),
  restoreWorkRevision: workIdAt(0),
  workReviewRequest: workIdAt(0),
  workReviewRemove: workIdAt(0),
  workLivePush: workFieldAt(0),
  setWorkPinned: workIdAt(0),
  linkWorkSession: workIdAt(0),
  duplicateWork: workIdAt(0),
  worksExport: workFieldAt(0),
  refreshWorkGoogleComments: workIdAt(0),
  sendWorkGoogleComment: workIdAt(0),
  refreshWorkExternalComments: workIdAt(0),
  sendWorkExternalComment: workIdAt(0),
  publishWork: workIdAt(0),
  pullWorkUpstream: workIdAt(0),
  refreshWorkUpstream: workIdAt(0),
  unlinkWorkUpstream: workIdAt(0),
  shareSet: sharedResourceAt(0),
  shareSetLink: sharedResourceAt(0),
  // Tasks — a task shared with someone shares its page and everything linked to it (§3.4).
  tasksReadExtras: taskIdAt(0),
  tasksSessions: taskIdAt(0),
  tasksSnapshot: taskIdAt(0),
  tasksMarkRead: taskIdAt(0),
  // A snooze is the caller's own view of a task they can read (docs/task-snooze.md).
  tasksSnooze: taskIdAt(0),
  tasksRecordActivity: taskIdAt(0),
  tasksComment: taskIdAt(0),
  tasksDeleteComment: taskIdAt(0),
  tasksPublishComments: taskIdAt(0),
  tasksPublish: taskIdAt(0),
  tasksSyncNow: taskIdAt(0),
  tasksLink: taskIdAt(0),
  tasksUnlink: taskIdAt(0),
  tasksAttachArtifact: taskIdAt(0),
  // Owner only. A host admin may also transfer what a departed member owned, which
  // the share manager decides from the organization standing (plan 004 item 10).
  shareTransfer: sharedResourceAt(0),
  // A Local work leaves its host by its owner's Share (docs/plans/cloud-sharing.md).
  workExportForCloud: workIdAt(0),
  workMarkMoved: workIdAt(0),
  taskExportForCloud: taskIdAt(0),
  taskMarkMoved: taskIdAt(0),
  // Showing a device in a session changes that session's workspace. The device
  // handler also refuses guests: a session share grants no host device access.
  deviceOpen: sessionFieldAt(0, 'sessionId'),
  deviceClose: sessionFieldAt(0, 'sessionId'),
  // Automations, projects, and notifications have an owner and no ACL entries (docs/plans/access-model.md §2.3).
  automationRead: ownedIdAt('automation', 0),
  automationListRuns: ownedIdAt('automation', 0),
  automationReadRun: ownedIdAt('automation', 0),
  automationUpdate: ownedIdAt('automation', 0),
  automationSetEnabled: ownedIdAt('automation', 0),
  automationDelete: ownedIdAt('automation', 0),
  automationRun: ownedIdAt('automation', 0),
  automationCancel: ownedIdAt('automation', 0),
  workspaceProjectUpdate: ownedIdAt('project', 0),
  workspaceProjectRemove: ownedIdAt('project', 0),
  notificationsSetRead: notificationFieldAt(0),
  notificationsSetArchived: notificationFieldAt(0),
} satisfies Record<ResourceMethod, ArgLocator>

/** The permissions every person holds; `host.local` and `host.admin` are added by host role. */
const PERSON_PERMISSIONS: readonly Permission[] = [
  'host.connect', 'host.agents', 'host.models', 'host.sessions', 'host.projects', 'host.git', 'host.files', 'host.terminal', 'host.usage', 'host.use',
]

/**
 * A link visitor (docs/plans/host-sharing.md): what the composer, the session
 * list, the panel, and the files pane need, read only, with git and file reads
 * bounded to the shared session's checkout (`assertPathInScope`). The resource
 * itself follows the link's role.
 */
export const GUEST_PERMISSIONS: readonly Permission[] = [
  'host.connect', 'host.agents.read', 'host.models.read', 'host.sessions.read', 'host.git.read', 'host.files.read',
]

/**
 * The permissions a principal holds on this host (permissions.md §2): the one
 * table a client's controls and this gate both read. A managed host never gives
 * `host.local.reach`: Solus cloud owns how it is reached.
 */
export function permissionsFor(principal: Principal, managed = hostCategory() === 'managed' || isApiMode()): Permission[] {
  switch (principal.kind) {
    case 'system': return ['host']
    case 'runner': return ['host.system']
    case 'guest': return [...GUEST_PERMISSIONS]
    case 'local-owner': return [managed ? 'host.local.window' : 'host.local', 'host.admin', ...PERSON_PERMISSIONS]
    case 'remote-owner': return ['host.admin', ...PERSON_PERMISSIONS]
    case 'org-member': {
      const permissions: Permission[] = [...PERSON_PERMISSIONS]
      if (isHostAdmin(principal)) permissions.push('host.admin')
      // On the workspace service a person's integration connections are their own rows (cloud-service-model.md §22).
      else if (isApiMode()) permissions.push('host.admin.connections')
      return permissions
    }
  }
}

export class RpcAccessError extends Error {
  constructor(
    readonly method: RpcMethod,
    readonly principalKind: PrincipalKind,
    detail?: string,
    /** `MANAGED_HOST` names a method no connection may call on a managed host, whatever its standing. */
    readonly code: 'FORBIDDEN' | 'MANAGED_HOST' = 'FORBIDDEN',
  ) {
    super(detail ?? `"${method}" is not available to this connection`)
    this.name = 'RpcAccessError'
  }
}

export interface ResourceAccess {
  roleFor(principal: Principal, resource: AccessResource): Promise<ResourceRole>
}

/** Why `authorize` refused, in words a person can read. */
export interface AccessRefusal {
  code: 'FORBIDDEN' | 'MANAGED_HOST'
  detail: string
}

/** What `authorize` reads beyond the call: the name the refusal shows, the role lookup, and the host's category. */
export interface AuthorizeOptions {
  /** The operation, for the refusal text: an RPC method or a Solus API operation. */
  name: string
  /** Absent only in the desktop's in-process path before the share manager exists. */
  resources?: ResourceAccess
  managed?: boolean
}

function refusedPermission(name: string, principal: Principal, permission: Permission): AccessRefusal {
  const refuse = (detail: string): AccessRefusal => ({ code: 'FORBIDDEN', detail })
  if (principal.kind === 'runner') return refuse(`"${name}" is not available to a runner`)
  if (principal.kind === 'guest') return refuse(`"${name}" is not available to a guest`)
  if (permission === 'host.system') return refuse(`"${name}" is only available to the host itself`)
  if (permission.startsWith('host.local')) return refuse(`"${name}" is only available to a local connection`)
  if (permission.startsWith('host.admin')) return refuse(`"${name}" is only available to the host administrator`)
  return refuse(`"${name}" needs ${permission} on this host`)
}

/**
 * The one access decision (docs/plans/access-model.md §2.4): may `principal` do
 * `action`, a permission on the host or a verb on `resource`? Null when it may.
 * The RPC gate and the Solus API both call it, so the order of the checks is
 * written once: the managed-host bound, the host itself, then the permission or
 * the resource role `roleOf` gives. A resource verb with no resource is a call
 * that names nothing yet (a draft with no session): the host's ordinary use,
 * refused to a guest. A Solus API token's scopes are a separate upper bound
 * (`requireScope`).
 */
export async function authorize(principal: Principal, action: Permission | ResourceVerb, resource: AccessResource | null, options: AuthorizeOptions): Promise<AccessRefusal | null> {
  const { name, resources, managed = hostCategory() === 'managed' || isApiMode() } = options
  // Managed-hosts.md §1: how a managed host is reached is Solus cloud's, whoever calls, the host's own calls included.
  if (managed && action === 'host.local.reach') {
    return { code: 'MANAGED_HOST', detail: `"${name}" is not available on a managed host: Solus cloud owns how this host is reached` }
  }
  if (principal.kind === 'system') return null
  if (!isResourceVerb(action)) {
    return permissionsAllow(permissionsFor(principal, managed), action) ? null : refusedPermission(name, principal, action)
  }
  if (principal.kind === 'runner') return { code: 'FORBIDDEN', detail: `"${name}" is not available to a runner` }
  if (!resource) {
    return principal.kind === 'guest' ? { code: 'FORBIDDEN', detail: `"${name}" needs a shared session or work` } : null
  }
  if (!resources) {
    return isHostOwner(principal) ? null : { code: 'FORBIDDEN', detail: 'Sharing is not available on this host' }
  }
  const role = await resources.roleFor(principal, resource)
  if (roleAllows(role, action)) return null
  return {
    code: 'FORBIDDEN',
    detail: role === 'none' ? `This ${resource.kind} is not shared with you` : `"${name}" needs ${resource.kind}.${action} on this ${resource.kind}`,
  }
}

/** The RPC door: the action and the resource of one call, decided by `authorize`. */
export async function assertRpcAccess(method: RpcMethod, principal: Principal, args: readonly unknown[] = [], resources?: ResourceAccess, managed = hostCategory() === 'managed' || isApiMode()): Promise<void> {
  // A host admin may hand on what a departed member owned; the share manager decides (plan 004 item 10).
  if (method === 'shareTransfer' && isHostAdmin(principal)) return
  const refusal = isResourceMethod(method)
    ? await authorize(principal, resourceVerbOf(method), RESOURCE_LOCATORS[method](args), { name: method, resources, managed })
    : await authorize(principal, permissionOf(method) ?? HOST_USE, null, { name: method, resources, managed })
  if (refusal) throw new RpcAccessError(method, principal.kind, refusal.detail, refusal.code)
}
