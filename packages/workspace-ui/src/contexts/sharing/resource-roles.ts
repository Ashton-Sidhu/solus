import { SvelteMap } from 'svelte/reactivity'
import { standingAllows, type ResourceActionPath, type ResourceRef, type ResourceStanding } from '@solus/contracts/permissions'
import { shareResourceKindSchema, type ResourceRole, type ShareList, type ShareResource } from '@solus/contracts/sharing'

/** What the composer says to a member who may read a shared session but not drive it. */
export const VIEW_ONLY_REASON = 'Shared with you to view.'

/** What the composer says to a guest whose link lets them suggest, not prompt (docs/plans/custom-roles.md §7). */
export const SUGGEST_ONLY_REASON = 'Suggest a message. Someone who can prompt sends it.'

/** Why a control that changes a resource is off: the reader's role on it does not allow the change. */
export const NOT_YOURS_REASON = 'Only its owner or an administrator can change this.'

/** The part of the shares store this reads. */
interface ShareLists {
  listFor(serverId: string, resource: ShareResource): ShareList | undefined
  load(serverId: string, resource: ShareResource): Promise<ShareList | null>
}

// The shares store hands itself over when it is created, rather than being
// imported here: the session reducer and the sidebar store ask this question,
// and importing the shares store would bring its toasts and network graph into
// both of them.
let shares: ShareLists | null = null

export function provideResourceRoles(source: ShareLists): void {
  shares = source
}

/** The roles hosts sent on the resources they listed, by host, kind, and id. */
const listedRoles = new SvelteMap<string, ResourceRole>()
const asked = new Set<string>()

function keyOf(serverId: string, resource: Pick<ResourceRef, 'kind' | 'id'>): string {
  return `${serverId}|${resource.kind}|${resource.id}`
}

/**
 * Keep the role a host sent on each resource it listed (docs/plans/access-model.md
 * §2.7), for the questions that name a resource by its id alone, such as "may I
 * drive this session".
 */
export function rememberRoles(serverId: string, resources: readonly ResourceRef[]): void {
  for (const resource of resources) {
    const key = keyOf(serverId, resource)
    if (resource.role && listedRoles.get(key) !== resource.role) listedRoles.set(key, resource.role)
  }
}

/**
 * This client's role on one resource of one host. Reactive. The role the
 * resource carries comes first; then, for a kind that can be shared, the share
 * list the host answered, which follows every change to its ACL entries; then
 * the role the host sent when it listed the resource. A shared kind the client
 * knows nothing about asks the host for its share list once. Null until the
 * host answers.
 */
export function resourceRoleFor(serverId: string, resource: ResourceRef): ResourceRole | null {
  return resourceStandingFor(serverId, resource)?.role ?? null
}

/**
 * This client's standing on one resource: its role and, for a custom role, the
 * leaves it holds. A custom role's leaves come only with the resource or its share
 * list, so a listed custom role asks for the share list once.
 */
export function resourceStandingFor(serverId: string, resource: ResourceRef): ResourceStanding | null {
  if (resource.role && (resource.role !== 'custom' || resource.actions)) return { role: resource.role, actions: resource.actions }
  const listed = resource.role ?? listedRoles.get(keyOf(serverId, resource)) ?? null
  const kind = shareResourceKindSchema.safeParse(resource.kind)
  const source = shares
  if (!kind.success || !source) return listed ? { role: listed } : null
  const shared: ShareResource = { kind: kind.data, id: resource.id }
  const list = source.listFor(serverId, shared)
  if (list) return { role: list.callerRole, actions: list.callerActions }
  const key = keyOf(serverId, resource)
  if ((listed === null || listed === 'custom') && !asked.has(key)) {
    asked.add(key)
    queueMicrotask(() => { void source.load(serverId, shared) })
  }
  return listed ? { role: listed } : null
}

/**
 * Whether this client may do `action` on a resource, by the same tables the
 * host gates with (`ROLE_VERBS`, a custom role's leaves). Until the host answers,
 * the client may, as it does for its own resources; the host still refuses.
 */
export function resourceMay(serverId: string | null | undefined, resource: ResourceRef | null | undefined, action: ResourceActionPath): boolean {
  if (!serverId || !resource) return true
  const standing = resourceStandingFor(serverId, resource)
  return standing === null || standingAllows(standing, action)
}

/**
 * Whether this client may do one session leaf: `drive.prompt` (the default) to
 * prompt, stop, and change the queue; `drive.approve` to answer the agent's
 * cards; `drive.propose` to suggest. The question every composer and card asks.
 */
export function canDriveSession(serverId: string | null | undefined, sessionId: string | null | undefined, action: ResourceActionPath = 'drive.prompt'): boolean {
  return resourceMay(serverId, sessionId ? { kind: 'session', id: sessionId } : null, action)
}

/**
 * What one session's composer is for this client: `prompt` sends turns,
 * `suggest` sends suggestions that someone who may prompt decides
 * (docs/plans/custom-roles.md §7), `view` sends nothing.
 */
export type SessionComposerMode = 'prompt' | 'suggest' | 'view'

export function sessionComposerMode(serverId: string | null | undefined, sessionId: string | null | undefined): SessionComposerMode {
  if (canDriveSession(serverId, sessionId, 'drive.prompt')) return 'prompt'
  return canDriveSession(serverId, sessionId, 'drive.propose') ? 'suggest' : 'view'
}
