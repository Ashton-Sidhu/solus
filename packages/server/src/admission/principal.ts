import { z } from 'zod'
import { hostKindSchema, organizationRoleSchema, type AccessTokenClaims, type HostKind } from '@solus/contracts/uplink'
import { shareResourceSchema, shareRoleSchema, type ShareResource, type ShareRole } from '@solus/contracts/sharing'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import { LOCAL_ORGANIZATION_ID, provisionedOrganizationId } from '../host/host-category'
import { isOrganizationAttached } from '../host/organization-attachment'

/**
 * Who a request comes from (docs/plans/personal-uplink.md P1; docs/plans/multiplayer-sharing.md §3.3).
 * Every RPC call carries one; a call with none is refused. Six kinds:
 *
 * - `owner` — the personal host's owner, by one of two ways in (`via`):
 *   - `local`: the person at the machine or on a network it already trusts: the
 *     desktop renderer, a paired device, a trusted requester. Pairing is local
 *     authorization, so a paired phone is the owner too. No expiry.
 *   - `grant`: the owner arriving with an access token for this host, their own
 *     client's or another host's acting for them (then the device is that host).
 *     Everything the owner can do except change how the host is reached.
 * - `org-member` — a member of the organization the host belongs to. Reaches a
 *   session or work only through its owner row or its share list. On a managed
 *   host an organization owner is also the host's administrator.
 * - `guest` — a visitor with a share link and no account. Bound to exactly one
 *   resource for the socket's lifetime; never host-wide.
 * - `runner` — a linked host writing to its organization's workspace service
 *   (docs/plans/cloud-service-model.md §16): admitted from a grant carrying the
 *   `runner` claim. It reaches the `system-only` methods of its organization and
 *   nothing else; it is not a person and appears in no room.
 * - `system` — the host acting for itself: automations, agent tools, internal calls.
 */
export type Principal =
  | { kind: 'owner'; via: 'local'; deviceId: string | null; deviceLabel: string; expiresAt: null }
  | {
      kind: 'owner'
      via: 'grant'
      userId: string
      /** The client grant the token names, or the host acting for the owner; revoking it on the host ends the socket's next dial. */
      deviceId: string
      /** Grant expiry (ms). The transport ends the socket here. */
      expiresAt: number
      deviceLabel: string
      /** The account name the grant carried, for notices other people see. */
      displayName?: string
    }
  | {
      kind: 'org-member'
      userId: string
      organizationId: string
      organizationRole: 'owner' | 'member'
      teamIds: string[]
      hostKind: HostKind
      displayName: string
      avatarUrl?: string
      /** The account's verified email, for Insights attribution; metadata, never an authorization key. */
      email?: string
      deviceId: string
      expiresAt: number
      deviceLabel: string
    }
  | {
      kind: 'guest'
      accountUserId?: string
      organizationId?: string
      guestId: string
      displayName: string
      /** The guestId: what the transport keys the client on. */
      deviceId: string
      /** A task resource reaches the task page and everything linked to it. */
      share: { resource: ShareResource; role: ShareRole; sharedByUserId: string; linkSecretHash: string }
      expiresAt: number
      deviceLabel: string
    }
  | {
      kind: 'runner'
      /** The host that delivers, acting for the person (plans/010-standard-oauth.md). */
      hostId: string
      organizationId: string
      /** The person whose delegated token delivered: who owns what the runner writes. A runner always acts for one. */
      ownerUserId: string
      /** The host id: what the transport keys the client on. */
      deviceId: string
      expiresAt: number
      deviceLabel: string
    }
  | { kind: 'system' }

export type PrincipalKind = Principal['kind']

export const INTERNAL_PRINCIPAL: Principal = { kind: 'system' }

