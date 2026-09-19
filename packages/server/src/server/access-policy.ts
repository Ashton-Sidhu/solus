import { z } from 'zod'
import { RPC_INVOKE_METHODS, type RpcMethod } from '@solus/contracts/rpc'
import { resourceRoleAtLeast, shareResourceSchema, type ResourceRole, type ShareResource } from '@solus/contracts/sharing'
import { isManagedHost } from './managed-mode'
import { isHostAdmin, isHostOwner, type Principal, type PrincipalKind } from './principal'
import { isWorkspaceMode } from './workspace-mode'

/**
 * The access policy of one host (docs/plans/personal-uplink.md P2;
 * docs/plans/multiplayer-sharing.md §3.7). Every RPC method belongs to exactly one
 * class, and a test fails when a method is missing from the map:
 *
 * - `local-only`  changes how the host is reached or drives its window; a trusted
 *                 local connection only. A grant proves identity, not presence.
 * - `host-admin`  administers the machine: credentials, updates, host config.
 * - `host-wide`   the catalog and the tools of the host: projects, files, git,
 *                 tasks, PRs. Owners and organization members; never a guest.
 * - `resource`    names a session, a work, or a task. Checked against ownership
 *                 and the share list with the role the method needs.
 * - `system-only` a report from a runner to the collaboration plane
 *                 (docs/plans/cloud-service-model.md): the host itself, or a
 *                 `runner` principal writing to its own organization.
 */
export type RpcAccessClass = 'local-only' | 'host-admin' | 'host-wide' | 'resource' | 'system-only'

export interface ResourceRule {
  /** Where the resource id sits in the call. */
  locate: (args: readonly unknown[]) => ShareResource | null
  /** The least role that may make the call. */
  requires: ResourceRole
}

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

const viewer = (locate: ArgLocator): ResourceRule => ({ locate, requires: 'viewer' })
const editor = (locate: ArgLocator): ResourceRule => ({ locate, requires: 'editor' })
const owner = (locate: ArgLocator): ResourceRule => ({ locate, requires: 'owner' })

