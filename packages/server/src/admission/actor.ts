import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import { parseUserKey, userKey, type Attribution, type User, type UserId } from '@solus/contracts/user'
import type { AgentId } from '@solus/contracts/types'
import { INTERNAL_PRINCIPAL, type Principal } from './principal'
import { hostCategory } from '../host/host-category'
import { hostUser, hostUserKey, isHostUserKey } from '../host/host-user'
import { isApiMode } from '../host/api-mode'
import { withCredentialScope } from '../vault/credential-scope'

/**
 * Who a request or a turn is for (plans/012-user-actor-and-activity.md §4): the
 * user, with the principal that admitted them. `SolusServer.handle()` resolves it
 * once per RPC, so handlers and runtime methods never convert a principal.
 */
export interface Actor {
  principal: Principal
  /** Null only for the host's own work: the host itself, and a runner. */
  user: User | null
}

/** The host acting for itself: automations, agent tools, internal calls. */
export const HOST_ACTOR: Actor = { principal: INTERNAL_PRINCIPAL, user: null }

/**
 * The actor behind a principal. The host's owner, local or over the tunnel, is
 * the host's user: its `local` id, or its account once the host is linked
 * (`host-user.ts` follows the link). A member is their account; a guest is their
 * guest id. A runner and the host itself are nobody.
 */
export function actorFor(principal: Principal): Actor {
  return { principal, user: userFor(principal) }
}

function userFor(principal: Principal): User | null {
  switch (principal.kind) {
    case 'local-owner':
      return hostUser()
    case 'remote-owner': {
      const host = hostUser()
      // A linked host always has its user; the fallback is for a host with no settings.
      const user: User = host ? { ...host } : { id: { kind: 'account', accountId: principal.userId }, displayName: principal.displayName ?? principal.userId }
      if (principal.displayName) user.displayName = principal.displayName
      return user
    }
    case 'org-member': {
      const user: User = { id: { kind: 'account', accountId: principal.userId }, displayName: principal.displayName }
      if (principal.email) user.email = principal.email
      if (principal.avatarUrl) user.avatarUrl = principal.avatarUrl
      return user
    }
    case 'guest':
      return { id: { kind: 'guest', guestId: principal.guestId }, displayName: principal.displayName }
    case 'runner':
    case 'system':
      return null
  }
}

/**
 * The user key a record this actor makes is owned under, and a grant they give
 * names (§4): their user's. The host's owner on a host with no user yet (the
 * Solus API, tests) is the host's key. Null for the host itself and a runner,
 * which own nothing.
 */
export function ownerKeyOf(actor: Actor): string | null {
  if (actor.user) return userKey(actor.user.id)
  const kind = actor.principal.kind
  return kind === 'local-owner' || kind === 'remote-owner' ? hostUserKey() : null
}

/**
 * Who did something for this actor (§2): the user, or the host itself. Work done
 * through an agent's turn or an automation names it, and the person it was for.
 */
export function attributionOf(actor: Actor, via?: { sessionId: string; provider?: AgentId } | { automationId: string; name?: string }): Attribution {
  if (via && 'sessionId' in via) {
    const agent: Attribution = { kind: 'agent', sessionId: via.sessionId }
    if (via.provider) agent.provider = via.provider
    if (actor.user) agent.for = actor.user
    return agent
  }
  if (via) {
    const automation: Attribution = { kind: 'automation', automationId: via.automationId }
    if (via.name) automation.name = via.name
    if (actor.user) automation.for = actor.user
    return automation
  }
  return actor.user ? { kind: 'user', user: actor.user } : { kind: 'system' }
}

/**
 * Whose seat an actor's turn runs on (§3). The owner, linked or not, runs on the
 * host login; a member on their own seat; a guest on the seat of whoever shared
 * the link, which is the host login when the host's user shared it.
 */
export function seatFor(actor: Actor): Seat {
  const principal = actor.principal
  switch (principal.kind) {
    case 'org-member':
      return { kind: 'user', userId: { kind: 'account', accountId: principal.userId } }
    case 'guest': {
      const sharer = principal.share.sharedByUserId
      return isHostUserKey(sharer) ? HOST_LOGIN_SEAT : { kind: 'user', userId: parseUserKey(sharer) }
    }
    case 'local-owner':
    case 'remote-owner':
    case 'runner':
    case 'system':
      return HOST_LOGIN_SEAT
  }
}

/**
 * Whose account connections an actor's call uses; null means the host's own
 * store. The owner of a personal host connects GitHub, Google, and Atlassian on
 * that host, signed in or not. Account connections are for cloud-managed hosts
 * (managed hosts and the Solus API) and for people who do not own the host.
 */
export function credentialUserFor(actor: Actor): UserId | null {
  const principal = actor.principal
  switch (principal.kind) {
    case 'local-owner': return null
    case 'remote-owner': return isApiMode() || hostCategory() === 'managed' ? { kind: 'account', accountId: principal.userId } : null
    case 'org-member': return { kind: 'account', accountId: principal.userId }
    case 'guest': return principal.accountUserId ? { kind: 'account', accountId: principal.accountUserId } : parseUserKey(principal.share.sharedByUserId)
    case 'runner':
    case 'system': return null
  }
}

/** Runs `fn` with the actor's account connections in scope (`credential-scope.ts`). */
export function withActorCredentials<T>(actor: Actor, fn: () => T): T {
  const user = credentialUserFor(actor)
  return withCredentialScope(user ? userKey(user) : null, fn)
}

/**
 * The account a turn is attributed to in Insights (organization-scope §6.1): the
 * actor's own account, and for the host's own admitted work the account that
 * linked the host. Null where no account is known, and for a turn with no actor.
 */
export function insightsAccountOf(actor: Actor | undefined): User | null {
  if (!actor) return null
  const user = actor.user ?? (actor.principal.kind === 'system' ? hostUser() : null)
  return user?.id.kind === 'account' ? user : null
}
