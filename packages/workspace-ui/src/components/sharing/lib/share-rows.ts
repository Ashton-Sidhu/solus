import { cloudShareUrl, isGuestLinkResource, type ShareList, type ShareRole, type ShareSetRequest } from '@solus/contracts/sharing'
import { parseUserKey, userKey, type User } from '@solus/contracts/user'
import { memberByKey, type OrganizationPeople } from '../../users/lib/organization-people'

/**
 * The share dialog's view model (docs/plans/multiplayer-sharing.md §4.1): the
 * people invited by name, one choice for general access — who else can open the
 * resource — and the link. Pure, so the rule that turns a share list into a scope
 * and a scope back into rows is tested without a host.
 */

/**
 * General access: who can open a resource without being named, widest last, and
 * what they may do there. Scopes nest — the organization holds every team, and
 * the link holds the organization — so choosing a wider one never takes the
 * resource from a narrower group. The link scope keeps the organization on the
 * list, so a teammate still finds the resource in their sidebar instead of
 * arriving through the guest door. People named on the list keep their own rows
 * whatever the scope.
 */
export type ShareScope =
  | { kind: 'private' }
  | { kind: 'team'; teamId: string; role: ShareRole }
  | { kind: 'organization'; organizationId: string; role: ShareRole }
  | { kind: 'link'; role: ShareRole }

/** The scope without its role: which row of the choice is on. */
export function scopeKey(scope: ShareScope): string {
  switch (scope.kind) {
    case 'private': return 'private'
    case 'team': return `team:${scope.teamId}`
    case 'organization': return `organization:${scope.organizationId}`
    case 'link': return 'link'
  }
}

export function scopeRole(scope: ShareScope): ShareRole | null {
  return scope.kind === 'private' ? null : scope.role
}

export function sameScope(a: ShareScope, b: ShareScope): boolean {
  return scopeKey(a) === scopeKey(b) && scopeRole(a) === scopeRole(b)
}

/** The scope a list stands for: the link if there is one, else the widest named row, with its role. */
export function scopeOf(list: ShareList): ShareScope {
  if (list.link) return { kind: 'link', role: list.link.role }
  const organization = list.entries.find((entry) => entry.subject.kind === 'organization')
  if (organization?.subject.kind === 'organization') return { kind: 'organization', organizationId: organization.subject.id, role: organization.role }
  const team = list.entries.find((entry) => entry.subject.kind === 'team')
  if (team?.subject.kind === 'team') return { kind: 'team', teamId: team.subject.id, role: team.role }
  return { kind: 'private' }
}

/**
 * What Copy link copies: the link of the scope the list already has, never a
 * wider one. Copying does not change who can open the resource; only the access
 * choice does. With the link scope it is the guest link; with any other scope it
 * is the app's own address, which each person opens with their own sign-in, so
 * only the people with access get in. Null when there is nothing to copy yet.
 */
export type LinkToCopy = { kind: 'guest'; text: string } | { kind: 'member'; text: string }

export function linkToCopy(list: ShareList, guestLink: LinkPresentation | null, memberLink: string | null): LinkToCopy | null {
  if (list.link) {
    return guestLink?.kind === 'url' ? { kind: 'guest', text: guestLink.url } : null
  }
  return memberLink ? { kind: 'member', text: memberLink } : null
}

/** One row of the dialog's choice. `role` is the row's current role when it is on, else the role it would start with. */
export interface ScopeOption {
  key: string
  scope: ShareScope
  name: string
  detail: string
  role: ShareRole | null
  /** Why this row cannot be chosen here, when it cannot: the host would refuse it. */
  unavailable?: string
}

/** What the dialog says on a team or organization row of a host members cannot reach (host-sharing.md §4.3). */
export const MEMBERS_CANNOT_REACH_ROW = 'Link this computer so members can reach it'

const can = (role: ShareRole) => (role === 'editor' ? 'edit' : role === 'commenter' ? 'comment' : 'view')

/** A row's words for its role: `detail(role)` is the line under the name. */
function option(scope: ShareScope, name: string, detail: (role: ShareRole) => string, currentRole: ShareRole | null, startRole: ShareRole): ScopeOption {
  const role = currentRole ?? startRole
  const withRole: ShareScope = scope.kind === 'private' ? scope : { ...scope, role }
  return { key: scopeKey(scope), scope: withRole, name, detail: detail(role), role: scope.kind === 'private' ? null : role }
}

/**
 * The choices a list offers: only the owner, each team of the organization, the
 * organization, and the link. A team or organization the directory does not name
 * (no account here, or an older row) is still offered when it is the current
 * scope, so the dialog never shows a choice with nothing selected. A row that is
 * not on starts people as editors, and the link as viewers, so the guest door
 * never runs a turn unless someone asks it to.
 */
