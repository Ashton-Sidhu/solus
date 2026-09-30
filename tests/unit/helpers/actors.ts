import type { Principal } from '@solus/server/admission/principal'
import { actorFor, type Actor } from '@solus/server/admission/actor'
import type { User } from '@solus/contracts/user'

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
