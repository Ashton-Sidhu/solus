import { parseUserKey, type UserId } from '@solus/contracts/user'
import type { Principal } from '../admission/principal'
import { createLogger } from '../logger'
import type { HostStanding } from './organizations'
import { isHostUserKey } from './host-user'

const log = createLogger('main', 'departed-members')

/**
 * Member removal on the host (plan 004 item 10). The host learns of it from its
 * organization standing: the control plane lists every current member of each
 * organization the machine is shared with, and the standing is read every few
 * minutes. Whoever is not in that list has left. The decision rests on the current
 * list, not on a change between two answers, so a removal made while the machine
 * was paused or restarting is still found.
 *
 * An organization without a list (an older control plane, or one the machine is not
 * shared with) removes nobody.
 */

/** Whether `userId` was a member of `organizationId` and is no longer. The host's own owner never leaves. */
export function hasLeftOrganization(standing: HostStanding | null, organizationId: string, userId: string): boolean {
  if (!standing || isHostUserKey(userId) || userId === standing.owner?.userId) return false
  const members = standing.organizations.find((entry) => entry.organizationId === organizationId)?.memberUserIds
  return members !== undefined && !members.includes(userId)
}

/** A socket admitted as a member of an organization that no longer lists them. */
export function isDepartedPrincipal(standing: HostStanding | null, principal: Principal): boolean {
  return principal.kind === 'org-member' && hasLeftOrganization(standing, principal.organizationId, principal.userId)
}

/**
 * The seat holders who are members of no organization the machine is shared with.
 * Only when every such organization sent its list: a seat is a person's login, and
 * a partial answer must not delete one.
 */
export function departedSeatUsers(standing: HostStanding | null, seatUserIds: readonly string[]): string[] {
  if (!standing) return []
  const shared = standing.organizations.filter((entry) => entry.shared)
  if (!shared.length || shared.some((entry) => !entry.memberUserIds)) return []
  const members = new Set(shared.flatMap((entry) => entry.memberUserIds ?? []))
  const owner = standing.owner?.userId
  return seatUserIds.filter((userId) => userId !== owner && !members.has(userId))
}

export interface DepartedMemberDeps {
  /** `memberUserIds` answers user keys; the host login is not among them. */
  seats: { memberUserIds(): string[]; remove(userId: UserId): Promise<number> }
  disconnectWhere: (predicate: (principal: Principal) => boolean, reason: string) => number
}

/** Removes the seats and ends the sockets of everyone the standing no longer lists. */
export async function removeDepartedMembers(standing: HostStanding | null, deps: DepartedMemberDeps): Promise<{ seatUserIds: string[]; socketsClosed: number }> {
  const socketsClosed = deps.disconnectWhere((principal) => isDepartedPrincipal(standing, principal), 'member-removed')
  const seatUserIds = departedSeatUsers(standing, deps.seats.memberUserIds())
  for (const userId of seatUserIds) await deps.seats.remove(parseUserKey(userId))
  if (socketsClosed || seatUserIds.length) log.info('departed_members_removed', { seatUserIds, socketsClosed })
  return { seatUserIds, socketsClosed }
}