/** Session and work methods: where the id is and what it takes. */
const resourceRpcRules = {
  // Sessions — reading
  watchSession: viewer(sessionFieldAt(0, 'sessionId')),
  unwatchSession: viewer(sessionIdAt(0)),
  bindRuntimeSession: viewer(ctxAt(0)),
  loadSession: viewer(sessionIdAt(0)),
  loadSessionPage: viewer(sessionFieldAt(0, 'sessionId')),
  loadSessionToolInputs: viewer(sessionFieldAt(0, 'sessionId')),
  loadSessionPreview: viewer(sessionIdAt(0)),
  loadSessionMessageWindow: viewer(sessionFieldAt(0, 'sessionId')),
  getSessionInfo: viewer(sessionIdAt(0)),
  getSessionInfos: viewer(singleSessionIdAt(0)),
  // Opening a session by id resolves its lineage first; the share manager canonicalizes
  // ids through the same table, so a provider thread id names the shared session.
  describeSession: viewer(sessionIdAt(1)),
  resolveSessionLineage: viewer(sessionIdAt(1)),
  loadPlanContent: viewer(sessionIdAt(0)),
  loadPlanAnnotations: viewer(sessionIdAt(0)),
  getThreadGoal: viewer(sessionIdAt(0)),
  listTurnSnapshots: viewer(ctxAt(0)),
  diff: viewer(ctxAt(0)),
  diffFileContents: viewer(ctxAt(0)),
  diffStats: viewer(ctxAt(0)),
  tasksForSession: viewer(sessionIdAt(0)),
  metricsSessionSummary: viewer(sessionIdAt(0)),
  setSessionReadState: viewer(sessionIdAt(0)),
  togglePinnedSession: viewer(sessionFieldAt(0, 'sessionId')),
  // Sessions — driving
  prompt: editor(ctxAt(0)),
  retry: editor(ctxAt(0)),
  promptSession: editor(sessionIdAt(0)),
  stopSession: editor(sessionIdAt(0)),
  resetSession: editor(ctxAt(0)),
  switchSessionAgent: editor(sessionIdAt(0)),
  respondPermission: editor(ctxAt(0)),
  respondQuestion: editor(ctxAt(0)),
  rateLimitDecision: editor(ctxAt(0)),
  cancelQueuedPrompt: editor(ctxAt(0)),
  editQueuedPrompt: editor(ctxAt(0)),
  // Typing in a session is something only someone who may prompt it does.
  presenceSetComposing: editor(sessionFieldAt(0, 'sessionId')),
  rewindFiles: editor(ctxAt(0)),
  writePlanFile: editor(optionalCtxAt(2)),
  attachFiles: editor(optionalCtxAt(0)),
  attachFilePaths: editor(optionalCtxAt(1)),
  attachUpload: editor(ctxAt(0)),
  takeScreenshot: editor(optionalCtxAt(0)),
  pasteImage: editor(optionalCtxAt(1)),
  enterDesignMode: editor(optionalCtxAt(0)),
  submitDesignAnnotations: editor(optionalCtxAt(1)),
  setSessionTitle: editor(sessionIdAt(0)),
  setSessionBranch: editor(sessionIdAt(0)),
  setThreadGoal: editor(sessionFieldAt(0, 'threadId')),
  clearThreadGoal: editor(sessionIdAt(0)),
  savePlanAnnotations: editor(sessionFieldAt(0, 'sessionId')),
  toggleBookmarkPlan: editor(sessionIdAt(0)),
  publishPlan: editor(sessionFieldAt(0, 'sessionId')),
  pullPlanUpstream: editor(sessionIdAt(0)),
  refreshPlanUpstream: editor(sessionIdAt(0)),
  unlinkPlanUpstream: editor(sessionIdAt(0)),
  tasksLinkSession: editor(sessionIdAt(1)),
  tasksUnlinkSession: editor(sessionIdAt(1)),
  tasksRekeySession: editor(sessionIdAt(0)),
  // Works — reading
  loadWork: viewer(workIdAt(0)),
  loadWorkPrevious: viewer(workIdAt(0)),
  loadWorkAnnotations: viewer(workIdAt(0)),
  markWorkCommentRead: viewer(workIdAt(0)),
  readWorkGoogleComments: viewer(workIdAt(0)),
  readWorkExternalComments: viewer(workIdAt(0)),
  shareGet: viewer(sharedResourceAt(0)),
  // Works — editing
  saveWork: editor(workIdAt(0)),
  agentSaveWork: editor(workIdAt(0)),
  revertWork: editor(workIdAt(0)),
  setWorkPinned: editor(workIdAt(0)),
  applyWorkComment: editor(workIdAt(0)),
  linkWorkSession: editor(workIdAt(0)),
  duplicateWork: viewer(workIdAt(0)),
  worksExport: viewer(workFieldAt(0)),
  refreshWorkGoogleComments: editor(workIdAt(0)),
  sendWorkGoogleComment: editor(workIdAt(0)),
  refreshWorkExternalComments: editor(workIdAt(0)),
  sendWorkExternalComment: editor(workIdAt(0)),
  publishWork: editor(workIdAt(0)),
  pullWorkUpstream: editor(workIdAt(0)),
  refreshWorkUpstream: editor(workIdAt(0)),
  unlinkWorkUpstream: editor(workIdAt(0)),
  shareSet: editor(sharedResourceAt(0)),
  shareSetLink: editor(sharedResourceAt(0)),
  // Tasks — a task shared with someone shares its page and everything linked to it (§3.4).
  tasksGet: viewer(taskIdAt(0)),
  tasksSessions: viewer(taskIdAt(0)),
  tasksSnapshot: viewer(taskIdAt(0)),
  tasksMarkRead: viewer(taskIdAt(0)),
  tasksRecordActivity: viewer(taskIdAt(0)),
  tasksUpdate: editor(taskIdAt(0)),
  tasksComment: editor(taskIdAt(0)),
  tasksDeleteComment: editor(taskIdAt(0)),
  tasksPublishComments: editor(taskIdAt(0)),
  tasksPublish: editor(taskIdAt(0)),
  tasksSyncNow: editor(taskIdAt(0)),
  tasksLink: editor(taskIdAt(0)),
  tasksUnlink: editor(taskIdAt(0)),
  tasksAttachArtifact: editor(taskIdAt(0)),
  // Owner only
  deleteWork: owner(workIdAt(0)),
  tasksDelete: owner(taskIdAt(0)),
  shareTransfer: owner(sharedResourceAt(0)),
} satisfies Partial<Record<RpcMethod, ResourceRule>>

