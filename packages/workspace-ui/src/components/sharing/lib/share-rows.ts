import type { OrganizationDirectory, UplinkStatus } from '@solus/contracts/uplink'
import { guestLinkFragment, HOST_OWNER_USER_ID, type ShareList, type ShareRole, type ShareSetRequest } from '@solus/contracts/sharing'

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
  const organization = list.grants.find((grant) => grant.subject.kind === 'organization')
  if (organization?.subject.kind === 'organization') return { kind: 'organization', organizationId: organization.subject.id, role: organization.role }
  const team = list.grants.find((grant) => grant.subject.kind === 'team')
  if (team?.subject.kind === 'team') return { kind: 'team', teamId: team.subject.id, role: team.role }
  return { kind: 'private' }
}

/** One row of the dialog's choice. `role` is the row's current role when it is on, else the role it would start with. */
export interface ScopeOption {
  key: string
  scope: ShareScope
  name: string
  detail: string
  role: ShareRole | null
}

const can = (role: ShareRole) => (role === 'editor' ? 'edit' : 'view')

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
export function scopeOptions(list: ShareList, directory: OrganizationDirectory | null, organizationId: string | null, ownerLabel: string): ScopeOption[] {
  const current = scopeOf(list)
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
    options.push(option(scope, team.name, (role) => `Team · ${count} ${count === 1 ? 'person' : 'people'} can ${can(role)}`, roleIfCurrent(scope), 'editor'))
  }
  if (current.kind === 'team' && !teams.some((team) => team.teamId === current.teamId)) {
    options.push(option(current, 'A team', (role) => `Team · everyone in it can ${can(role)}`, current.role, 'editor'))
  }
  const organizationName = directory?.name
  const knownOrganizationId = directory?.organizationId ?? organizationId ?? (current.kind === 'organization' ? current.organizationId : null)
  if (knownOrganizationId) {
    const scope: ShareScope = { kind: 'organization', organizationId: knownOrganizationId, role: 'editor' }
    options.push(option(
      scope,
      organizationName ? `Everyone in ${organizationName}` : 'Everyone in the organization',
      (role) => `Organization · everyone in it can ${can(role)}`,
      roleIfCurrent(scope),
      'editor',
    ))
  }
  options.push(option({ kind: 'link', role: 'viewer' }, 'Anyone with the link', (role) => `Anyone on the internet with the link can ${can(role)}`, roleIfCurrent({ kind: 'link', role: 'viewer' }), 'viewer'))
  return options
}

/** The rows a scope stands for, with the people named on the list kept as they are; the link is its own call (`linkRoleFor`). */
export function grantsFor(scope: ShareScope, list: ShareList, organizationId: string | null): ShareSetRequest {
  const grants: ShareSetRequest['grants'] = list.grants
    .filter((grant) => grant.subject.kind === 'user')
    .map((grant) => ({ subject: grant.subject, role: grant.role }))
  switch (scope.kind) {
    case 'private':
      break
    case 'team':
      grants.push({ subject: { kind: 'team', id: scope.teamId }, role: scope.role })
      break
    case 'organization':
      grants.push({ subject: { kind: 'organization', id: scope.organizationId }, role: scope.role })
      break
    case 'link': {
      // The link is the widest scope: the organization, when there is one, stays on
      // the list with the role it has; one it never had starts with the link's.
      const existing = list.grants.find((grant) => grant.subject.kind === 'organization')
      if (existing?.subject.kind === 'organization') grants.push({ subject: existing.subject, role: existing.role })
      else if (organizationId) grants.push({ subject: { kind: 'organization', id: organizationId }, role: scope.role })
      break
    }
  }
  return { resource: list.resource, grants }
}

/** Whether a scope keeps a link, and with which role. */
export function linkRoleFor(scope: ShareScope): ShareRole | null {
  return scope.kind === 'link' ? scope.role : null
}

/** Who "Only …" names: the reader when they own it, else the owner by name. */
export function ownerLabel(list: Pick<ShareList, 'ownerUserId' | 'callerRole'>, directory: OrganizationDirectory | null): string {
  if (list.callerRole === 'owner') return 'you'
  if (list.ownerUserId === HOST_OWNER_USER_ID) return 'the host owner'
  return directory?.members.find((entry) => entry.userId === list.ownerUserId)?.name ?? 'the owner'
}

