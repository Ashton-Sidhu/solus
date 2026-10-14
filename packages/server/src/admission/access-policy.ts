import { z } from 'zod'
import type { RpcMethod } from '@solus/contracts/rpc'
import {
  grantsAllow,
  hostActionOf,
  isResourceMethod,
  resourceVerbOf,
  roleAllows,
  type HostAction,
  type ResourceMethod,
} from '@solus/contracts/permissions'
import { shareResourceSchema, type ResourceRole, type ShareResource } from '@solus/contracts/sharing'
import { hostCategory } from '../host/host-category'
import { isOrganizationAttached } from '../host/organization-attachment'
import { isApiMode } from '../host/api-mode'
import { isHostAdmin, isHostOwner, type Principal, type PrincipalKind } from './principal'

/**
 * The access gate of one host (docs/plans/permissions.md). Every method needs one
 * action, declared once in the contracts: a host action, held as a grant on the
 * whole host, or a resource verb, held through the share role on the session,
 * work, or task the call names. `grantsFor` is the one place a principal kind's
 * standing is written; `RESOURCE_LOCATORS` is the one place the server says where
 * a resource id sits in a call. Nothing else decides access.
 */

type ArgLocator = (args: readonly unknown[]) => ShareResource | null

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
  loadSessionPage: sessionFieldAt(0, 'sessionId'),
  loadSessionToolInputs: sessionFieldAt(0, 'sessionId'),
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
  sessionPullRequestLink: sessionIdAt(0),
  sessionPullRequestUnlink: sessionIdAt(0),
  sessionPullRequestWatch: sessionIdAt(0),
  sessionSetSettled: sessionIdAt(0),
  sessionSnooze: sessionIdAt(0),
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
} satisfies Record<ResourceMethod, ArgLocator>

/** The host actions every person holds; `host.local` and `host.admin` are added by standing. */
const PERSON_HOST_ACTIONS: readonly HostAction[] = [
  'host.connect', 'host.agents', 'host.models', 'host.sessions', 'host.projects', 'host.git', 'host.files', 'host.terminal', 'host.usage', 'host.use',
]

/**
 * A link visitor (docs/plans/host-sharing.md): what the composer, the session
 * list, the panel, and the files pane need, read only, with git and file reads
 * bounded to the shared session's checkout (`assertPathInScope`). The resource
 * itself follows the link's role.
 */
export const GUEST_HOST_ACTIONS: readonly HostAction[] = [
  'host.connect', 'host.agents.read', 'host.models.read', 'host.sessions.read', 'host.git.read', 'host.files.read',
]

/**
 * The host actions a principal holds on this host (permissions.md §2): the one
 * table a client's controls and this gate both read. A managed host never hands
 * out `host.local.reach`: Solus cloud owns how it is reached.
 */
export function grantsFor(principal: Principal, managed = hostCategory() === 'managed' || isApiMode()): HostAction[] {
  switch (principal.kind) {
    case 'system': return ['host']
    case 'runner': return ['host.system']
    case 'guest': return [...GUEST_HOST_ACTIONS]
    case 'local-owner': return [managed ? 'host.local.window' : 'host.local', 'host.admin', ...PERSON_HOST_ACTIONS]
    case 'remote-owner': return ['host.admin', ...PERSON_HOST_ACTIONS]
    case 'org-member': {
      const grants: HostAction[] = [...PERSON_HOST_ACTIONS]
      if (isHostAdmin(principal)) grants.push('host.admin')
      // On the workspace service a person's integration connections are their own rows (cloud-service-model.md §22).
      else if (isApiMode()) grants.push('host.admin.connections')
      return grants
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
  roleFor(principal: Principal, resource: ShareResource): Promise<ResourceRole>
}

/**
 * The personal host's owner has every role on every resource: they own the disk
 * (§3.4). A pairing connection to a machine attached for organization work keeps
 * only its Local records (organization-vms §1), which the share manager decides.
 */
function holdsEveryResource(principal: Principal): boolean {
  return isHostOwner(principal) && !(principal.kind === 'local-owner' && isOrganizationAttached())
}

function refusedHostAction(method: RpcMethod, principal: Principal, action: HostAction): RpcAccessError {
  if (principal.kind === 'runner') return new RpcAccessError(method, principal.kind, `"${method}" is not available to a runner`)
  if (principal.kind === 'guest') return new RpcAccessError(method, principal.kind, `"${method}" is not available to a guest`)
  if (action === 'host.system') return new RpcAccessError(method, principal.kind, `"${method}" is only available to the host itself`)
  if (action.startsWith('host.local')) return new RpcAccessError(method, principal.kind, `"${method}" is only available to a local connection`)
  if (action.startsWith('host.admin')) return new RpcAccessError(method, principal.kind, `"${method}" is only available to the host administrator`)
  return new RpcAccessError(method, principal.kind, `"${method}" needs ${action} on this host`)
}

/**
 * The one gate every dispatch passes. `resources` is absent only in the desktop's
 * in-process path before the share manager exists; there every caller is the local
 * owner, for whom a resource verb is a no-op.
 */
export async function assertRpcAccess(method: RpcMethod, principal: Principal, args: readonly unknown[] = [], resources?: ResourceAccess, managed = hostCategory() === 'managed' || isApiMode()): Promise<void> {
  // Managed-hosts.md §1: how a managed host is reached is Solus cloud's, whoever calls, the host's own calls included.
  if (managed && hostActionOf(method) === 'host.local.reach') {
    throw new RpcAccessError(method, principal.kind, `"${method}" is not available on a managed host: Solus cloud owns how this host is reached`, 'MANAGED_HOST')
  }
  if (principal.kind === 'system') return
  if (!isResourceMethod(method)) {
    const action = hostActionOf(method)
    if (action && !grantsAllow(grantsFor(principal, managed), action)) throw refusedHostAction(method, principal, action)
    return
  }
  if (principal.kind === 'runner') throw new RpcAccessError(method, principal.kind, `"${method}" is not available to a runner`)
  const resource = RESOURCE_LOCATORS[method](args)
  if (!resource) {
    // A resource call that names nothing (a draft with no session yet) is the host's ordinary use.
    if (principal.kind === 'guest') throw new RpcAccessError(method, principal.kind, `"${method}" needs a shared session or work`)
    return
  }
  if (holdsEveryResource(principal)) return
  // A host admin may hand on what a departed member owned; the share manager decides (plan 004 item 10).
  if (method === 'shareTransfer' && isHostAdmin(principal)) return
  if (!resources) throw new RpcAccessError(method, principal.kind, 'Sharing is not available on this host')
  const verb = resourceVerbOf(method)
  const role = await resources.roleFor(principal, resource)
  if (!roleAllows(role, verb)) {
    throw new RpcAccessError(method, principal.kind, role === 'none'
      ? `This ${resource.kind} is not shared with you`
      : `"${method}" needs ${resource.kind}.${verb} on this ${resource.kind}`)
  }
}
