import { roleAllows, type ResourceVerb } from '@solus/contracts/permissions'
import type { ResourceRole, ShareList, ShareResource } from '@solus/contracts/sharing'

/** What the composer says to a member who may read a shared session but not drive it. */
export const VIEW_ONLY_REASON = 'Shared with you to view.'

/** The part of the shares store this reads. */
interface ResourceRoles {
  listFor(serverId: string, resource: ShareResource): ShareList | undefined
  load(serverId: string, resource: ShareResource): Promise<ShareList | null>
}

// The shares store hands itself over when it is created, rather than being
// imported here: the session reducer and the sidebar store ask this question,
// and importing the shares store would bring its toasts and network graph into
// both of them.
let shares: ResourceRoles | null = null

export function provideResourceRoles(source: ResourceRoles): void {
  shares = source
}

const asked = new Set<string>()

/**
 * This client's role on one resource of one host, from the share list the host
 * answered (docs/plans/permissions.md §2). Reactive: it reads the cached list and
 * asks the host for it once. Null until the host answers, and for a resource
 * that has no share list: this client's own.
 */
export function resourceRoleFor(serverId: string, resource: ShareResource): ResourceRole | null {
  const source = shares
  if (!source) return null
  const list = source.listFor(serverId, resource)
  const key = `${serverId}|${resource.kind}|${resource.id}`
  if (!list && !asked.has(key)) {
    asked.add(key)
    queueMicrotask(() => { void source.load(serverId, resource) })
  }
  return list?.callerRole ?? null
}

/**
 * Whether this client may do `verb` on a resource, by the same role table the host
 * gates with (`ROLE_VERBS`). Until the host answers, the client may, as it does
 * for its own resources; the host still refuses.
 */
export function resourceMay(serverId: string | null | undefined, resource: ShareResource | null | undefined, verb: ResourceVerb): boolean {
  if (!serverId || !resource) return true
  const role = resourceRoleFor(serverId, resource)
  return role === null || roleAllows(role, verb)
}

/** Whether this client may drive one session: prompt it, stop it, answer its cards. The question every composer and card asks. */
export function canDriveSession(serverId: string | null | undefined, sessionId: string | null | undefined): boolean {
  return resourceMay(serverId, sessionId ? { kind: 'session', id: sessionId } : null, 'drive')
}
