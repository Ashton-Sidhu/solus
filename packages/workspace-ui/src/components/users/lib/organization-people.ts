import type { DirectoryMember, DirectoryTeam, OrganizationDirectory } from '@solus/contracts/uplink'
import { userKey, type User } from '@solus/contracts/user'

/**
 * An organization's people as the client reads them (plans/012 §6): one member
 * list of `User`s, which the mention picker, the share dialog and every other
 * people choice read. The account plane's directory is converted once, where
 * `sharesStore` loads it. The teams and the organization's name come with it:
 * the share dialog offers them as scopes, and the access check reads the teams.
 */
export interface OrganizationPeople {
  organizationId: string
  name: string
  members: User[]
  teams: DirectoryTeam[]
}

/** A directory member is a Solus account. */
export function memberUser(member: DirectoryMember): User {
  const user: User = { id: { kind: 'account', accountId: member.userId }, displayName: member.name }
  if (member.email) user.email = member.email
  if (member.image) user.avatarUrl = member.image
  return user
}

export function organizationPeople(directory: OrganizationDirectory): OrganizationPeople {
  return {
    organizationId: directory.organizationId,
    name: directory.name,
    members: directory.members.map(memberUser),
    teams: directory.teams,
  }
}

/** The member whose user key this is, if the organization still lists them. */
export function memberByKey(people: OrganizationPeople | null, key: string): User | undefined {
  return people?.members.find((member) => userKey(member.id) === key)
}