export const RESOURCE_RPC_RULES: ReadonlyMap<RpcMethod, ResourceRule> = new Map(
  Object.entries(resourceRpcRules).map(([method, rule]) => [
    // SAFETY: `satisfies Partial<Record<RpcMethod, ResourceRule>>` above proved every key of the literal is an RpcMethod.
    method as RpcMethod,
    rule,
  ]),
)

const shareRequestSchema = z.object({ resource: shareResourceSchema })

function sharedResourceAt(index: number): ArgLocator {
  return (args) => {
    const request = shareRequestSchema.safeParse(args[index])
    return request.success ? request.data.resource : null
  }
}

export const LOCAL_ONLY_RPC_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  // Window and shortcut control
  'isVisible',
  'getAppGlobalShortcuts',
  'setAppGlobalShortcuts',
  'restartApp',
  // How the host is reached
  'connectionsSetRemoteAccess',
  'connectionsSetTrustLocalNetwork',
  'connectionsGeneratePairToken',
  'connectionsBootstrapDiscoveredServer',
  // The cloud link itself (its status is a read, open to any owner)
  'uplinkLink',
  'uplinkUnlink',
])

/**
 * Refused on a managed host (docs/plans/managed-hosts.md §1) and on the workspace
 * service (cloud-service-model.md §15), whoever calls: pairing does not exist
 * there, admission is never widened, and the link is system-owned — unlinking a
 * managed host is a control-plane delete, and the service has no link at all.
 * Every one is also local-only, so the class map stays exhaustive; this set only
 * names the reason.
 */
export const MANAGED_HOST_REFUSED_RPC_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'connectionsSetRemoteAccess',
  'connectionsSetTrustLocalNetwork',
  'connectionsGeneratePairToken',
  'connectionsBootstrapDiscoveredServer',
  'uplinkLink',
  'uplinkUnlink',
])

/** Credentials, updates, and host config: the machine's administrator only. */
export const HOST_ADMIN_RPC_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'connectionsRevokeDevice',
  'typeSafeKeySet',
  'configUpdate',
  'setAnalyticsConsent',
  'setProjectsBaseDirectory',
  'deleteProject',
  'hostCheckForUpdates',
  'hostInstallUpdate',
  'hostCancelUpdate',
  'setupInstallAgentCli',
  'setupInstallGit',
  'setupInstallGh',
  'setupSetGitIdentity',
  'setupAuthorizeGhCli',
  'setupInstallGitCredentialHelper',
  'seatRemove',
  'googleConnect',
  'googleDisconnect',
  'cloudflareConnect',
  'cloudflareDisconnect',
  'atlassianStartOAuth',
  'atlassianCancelOAuth',
  'atlassianDisconnect',
  'providerConnect',
  'providerCancelConnect',
  'providerDisconnect',
  'githubExportCredential',
  'codeIntelInstall',
  'browserRequestCookieAccess',
  'browserImportCookies',
])

/**
 * On the workspace service a person's GitHub, Google, and Atlassian connections
 * are their own rows in the vault (cloud-service-model.md §22), so connecting,
 * cancelling, and disconnecting are host-wide there: every member may act, and
 * the handler acts on the caller's row alone. On a host these stay host-admin —
 * they change the machine's one credential.
 */
export const PER_PERSON_ON_SERVICE_RPC_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'googleConnect',
  'googleDisconnect',
  'atlassianStartOAuth',
  'atlassianCancelOAuth',
  'atlassianDisconnect',
  'providerConnect',
  'providerCancelConnect',
  'providerDisconnect',
])

/**
 * Writes only a process acting for the host makes: a runner reporting a session
 * record to the collaboration plane. No person's connection may call these; a
 * `runner` principal may call nothing else.
 */
export const SYSTEM_ONLY_RPC_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'sessionRecordUpsert',
])

/** The few host-wide calls a guest client needs to boot and keep its socket: nothing about the host leaks through them. */
export const GUEST_HOST_RPC_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'connectionsGetServerInfo',
  'getServerCapabilities',
  'activityLease',
  'listAttention',
  // Its own client id and an empty host; the handler scopes a guest's focus to its one resource.
  'presenceSnapshot',
  'presenceSetFocus',
  // The task page reads the sidebar snapshot; the handler filters it to what the caller may open,
  // which for a guest is the one task its link names, or nothing.
  'tasksSidebarSnapshot',
  'tasksList',
])