export function scopeOptions(list: ShareList, directory: OrganizationPeople | null, organizationId: string | null, ownerLabel: string, reach: { membersReachable: boolean } = { membersReachable: true }): ScopeOption[] {
  const current = scopeOf(list)
  /** A team or organization row on a host members cannot reach: shown, so the choice reads whole, but not to be chosen. */
  const named = (option: ScopeOption): ScopeOption => (reach.membersReachable ? option : { ...option, unavailable: MEMBERS_CANNOT_REACH_ROW })
  const roleIfCurrent = (scope: ShareScope) => (scopeKey(scope) === scopeKey(current) ? scopeRole(current) : null)
  const options: ScopeOption[] = [
    { key: 'private', scope: { kind: 'private' }, name: `Only ${ownerLabel}`, detail: 'Nobody else can open it', role: null },
  ]
  // The detail names the kind of thing, not the thing again: an organization and a
  // team can share a name, and then only "Team" and "Organization" tell them apart.
  const teams = directory?.teams ?? []
  for (const team of teams) {
    const scope: ShareScope = { kind: 'team', teamId: team.teamId, role: 'editor' }
    const count = team.memberUserIds.length
    options.push(named(option(scope, team.name, (role) => `Team · ${count} ${count === 1 ? 'person' : 'people'} can ${can(role)}`, roleIfCurrent(scope), 'editor')))
  }
  if (current.kind === 'team' && !teams.some((team) => team.teamId === current.teamId)) {
    options.push(named(option(current, 'A team', (role) => `Team · everyone in it can ${can(role)}`, current.role, 'editor')))
  }
  const organizationName = directory?.name
  const knownOrganizationId = directory?.organizationId ?? organizationId ?? (current.kind === 'organization' ? current.organizationId : null)
  if (knownOrganizationId) {
    const scope: ShareScope = { kind: 'organization', organizationId: knownOrganizationId, role: 'editor' }
    options.push(named(option(
      scope,
      organizationName ? `Everyone in ${organizationName}` : 'Everyone in the organization',
      (role) => `Organization · everyone in it can ${can(role)}`,
      roleIfCurrent(scope),
      'editor',
    )))
  }
  options.push(option({ kind: 'link', role: 'viewer' }, 'Anyone with the link', (role) => `Anyone on the internet with the link can ${can(role)}`, roleIfCurrent({ kind: 'link', role: 'viewer' }), 'viewer'))
  return options
}

/**
 * The one write a scope stands for: its rows, with the people named on the list
 * kept as they are, and the link when the scope changes it.
 */
export function scopeRequestFor(scope: ShareScope, list: ShareList, organizationId: string | null): ShareSetRequest {
  const entries: ShareSetRequest['entries'] = list.entries
    .filter((entry) => entry.subject.kind === 'user')
    .map((entry) => ({ subject: entry.subject, role: entry.role }))
  switch (scope.kind) {
    case 'private':
      break
    case 'team':
      entries.push({ subject: { kind: 'team', id: scope.teamId }, role: scope.role })
      break
    case 'organization':
      entries.push({ subject: { kind: 'organization', id: scope.organizationId }, role: scope.role })
      break
    case 'link': {
      // The link is the widest scope: the organization, when there is one, stays on
      // the list with the role it has; one it never had starts with the link's.
      const existing = list.entries.find((entry) => entry.subject.kind === 'organization')
      if (existing?.subject.kind === 'organization') entries.push({ subject: existing.subject, role: existing.role })
      else if (organizationId) entries.push({ subject: { kind: 'organization', id: organizationId }, role: scope.role })
      break
    }
  }
  const request: ShareSetRequest = { resource: list.resource, entries }
  const linkRole = scope.kind === 'link' ? scope.role : null
  if (linkRole !== (list.link?.role ?? null)) request.link = { role: linkRole }
  return request
}

/** Who "Only …" names: the reader when they own it, else the owner by name. */
export function ownerLabel(list: Pick<ShareList, 'ownerKey' | 'callerRole'>, directory: OrganizationPeople | null): string {
  if (list.callerRole === 'owner') return 'you'
  return memberByKey(directory, list.ownerKey)?.displayName ?? 'the owner'
}

// ── People named on the list ────────────────────────────────────────────────

/** One person on the list: the owner first, then everyone invited by name. */
export interface PersonRow {
  /** The user key the list names them by. */
  userId: string
  user: User
  /** An email under the name; empty when the directory has none. */
  detail: string
  role: ShareRole | 'owner'
  isSelf: boolean
}

/** A person the list names but the directory no longer lists. */
function formerMember(key: string): User {
  return { id: parseUserKey(key), displayName: 'Former member' }
}

/**
 * The owner, then the people with a row of their own, named from the directory.
 * The reader's own row takes the name their host gave them (plans/012 §1), so the
 * owner of a host with no account reads as themselves.
 */
