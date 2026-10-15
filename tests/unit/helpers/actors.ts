import { isAnyOrganization, type Principal, type RecordScope } from '@solus/server/admission/principal'
import { actorFor, type Actor } from '@solus/server/admission/actor'
import type { NotificationReader } from '@solus/server/data/notifications/store'
import { parseUserKey, type User } from '@solus/contracts/user'

/** A person with a Solus account, as the wire carries them (plans/012 §1). */
export function accountUser(accountId: string, displayName: string, extra: Pick<User, 'avatarUrl' | 'email'> = {}): User {
  return { id: { kind: 'account', accountId }, displayName, ...extra }
}

/** An organization member's principal on a managed host. */
export function memberPrincipal(userId: string, displayName: string, extra: Partial<Extract<Principal, { kind: 'org-member' }>> = {}): Extract<Principal, { kind: 'org-member' }> {
  return { kind: 'org-member', userId, organizationId: 'org-1', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName, deviceId: `device-${userId}`, expiresAt: Date.now() + 60_000, deviceLabel: 'Solus cloud', ...extra }
}

/** The actor `SolusServer.handle()` resolves for a member. */
export function memberActor(userId: string, displayName: string, extra: Partial<Extract<Principal, { kind: 'org-member' }>> = {}): Actor {
  return actorFor(memberPrincipal(userId, displayName, extra))
}

/** A handler context as `SolusServer.handle()` passes it: the caller's context with its actor resolved. */
export function withActor<T extends { principal: Principal }>(ctx: T): T & { actor: Actor } {
  return { ...ctx, actor: actorFor(ctx.principal) }
}

/**
 * The notification reader of the person `recipientKey` names, reading in `scope`:
 * a member of that organization, or a remote host owner for every organization.
 */
export function notificationReader(recipientKey: string, scope: RecordScope = 'org1'): NotificationReader {
  const principal: Principal = isAnyOrganization(scope)
    ? { kind: 'remote-owner', userId: recipientKey, deviceId: 'd', expiresAt: 0, deviceLabel: 'test' }
    : memberPrincipal(recipientKey, recipientKey, { organizationId: scope })
  return { actor: { principal, user: { id: parseUserKey(recipientKey), displayName: recipientKey } } }
}