export function rpcAccessClass(method: RpcMethod): RpcAccessClass {
  if (LOCAL_ONLY_RPC_METHODS.has(method)) return 'local-only'
  if (HOST_ADMIN_RPC_METHODS.has(method)) return 'host-admin'
  if (SYSTEM_ONLY_RPC_METHODS.has(method)) return 'system-only'
  if (RESOURCE_RPC_RULES.has(method)) return 'resource'
  return 'host-wide'
}

/** Every method the registry knows, with its class; the policy test asserts the set is exhaustive. */
export function rpcAccessMap(): ReadonlyMap<RpcMethod, RpcAccessClass> {
  return new Map(RPC_INVOKE_METHODS.map((method) => [method, rpcAccessClass(method)]))
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

/** Managed-hosts.md §1: the system-owned methods are refused before any standing is weighed, the host's own calls included. */
function assertManagedHostOffers(method: RpcMethod, principal: Principal): void {
  if (!MANAGED_HOST_REFUSED_RPC_METHODS.has(method)) return
  throw new RpcAccessError(method, principal.kind, `"${method}" is not available on a managed host: Solus cloud owns how this host is reached`, 'MANAGED_HOST')
}

/**
 * A runner is not a person (cloud-service-model.md §16): its organization is the
 * only scope it writes in (`organizationOf` reads it off the principal), and the
 * system-only methods are the only ones it reaches.
 */
function assertRunnerAccess(method: RpcMethod, accessClass: RpcAccessClass): void {
  if (accessClass === 'system-only') return
  throw new RpcAccessError(method, 'runner', `"${method}" is not available to a runner`)
}

/** The class a call is weighed against on this process: a person's own connection is host-wide on the service, the map's class everywhere else. */
function accessClassHere(method: RpcMethod): RpcAccessClass {
  if (PER_PERSON_ON_SERVICE_RPC_METHODS.has(method) && isWorkspaceMode()) return 'host-wide'
  return rpcAccessClass(method)
}

/**
 * The one gate every dispatch passes. `resources` is absent only in the desktop's
 * in-process path before the share manager exists; there every caller is the local
 * owner, for whom the resource class is a no-op.
 */
export async function assertRpcAccess(method: RpcMethod, principal: Principal, args: readonly unknown[] = [], resources?: ResourceAccess, managed = isManagedHost() || isWorkspaceMode()): Promise<void> {
  if (managed) assertManagedHostOffers(method, principal)
  if (principal.kind === 'system') return
  const accessClass = accessClassHere(method)
  if (principal.kind === 'runner') return assertRunnerAccess(method, accessClass)
  switch (accessClass) {
    case 'system-only':
      throw new RpcAccessError(method, principal.kind, `"${method}" is only available to the host itself`)
    case 'local-only':
      if (principal.kind !== 'local-owner') throw new RpcAccessError(method, principal.kind, `"${method}" is only available to a local connection`)
      return
    case 'host-admin':
      if (!isHostAdmin(principal)) throw new RpcAccessError(method, principal.kind, `"${method}" is only available to the host administrator`)
      return
    case 'host-wide':
      if (principal.kind === 'guest' && !GUEST_HOST_RPC_METHODS.has(method)) {
        throw new RpcAccessError(method, principal.kind, `"${method}" is not available to a guest`)
      }
      return
    case 'resource': {
      const rule = RESOURCE_RPC_RULES.get(method)
      if (!rule) return
      const resource = rule.locate(args)
      if (!resource) {
        // A resource call that names nothing (a draft with no session yet) is host-wide.
        if (principal.kind === 'guest') throw new RpcAccessError(method, principal.kind, `"${method}" needs a shared ${'session'} or work`)
        return
      }
      // The personal host's owner has every role on every resource: they own the disk (§3.4).
      if (isHostOwner(principal)) return
      if (!resources) throw new RpcAccessError(method, principal.kind, 'Sharing is not available on this host')
      const role = await resources.roleFor(principal, resource)
      if (!resourceRoleAtLeast(role, rule.requires)) {
        throw new RpcAccessError(method, principal.kind, role === 'none'
          ? `This ${resource.kind} is not shared with you`
          : `"${method}" needs ${rule.requires} access to this ${resource.kind}`)
      }
      return
    }
  }
}
