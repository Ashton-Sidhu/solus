import { SvelteMap } from 'svelte/reactivity'
import { roleAllows, type ResourceRef, type ResourceVerb } from '@solus/contracts/permissions'
import { shareResourceKindSchema, type ResourceRole, type ShareList, type ShareResource } from '@solus/contracts/sharing'

/** What the composer says to a member who may read a shared session but not drive it. */
export const VIEW_ONLY_REASON = 'Shared with you to view.'

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
  if (resource.role) return resource.role
  const listed = listedRoles.get(keyOf(serverId, resource)) ?? null
  const kind = shareResourceKindSchema.safeParse(resource.kind)
  const source = shares
  if (!kind.success || !source) return listed
  const shared: ShareResource = { kind: kind.data, id: resource.id }
  const list = source.listFor(serverId, shared)
  if (list) return list.callerRole
  const key = keyOf(serverId, resource)
  if (listed === null && !asked.has(key)) {
    asked.add(key)
    queueMicrotask(() => { void source.load(serverId, shared) })
  }
  return listed
}

/**
 * Whether this client may do `verb` on a resource, by the same role table the
 * host gates with (`ROLE_VERBS`). Until the host answers, the client may, as it
 * does for its own resources; the host still refuses.
 */
export function resourceMay(serverId: string | null | undefined, resource: ResourceRef | null | undefined, verb: ResourceVerb): boolean {
  if (!serverId || !resource) return true
  const role = resourceRoleFor(serverId, resource)
  return role === null || roleAllows(role, verb)
}

/** Whether this client may drive one session: prompt it, stop it, answer its cards. The question every composer and card asks. */
export function canDriveSession(serverId: string | null | undefined, sessionId: string | null | undefined): boolean {
  return resourceMay(serverId, sessionId ? { kind: 'session', id: sessionId } : null, 'drive')
}