// ── People named on the list ────────────────────────────────────────────────

/** One person on the list: the owner first, then everyone invited by name. */
export interface PersonRow {
  userId: string
  name: string
  /** An email under the name; empty when the directory has none. */
  detail: string
  avatarUrl: string | null
  role: ShareRole | 'owner'
  isSelf: boolean
}

function memberOf(directory: OrganizationDirectory | null, userId: string) {
  return directory?.members.find((entry) => entry.userId === userId)
}

/** The owner, then the people with a row of their own, named from the directory. */
export function personRows(list: ShareList, directory: OrganizationDirectory | null, selfUserId: string | null): PersonRow[] {
  const ownerMember = memberOf(directory, list.ownerUserId)
  const rows: PersonRow[] = [{
    userId: list.ownerUserId,
    name: list.ownerUserId === HOST_OWNER_USER_ID ? 'Host owner' : ownerMember?.name ?? 'Former member',
    detail: ownerMember?.email ?? '',
    avatarUrl: ownerMember?.image ?? null,
    role: 'owner',
    isSelf: list.callerRole === 'owner',
  }]
  for (const grant of list.grants) {
    if (grant.subject.kind !== 'user') continue
    const member = memberOf(directory, grant.subject.id)
    rows.push({
      userId: grant.subject.id,
      name: member?.name ?? 'Former member',
      detail: member?.email ?? '',
      avatarUrl: member?.image ?? null,
      role: grant.role,
      isSelf: selfUserId !== null && grant.subject.id === selfUserId,
    })
  }
  return rows
}

export interface PersonCandidate {
  userId: string
  name: string
  detail: string
  avatarUrl: string | null
}

/** Everyone in the directory who is not the owner and not yet on the list, narrowed by the search. */
export function personCandidates(list: ShareList, directory: OrganizationDirectory | null, query: string): PersonCandidate[] {
  if (!directory) return []
  const taken = new Set(list.grants.flatMap((grant) => (grant.subject.kind === 'user' ? [grant.subject.id] : [])))
  const needle = query.trim().toLowerCase()
  const candidates: PersonCandidate[] = []
  for (const member of directory.members) {
    if (member.userId === list.ownerUserId || taken.has(member.userId)) continue
    if (needle && !member.name.toLowerCase().includes(needle) && !(member.email ?? '').toLowerCase().includes(needle)) continue
    candidates.push({ userId: member.userId, name: member.name, detail: member.email ?? '', avatarUrl: member.image ?? null })
  }
  return candidates
}

/** The whole list with one person set to a role (added when absent); every other row stays. */
export function withPersonRole(list: ShareList, userId: string, role: ShareRole): ShareSetRequest {
  const grants: ShareSetRequest['grants'] = list.grants
    .filter((grant) => !(grant.subject.kind === 'user' && grant.subject.id === userId))
    .map((grant) => ({ subject: grant.subject, role: grant.role }))
  grants.push({ subject: { kind: 'user', id: userId }, role })
  return { resource: list.resource, grants }
}

/** The whole list without one person. */
export function withoutPerson(list: ShareList, userId: string): ShareSetRequest {
  return {
    resource: list.resource,
    grants: list.grants
      .filter((grant) => !(grant.subject.kind === 'user' && grant.subject.id === userId))
      .map((grant) => ({ subject: grant.subject, role: grant.role })),
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
  // Named fields, not a spread: the saved row is the registry's uplink record, which
  // carries a `kind` of its own (the host kind) that must not become the context's.
  if (saved) return { kind: 'linked', hostId: saved.hostId, directoryUrl: saved.directoryUrl }
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
  const people = list.grants.filter((grant) => grant.subject.kind === 'user').length
  const prefix = list.callerRole === 'owner' ? 'Shared' : 'Shared with you'
  const named = people ? ` · ${people} ${people === 1 ? 'person' : 'people'}` : ''
  switch (scope.kind) {
    case 'private': return { scope, people, hasLink: false, label: people ? `${prefix}${named}` : list.callerRole === 'owner' ? 'Share' : 'Shared with you' }
    case 'team': return { scope, people, hasLink: false, label: `${prefix} · a team${named}` }
    case 'organization': return { scope, people, hasLink: false, label: `${prefix} · the organization${named}` }
    case 'link': return { scope, people, hasLink: true, label: `${prefix} · anyone with the link${named}` }
  }
}
