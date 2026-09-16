import type { OrganizationDirectory, UplinkStatus } from '@solus/contracts/uplink'
import { guestLinkFragment, HOST_OWNER_USER_ID, type ShareGrant, type ShareList, type ShareNamedSubject, type ShareRole, type ShareSetRequest } from '@solus/contracts/sharing'

/**
 * The share dialog's view model (docs/plans/multiplayer-sharing.md §4.1): rows the
 * person reads, and the next grant list a change produces. Pure, so the rules that
 * decide who is listed and how a row is named can be tested without a host.
 */

export interface ShareRow {
  key: string
  subject: ShareNamedSubject
  role: ShareRole
  /** How the row is named: a person, a team, or the organization. */
  name: string
  /** A second line: an email for a person, a member count for a team. */
  detail: string
}

export interface ShareCandidate {
  key: string
  subject: ShareNamedSubject
  name: string
  detail: string
  group: 'People' | 'Teams' | 'Organization'
}

/** How a subject is named on a row: the name, and a second line under it. */
export interface SubjectLabel {
  name: string
  detail: string
}

/** What the badge says about a list. */
export interface ShareSummary {
  count: number
  hasLink: boolean
}

export function subjectKey(subject: ShareNamedSubject): string {
  return `${subject.kind}:${subject.id}`
}

/** How a person or a team is named; an id nobody in the directory matches is shown as such. */
export function subjectName(subject: ShareNamedSubject, directory: OrganizationDirectory | null): SubjectLabel {
  switch (subject.kind) {
    case 'user': {
      const member = directory?.members.find((entry) => entry.userId === subject.id)
      return member ? { name: member.name, detail: member.email ?? '' } : { name: 'Former member', detail: subject.id }
    }
    case 'team': {
      const team = directory?.teams.find((entry) => entry.teamId === subject.id)
      return team
        ? { name: team.name, detail: `Team · ${team.memberUserIds.length} ${team.memberUserIds.length === 1 ? 'person' : 'people'}` }
        : { name: 'Team', detail: subject.id }
    }
    case 'organization':
      return { name: directory?.name ?? 'Everyone in the organization', detail: 'Organization' }
  }
}

/** The owner's name for the pinned first row. */
export function ownerName(ownerUserId: string, directory: OrganizationDirectory | null, selfUserId: string | null): string {
  if (ownerUserId === HOST_OWNER_USER_ID) return 'Host owner'
  if (selfUserId && ownerUserId === selfUserId) return 'You'
  return directory?.members.find((entry) => entry.userId === ownerUserId)?.name ?? 'Former member'
}

export function shareRows(list: ShareList, directory: OrganizationDirectory | null): ShareRow[] {
  return list.grants.map((grant) => ({
    key: subjectKey(grant.subject),
    subject: grant.subject,
    role: grant.role,
    ...subjectName(grant.subject, directory),
  }))
}

/** Everyone in the directory who is not already on the list and is not the owner. */
export function shareCandidates(list: ShareList, directory: OrganizationDirectory | null, query: string): ShareCandidate[] {
  if (!directory) return []
  const taken = new Set(list.grants.map((grant) => subjectKey(grant.subject)))
  const needle = query.trim().toLowerCase()
  const matches = (...values: string[]) => !needle || values.some((value) => value.toLowerCase().includes(needle))
  const candidates: ShareCandidate[] = []
  for (const member of directory.members) {
    const subject: ShareNamedSubject = { kind: 'user', id: member.userId }
    if (member.userId === list.ownerUserId || taken.has(subjectKey(subject))) continue
    if (!matches(member.name, member.email ?? '')) continue
    candidates.push({ key: subjectKey(subject), subject, name: member.name, detail: member.email ?? '', group: 'People' })
  }
  for (const team of directory.teams) {
    const subject: ShareNamedSubject = { kind: 'team', id: team.teamId }
    if (taken.has(subjectKey(subject)) || !matches(team.name)) continue
    candidates.push({ key: subjectKey(subject), subject, name: team.name, detail: `${team.memberUserIds.length} people`, group: 'Teams' })
  }
  const organization: ShareNamedSubject = { kind: 'organization', id: directory.organizationId }
  if (!taken.has(subjectKey(organization)) && matches(directory.name, 'everyone', 'organization')) {
    candidates.push({ key: subjectKey(organization), subject: organization, name: `Everyone in ${directory.name}`, detail: 'Organization', group: 'Organization' })
  }
  return candidates
}