/** For reading a principal back off transport-owned state such as `socket.data`. */
export const principalSchema: z.ZodType<Principal> = z.union([
  z.object({ kind: z.literal('owner'), via: z.literal('local'), deviceId: z.string().nullable(), deviceLabel: z.string(), expiresAt: z.null() }),
  z.object({
    kind: z.literal('owner'),
    via: z.literal('grant'),
    userId: z.string(),
    deviceId: z.string(),
    expiresAt: z.number(),
    deviceLabel: z.string(),
    displayName: z.string().optional(),
  }),
  z.object({
    kind: z.literal('org-member'),
    userId: z.string(),
    organizationId: z.string(),
    organizationRole: organizationRoleSchema,
    teamIds: z.array(z.string()),
    hostKind: hostKindSchema,
    displayName: z.string(),
    avatarUrl: z.string().optional(),
    email: z.string().optional(),
    deviceId: z.string(),
    expiresAt: z.number(),
    deviceLabel: z.string(),
  }),
  z.object({
    kind: z.literal('guest'),
    accountUserId: z.string().min(1).optional(),
    organizationId: z.string().min(1).optional(),
    guestId: z.string(),
    displayName: z.string(),
    deviceId: z.string(),
    share: z.object({
      resource: shareResourceSchema,
      role: shareRoleSchema,
      sharedByUserId: z.string(),
      linkSecretHash: z.string(),
    }),
    expiresAt: z.number(),
    deviceLabel: z.string(),
  }),
  z.object({
    kind: z.literal('runner'),
    hostId: z.string(),
    organizationId: z.string(),
    ownerUserId: z.string(),
    deviceId: z.string(),
    expiresAt: z.number(),
    deviceLabel: z.string(),
  }),
  z.object({ kind: z.literal('system') }),
])

/** A socket or request with no credential: a trusted requester (loopback, the host's
 *  tailnet, an opted-in LAN) or a host whose bind policy demands none. The local owner. */
export const CREDENTIAL_FREE_PRINCIPAL: Principal = Object.freeze({ kind: 'owner', via: 'local', deviceId: null, deviceLabel: 'Web', expiresAt: null })

export const GRANT_DEVICE_LABEL = 'Solus cloud'
export const GUEST_DEVICE_LABEL = 'Guest link'
export const RUNNER_DEVICE_LABEL = 'Runner'

/** The principal a host's delegated token stands for on the runner HTTP routes: the host, acting for one person. */
export function runnerPrincipalFor(runner: { hostId: string; organizationId: string; ownerUserId: string; expiresAt: number }): Extract<Principal, { kind: 'runner' }> {
  return {
    kind: 'runner',
    hostId: runner.hostId,
    organizationId: runner.organizationId,
    ownerUserId: runner.ownerUserId,
    deviceId: runner.hostId,
    expiresAt: runner.expiresAt,
    deviceLabel: RUNNER_DEVICE_LABEL,
  }
}

/** How a client reads its own admission (`ConnectionsServerInfo.principal`): the wire names the owner's way in. */
export function wirePrincipalKind(principal: Principal): ConnectionsServerInfo['principal'] {
  if (principal.kind !== 'owner') return principal.kind
  return principal.via === 'local' ? 'local-owner' : 'remote-owner'
}

/**
 * The personal host's owner: every role on every resource, because they own the
 * disk. A managed host never produces one of these for a person.
 */
export function isHostOwner(principal: Principal): principal is Extract<Principal, { kind: 'owner' }> {
  return principal.kind === 'owner'
}

/**
 * Who administers the machine: the owner of a personal host, or an organization
 * owner on a managed host or the workspace service. Administration is not
 * resource access (§3.4).
 */
export function isHostAdmin(principal: Principal): boolean {
  if (isHostOwner(principal)) return true
  return isOrganizationSpace(principal) && principal.organizationRole === 'owner'
}

/**
 * A member of the organization's own space: a managed host (multiplayer-sharing.md
 * §3.4) or the organization's workspace service (cloud-service-model.md §15). There
 * every resource is the team's to see and edit, and the owner alone transfers or
 * deletes. A member admitted to a person's own machine holds only what its rows give.
 */
export function isOrganizationSpace(principal: Principal): principal is Extract<Principal, { kind: 'org-member' }> {
  return principal.kind === 'org-member' && (principal.hostKind === 'managed' || principal.hostKind === 'cloud')
}

export { LOCAL_ORGANIZATION_ID }