export function personRows(list: ShareList, directory: OrganizationPeople | null, self: User | null): PersonRow[] {
  const selfUserId = self ? userKey(self.id) : null
  const ownerMember = memberByKey(directory, list.ownerKey)
  const ownerIsSelf = list.callerRole === 'owner'
  const rows: PersonRow[] = [{
    userId: list.ownerKey,
    user: ownerMember ?? (ownerIsSelf && self ? self : formerMember(list.ownerKey)),
    detail: ownerMember?.email ?? '',
    role: 'owner',
    isSelf: ownerIsSelf,
  }]
  for (const entry of list.entries) {
    if (entry.subject.kind !== 'user') continue
    const member = memberByKey(directory, entry.subject.id)
    rows.push({
      userId: entry.subject.id,
      user: member ?? formerMember(entry.subject.id),
      detail: member?.email ?? '',
      role: entry.role,
      isSelf: selfUserId !== null && entry.subject.id === selfUserId,
    })
  }
  return rows
}

/** Everyone in the directory who is not the owner and not yet on the list, narrowed by the search. */
export function personCandidates(list: ShareList, directory: OrganizationPeople | null, query: string): User[] {
  if (!directory) return []
  const taken = new Set(list.entries.flatMap((entry) => (entry.subject.kind === 'user' ? [entry.subject.id] : [])))
  const needle = query.trim().toLowerCase()
  return directory.members.filter((member) => {
    const key = userKey(member.id)
    if (key === list.ownerKey || taken.has(key)) return false
    return !needle || member.displayName.toLowerCase().includes(needle) || (member.email ?? '').toLowerCase().includes(needle)
  })
}

/** The whole list with one person set to a role (added when absent); every other row stays. */
export function withPersonRole(list: ShareList, userId: string, role: ShareRole): ShareSetRequest {
  const entries: ShareSetRequest['entries'] = list.entries
    .filter((entry) => !(entry.subject.kind === 'user' && entry.subject.id === userId))
    .map((entry) => ({ subject: entry.subject, role: entry.role }))
  entries.push({ subject: { kind: 'user', id: userId }, role })
  return { resource: list.resource, entries }
}

/** The whole list without one person. */
export function withoutPerson(list: ShareList, userId: string): ShareSetRequest {
  return {
    resource: list.resource,
    entries: list.entries
      .filter((entry) => !(entry.subject.kind === 'user' && entry.subject.id === userId))
      .map((entry) => ({ subject: entry.subject, role: entry.role })),
  }
}

/** The guest link: the secret rides the fragment, so no server on the way sees it. */

/**
 * The origin a guest link names (docs/plans/host-sharing.md §2), as the host that
 * holds the resource answers it: the account origin for a mirrored session, else
 * the host's own route; or the account origin for a record in an organization.
 * `checking` until the host has answered; `unreachable` when it answered that
 * nobody off the machine can reach it — no tunnel, and no address on a network.
 */
export type GuestLinkContext =
  | { kind: 'checking' }
  | { kind: 'unreachable' }
  | { kind: 'origin'; origin: string }

export function hostLinkContext(origin: string | null | undefined): GuestLinkContext {
  if (origin === undefined) return { kind: 'checking' }
  return origin ? { kind: 'origin', origin } : { kind: 'unreachable' }
}

/**
 * What the dialog shows for the link: the full guest URL when its origin is
 * known, `unreachable` when the host offers no route, `unavailable` for a link
 * the host kept no secret for (made before it did; regenerate), and nothing for
 * a viewer, who only sees that a link exists.
 */
export type LinkPresentation =
  | { kind: 'url'; url: string }
  | { kind: 'checking' }
  | { kind: 'unreachable' }
  | { kind: 'unavailable' }
  | { kind: 'hidden' }

export function linkPresentation(link: ShareList['link'], context: GuestLinkContext, canShare: boolean, resource?: ShareList['resource']): LinkPresentation | null {
  if (!link) return null
  if (!canShare) return { kind: 'hidden' }
  if (!link.secret) return { kind: 'unavailable' }
  switch (context.kind) {
    case 'origin': return resource && isGuestLinkResource(resource) ? { kind: 'url', url: cloudShareUrl(context.origin, resource, link.secret) } : { kind: 'unavailable' }
    case 'checking': return { kind: 'checking' }
    case 'unreachable': return { kind: 'unreachable' }
  }
}

/** What the badge says about a list: the scope in words, who is named, and whether a link exists. */
export interface ShareSummary {
  scope: ShareScope | null
  /** People invited by name, the owner not counted. */
  people: number
  hasLink: boolean
  label: string
}

export function shareSummary(list: ShareList | undefined): ShareSummary {
  if (!list) return { scope: null, people: 0, hasLink: false, label: 'Share' }
  const scope = scopeOf(list)
  const people = list.entries.filter((entry) => entry.subject.kind === 'user').length
  const prefix = list.callerRole === 'owner' ? 'Shared' : 'Shared with you'
  const named = people ? ` · ${people} ${people === 1 ? 'person' : 'people'}` : ''
  switch (scope.kind) {
    case 'private': return { scope, people, hasLink: false, label: people ? `${prefix}${named}` : list.callerRole === 'owner' ? 'Share' : 'Shared with you' }
    case 'team': return { scope, people, hasLink: false, label: `${prefix} · a team${named}` }
    case 'organization': return { scope, people, hasLink: false, label: `${prefix} · the organization${named}` }
    case 'link': return { scope, people, hasLink: true, label: `${prefix} · anyone with the link${named}` }
  }
}
