import type { ResourceRole, ShareList, ShareResource } from '@solus/contracts/sharing'

/** What the composer says to a member who may read a shared session but not drive it. */
export const VIEW_ONLY_REASON = 'Shared with you to view.'

/**
 * Whether a role may drive a session: prompt it, stop it, answer its cards,
 * decide its plan, and change its title, links, and state. The host requires
 * `editor` for every one of those (admission/access-policy.ts), so a viewer or
 * a commenter who is offered them is only refused. No role means no share list:
 * the session is this client's own.
 */
export function roleCanDrive(role: ResourceRole | null | undefined): boolean {
  return role == null || role === 'editor' || role === 'owner'
}

/** The part of the shares store this check reads. */
interface ShareRoles {
  isHostLinked(serverId: string): boolean
  listFor(serverId: string, resource: ShareResource): ShareList | undefined
  load(serverId: string, resource: ShareResource): Promise<ShareList | null>
}

// The shares store hands itself over when it is created, rather than being
// imported here: the session reducer and the sidebar store ask this question,
// and importing the shares store would bring its toasts and network graph into
// both of them.
let shares: ShareRoles | null = null

export function provideShareRoles(source: ShareRoles): void {
  shares = source
}

const asked = new Set<string>()

/**
 * Whether this client may drive one session on one host. Reactive: it reads the
 * cached share list and asks the host for it once. A host not linked to Solus
 * cloud shares nothing, so it is never asked. Until the host answers, the client
 * drives, as it does for its own sessions; the host still refuses.
 */
export function canDriveSession(serverId: string | null | undefined, sessionId: string | null | undefined): boolean {
  const source = shares
  if (!source || !serverId || !sessionId || !source.isHostLinked(serverId)) return true
  const resource = { kind: 'session', id: sessionId } as const
  const list = source.listFor(serverId, resource)
  const key = `${serverId}|${sessionId}`
  if (!list && !asked.has(key)) {
    asked.add(key)
    queueMicrotask(() => { void source.load(serverId, resource) })
  }
  return roleCanDrive(list?.callerRole)
}