/**
 * The organizations a read may span (organization-scope §3, §9). Every root
 * record carries one canonical `organization_id`: `local` while unassigned, else
 * an organization's id that never changes again. A host's disk holds records of
 * several organizations at once — the owner's Local scratch beside sessions
 * assigned to A and B — so a read is scoped either to one organization or to
 * every one, and the ported stores render the scope into their `WHERE`
 * (`data/scope.ts`). A write always names one organization.
 */
export interface AnyOrganization { readonly kind: 'any-organization' }
export const ANY_ORGANIZATION: AnyOrganization = Object.freeze({ kind: 'any-organization' })
export type RecordScope = string | AnyOrganization

export function isAnyOrganization(scope: RecordScope): scope is AnyOrganization {
  return scope === ANY_ORGANIZATION
}

/**
 * What a principal may read. The owner of a personal host, and the host acting
 * for itself, read everything on the disk; the client filters the answer to
 * Local plus its window's organization (R11). On a machine attached for
 * organization work, a pairing or network-trusted connection is an old personal
 * credential: it keeps the Local records it always had and reaches no
 * organization's (organization-vms §1). A member reads the organization their
 * grant names and nothing else, on a machine and on the Solus API alike. A guest
 * is bound to one resource of one organization. A runner writes to the
 * organization its grant names, and only there.
 */
export function recordScopeOf(principal: Principal): RecordScope {
  switch (principal.kind) {
    case 'owner':
      return principal.via === 'local' && isOrganizationAttached() ? LOCAL_ORGANIZATION_ID : ANY_ORGANIZATION
    case 'system':
      return ANY_ORGANIZATION
    case 'org-member':
      return principal.organizationId
    case 'guest':
      return principal.organizationId ?? LOCAL_ORGANIZATION_ID
    case 'runner':
      return principal.organizationId
  }
}

/**
 * The organization a record this principal creates starts in (R9, R10). Scratch
 * on an owned or self-hosted machine starts Local even while signed in; the
 * host's own work on a managed machine belongs to the organization it was
 * provisioned for; a member's work is their organization's wherever it runs; a
 * runner's writes land in the organization its grant names. A new root
 * session's organization on an attached machine is decided at turn admission
 * (execution/sessions/turn-organization.ts), not here.
 */
export function organizationForNew(principal: Principal): string {
  switch (principal.kind) {
    case 'owner':
    case 'system':
      return provisionedOrganizationId() ?? LOCAL_ORGANIZATION_ID
    case 'org-member':
      return principal.organizationId
    case 'guest':
      return principal.organizationId ?? LOCAL_ORGANIZATION_ID
    case 'runner':
      return principal.organizationId
  }
}

/** Whether a record of `organizationId` is inside `scope`. */
export function scopeAdmits(scope: RecordScope, organizationId: string): boolean {
  return isAnyOrganization(scope) || scope === organizationId
}

/** Grant-admitted sockets end at the grant's expiry; the others live as long as the connection. */
export function principalExpiresAt(principal: Principal): number | null {
  return principal.kind === 'system' ? null : principal.expiresAt
}

/**
 * The new end of a socket whose client sent its next access token (`authRenew`;
 * docs/adr/0001-standard-authentication.md rule 4), or null when the token does not
 * continue this socket. The verifier has checked the issuer, the signature, the life,
 * and this server's audience, which is the audience the socket was opened with. The
 * token must name the same person in the same standing: the owner stays the owner; a
 * member's token must still list the socket's organization with the same role and
 * teams. Anything else ends the socket at its old expiry, and the client dials again
 * with what the token says now.
 */
export function renewalExpiry(principal: Principal, claims: AccessTokenClaims): number | null {
  if (claims.act) return null
  if (principal.kind === 'owner' && principal.via === 'grant') {
    return claims.sub === principal.userId && claims.access === 'owner' ? claims.exp * 1000 : null
  }
  if (principal.kind !== 'org-member' || claims.sub !== principal.userId || claims.access !== 'org-member') return null
  const listed = claims.organizations?.find((entry) => entry.id === principal.organizationId)
  if (!listed || listed.role !== principal.organizationRole) return null
  const sameTeams = [...listed.teamIds].sort().join('\n') === [...principal.teamIds].sort().join('\n')
  return sameTeams ? claims.exp * 1000 : null
}
