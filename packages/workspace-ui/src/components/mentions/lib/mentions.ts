import { parseUserKey, userKey, type User } from '@solus/contracts/user'
import type { ShareList, ShareResource } from '@solus/contracts/sharing'
import type { PersonMention } from '@solus/contracts/mentions'
import type { PlanComment } from '@solus/contracts/types'
import { memberByKey, type OrganizationPeople } from '../../users/lib/organization-people'

/**
 * Mentions of organization members (plans/004-shared-host-collaboration.md
 * item 13). The rules live here, free of stores, so they can be tested alone.
 */

/** The record a composer writes on, as the mention picker needs it. */
export interface MentionScope {
  serverId: string
  /** The record's canonical organization: `local` while it has none (D17). */
  organizationId: string
  resource: ShareResource
  /** What the Share action names in its dialog. */
  title: string
  /** People who wrote on the record, newest first: they lead the picker. */
  recentUserIds: readonly string[]
}

/** What a reader knows about a mentioned person now. */
export type PersonStanding =
  | { kind: 'member'; user: User }
  /** The directory was read and no longer lists them. */
  | { kind: 'left' }
  /** No directory yet: show the saved name as it was. */
  | { kind: 'unknown' }

/** A Local record has no organization, so it has no one to mention. */
export function hasOrganization(scope: MentionScope | null): scope is MentionScope {
  return !!scope && scope.organizationId !== 'local'
}

/**
 * The directory of the record's own organization, or null when there is none
 * to read: a Local record, a directory not loaded yet, or a directory of
 * another organization than the one the record belongs to.
 */
export function scopeDirectory(
  scope: MentionScope | null,
  directory: OrganizationPeople | null | undefined,
): OrganizationPeople | null {
  if (!hasOrganization(scope) || !directory) return null
  return directory.organizationId === scope.organizationId ? directory : null
}

export function personStanding(userId: string, directory: OrganizationPeople | null): PersonStanding {
  if (!directory) return { kind: 'unknown' }
  const member = memberByKey(directory, userId)
  return member ? { kind: 'member', user: member } : { kind: 'left' }
}

/** The name a reader sees for a mention: the member's current name, else the saved one. */
export function mentionLabel(mention: PersonMention, standing: PersonStanding): string {
  return `@${standing.kind === 'member' ? standing.user.displayName : mention.name}`
}

/**
 * The user a mention draws as a chip: the member as the directory names them
 * now, or the saved name while the directory is not read. Null for a person who
 * left the organization: they are the saved name as plain text, with no chip.
 */
export function mentionUser(mention: PersonMention, standing: PersonStanding): User | null {
  if (standing.kind === 'left') return null
  if (standing.kind === 'member') return standing.user
  return { id: parseUserKey(mention.userId), displayName: mention.name }
}

/**
 * Members the picker offers, best first: people who wrote on the record, most
 * recent first, then everyone else by name. Teams are not mentionable. A query
 * matches the start of any word of the name, or the start of the email.
 */
export function mentionCandidates(
  directory: OrganizationPeople | null,
  recentUserIds: readonly string[],
  query: string,
): User[] {
  if (!directory) return []
  const needle = query.trim().toLowerCase()
  const recency = new Map(recentUserIds.map((userId, index) => [userId, index]))
  return directory.members
    .filter((member) => !needle || matchesMember(member, needle))
    .sort((left, right) => {
      const leftRank = recency.get(userKey(left.id)) ?? Number.POSITIVE_INFINITY
      const rightRank = recency.get(userKey(right.id)) ?? Number.POSITIVE_INFINITY
      if (leftRank !== rightRank) return leftRank - rightRank
      return left.displayName.localeCompare(right.displayName)
    })
}

function matchesMember(member: User, needle: string): boolean {
  const name = member.displayName.toLowerCase()
  if (name.startsWith(needle)) return true
  if (name.split(/\s+/).some((word) => word.startsWith(needle))) return true
  return !!member.email?.toLowerCase().startsWith(needle)
}

/**
 * The query of an `@` mention the caret is in: `@` at the start of the line or
 * after whitespace, then up to 40 characters with no second `@` and no link
 * syntax. A name has spaces, so the query may too once it has begun.
 */
export function mentionQuery(textBeforeCursor: string): string | null {
  const match = /(?:^|\s)@([^\s@[\]()][^@[\]()\n]{0,39})?$/.exec(textBeforeCursor)
  return match ? (match[1] ?? '') : null
}

/**
 * Whether a person can open the record, from its share list and the lists of
 * the tasks it inherits from (share-manager `roleFor`): its owner, a row for
 * them, a row for a team they are in, or a row for the organization when they
 * are its member. A link does not count: the person does not hold its secret.
 * Null while the answer is not known, so no warning is shown on a guess.
 */
export function personCanOpen(
  userId: string,
  lists: readonly (ShareList | undefined)[],
  directory: OrganizationPeople | null,
): boolean | null {
  if (!directory || lists.length === 0 || lists.some((list) => !list)) return null
  const teamIds = new Set(directory.teams.filter((team) => team.memberUserIds.includes(userId)).map((team) => team.teamId))
  const isMember = !!memberByKey(directory, userId)
  return lists.some((list) =>
    list!.ownerUserId === userId || list!.grants.some(({ subject }) =>
      (subject.kind === 'user' && subject.id === userId)
      || (subject.kind === 'team' && teamIds.has(subject.id))
      || (subject.kind === 'organization' && isMember && subject.id === directory.organizationId)))
}

/** The people who wrote a work's threads and replies, newest first. */
export function recentCommentAuthors(comments: readonly PlanComment[]): string[] {
  const written: { userId: string; at: number }[] = []
  for (const comment of comments) {
    if (comment.author?.kind === 'user') written.push({ userId: userKey(comment.author.user.id), at: comment.createdAt ?? 0 })
    for (const reply of comment.replies ?? []) {
      if (reply.author?.kind === 'user') written.push({ userId: userKey(reply.author.user.id), at: reply.createdAt })
    }
  }
  written.sort((left, right) => right.at - left.at)
  return [...new Set(written.map((entry) => entry.userId))]
}