/** The whole list with one subject set to a role (added when absent). */
export function withRole(list: ShareList, subject: ShareNamedSubject, role: ShareRole): ShareSetRequest {
  const key = subjectKey(subject)
  const grants: ShareSetRequest['grants'] = list.grants
    .filter((grant) => subjectKey(grant.subject) !== key)
    .map((grant) => ({ subject: grant.subject, role: grant.role }))
  grants.push({ subject, role })
  return { resource: list.resource, grants }
}

/** The whole list without one subject. */
export function withoutSubject(list: ShareList, subject: ShareNamedSubject): ShareSetRequest {
  const key = subjectKey(subject)
  return {
    resource: list.resource,
    grants: list.grants.filter((grant) => subjectKey(grant.subject) !== key).map((grant) => ({ subject: grant.subject, role: grant.role })),
  }
}

/** The guest link (§4.2): the secret rides the fragment, so the cloud server never sees it. */
export function guestLinkUrl(directoryUrl: string, hostId: string, secret: string): string {
  return `${directoryUrl.replace(/\/$/, '')}/app/${guestLinkFragment(hostId, secret)}`
}

/**
 * Whether a guest link can be built for a host: it needs the host id and the
 * account origin the host is listed under. `checking` until the host has
 * answered `uplinkStatus`; `unlinked` when it answered that it is not in Solus
 * cloud and no saved row knows better.
 */
export type GuestLinkContext =
  | { kind: 'checking' }
  | { kind: 'unlinked' }
  | { kind: 'linked'; hostId: string; directoryUrl: string }

export function guestLinkContext(
  status: UplinkStatus | undefined,
  saved: { hostId: string; directoryUrl: string } | undefined,
): GuestLinkContext {
  if (status?.linked) return { kind: 'linked', hostId: status.link.hostId, directoryUrl: status.link.directoryUrl }
  if (saved) return { kind: 'linked', ...saved }
  return status ? { kind: 'unlinked' } : { kind: 'checking' }
}

/**
 * What the dialog shows for the link: the full guest URL when the host is linked
 * to Solus cloud, the bare secret when it is not, `unavailable` for a link the host
 * kept no secret for (made before it did; regenerate), and nothing for a viewer,
 * who only sees that a link exists.
 */
export type LinkPresentation =
  | { kind: 'url'; url: string }
  | { kind: 'secret'; secret: string }
  | { kind: 'checking' }
  | { kind: 'unavailable' }
  | { kind: 'hidden' }

export function linkPresentation(link: ShareList['link'], context: GuestLinkContext, canShare: boolean): LinkPresentation | null {
  if (!link) return null
  if (!canShare) return { kind: 'hidden' }
  if (!link.secret) return { kind: 'unavailable' }
  switch (context.kind) {
    case 'linked': return { kind: 'url', url: guestLinkUrl(context.directoryUrl, context.hostId, link.secret) }
    case 'checking': return { kind: 'checking' }
    case 'unlinked': return { kind: 'secret', secret: link.secret }
  }
}

/** One line for the badge: how many rows, and whether a link exists. */
export function shareSummary(list: ShareList | undefined): ShareSummary {
  if (!list) return { count: 0, hasLink: false }
  return { count: list.grants.length + (list.link ? 1 : 0), hasLink: list.link !== null }
}

export type { ShareGrant }
