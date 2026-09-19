import { z } from 'zod'
import { hostKindSchema, organizationRoleSchema, type HostKind } from '@solus/contracts/uplink'
import { HOST_OWNER_USER_ID, shareResourceSchema, shareRoleSchema, type ShareResource, type ShareRole } from '@solus/contracts/sharing'
import type { VerifiedWsTicket } from './auth'

/**
 * Who a request comes from (docs/plans/personal-uplink.md P1; docs/plans/multiplayer-sharing.md §3.3).
 * Every RPC call carries one; a call with none is refused. Five kinds:
 *
 * - `local-owner` — the person at the machine or on a network it already trusts:
 *   the desktop renderer, a paired device, a trusted requester. Pairing is local
 *   authorization, so a paired phone is the owner too. Personal hosts only.
 * - `remote-owner` — the owner arriving through a control-plane grant over the
 *   tunnel. Everything the owner can do except change how the host is reached.
 * - `org-member` — a member of the organization the host belongs to. Reaches a
 *   session or work only through its owner row or its share list. On a managed
 *   host an organization owner is also the host's administrator.
 * - `guest` — a visitor with a share link and no account. Bound to exactly one
 *   resource for the socket's lifetime; never host-wide.
 * - `system` — the host acting for itself: automations, agent tools, internal calls.
 */
export type Principal =
  | { kind: 'local-owner'; deviceId: string | null; deviceLabel: string }
  | {
      kind: 'remote-owner'
      userId: string
      /** The account session the grant was minted for; revoking it on the host ends the socket's next dial. */
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
      deviceId: string
      expiresAt: number
      deviceLabel: string
    }
  | {
      kind: 'guest'
      guestId: string
      displayName: string
      /** The guestId: what the transport keys the client on. */
      deviceId: string
      /** A task resource reaches the task page and everything linked to it. */
      share: { resource: ShareResource; role: ShareRole; sharedByUserId: string; linkSecretHash: string }
      expiresAt: number
      deviceLabel: string
    }
  | { kind: 'system' }

export type PrincipalKind = Principal['kind']

export const INTERNAL_PRINCIPAL: Principal = { kind: 'system' }

/** For reading a principal back off transport-owned state such as `socket.data`. */
export const principalSchema: z.ZodType<Principal> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-owner'), deviceId: z.string().nullable(), deviceLabel: z.string() }),
  z.object({
    kind: z.literal('remote-owner'),
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
    deviceId: z.string(),
    expiresAt: z.number(),
    deviceLabel: z.string(),
  }),
  z.object({
    kind: z.literal('guest'),
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
  z.object({ kind: z.literal('system') }),
])

/** What a socket presented at admission. */
export type AdmissionEvidence =
  | { kind: 'ticket'; ticket: VerifiedWsTicket }
  /** No credential: a trusted requester (loopback, the host's tailnet, an opted-in
   *  LAN) or a host whose bind policy demands none. Both are the local owner. */
  | { kind: 'credential-free' }

export const REMOTE_OWNER_DEVICE_LABEL = 'Solus cloud'
export const GUEST_DEVICE_LABEL = 'Guest link'

export function principalFor(evidence: AdmissionEvidence): Principal {
  if (evidence.kind !== 'ticket') return { kind: 'local-owner', deviceId: null, deviceLabel: 'Web' }
  const ticket = evidence.ticket
  if (ticket.kind === 'pairing') {
    return { kind: 'local-owner', deviceId: ticket.deviceId, deviceLabel: ticket.deviceLabel }
  }
  if (ticket.kind === 'guest') {
    return {
      kind: 'guest',
      guestId: ticket.guestId,
      displayName: ticket.displayName,
      deviceId: ticket.guestId,
      share: ticket.share,
      expiresAt: ticket.expiresAt,
      deviceLabel: GUEST_DEVICE_LABEL,
    }
  }
  if (ticket.membership) {
    const membership = ticket.membership
    const principal: Extract<Principal, { kind: 'org-member' }> = {
      kind: 'org-member',
      userId: ticket.userId,
      organizationId: membership.organizationId,
      organizationRole: membership.organizationRole,
      teamIds: membership.teamIds,
      hostKind: membership.hostKind,
      displayName: membership.displayName,
      deviceId: ticket.deviceId,
      expiresAt: ticket.expiresAt,
      deviceLabel: REMOTE_OWNER_DEVICE_LABEL,
    }
    if (membership.picture) principal.avatarUrl = membership.picture
    return principal
  }
  const owner: Extract<Principal, { kind: 'remote-owner' }> = {
    kind: 'remote-owner',
    userId: ticket.userId,
    deviceId: ticket.deviceId,
    expiresAt: ticket.expiresAt,
    deviceLabel: REMOTE_OWNER_DEVICE_LABEL,
  }
  if (ticket.displayName) owner.displayName = ticket.displayName
  return owner
}

/**
 * The personal host's owner: every role on every resource, because they own the
 * disk. A managed host never produces one of these for a person.
 */
export function isHostOwner(principal: Principal): principal is Extract<Principal, { kind: 'local-owner' | 'remote-owner' }> {
  return principal.kind === 'local-owner' || principal.kind === 'remote-owner'
}

/**
 * Who administers the machine: the owner of a personal host, or an organization
 * owner on a managed host. Administration is not resource access (§3.4).
 */
export function isHostAdmin(principal: Principal): boolean {
  if (isHostOwner(principal)) return true
  return principal.kind === 'org-member' && principal.hostKind === 'managed' && principal.organizationRole === 'owner'
}

/**
 * The id a resource records as its owner when this principal creates it. A local
 * connection knows no account, so it records the host owner sentinel; a remote
 * owner is the same person and is matched to the sentinel by `isHostOwner`.
 */
export function principalOwnerId(principal: Principal): string | null {
  switch (principal.kind) {
    case 'local-owner':
    case 'remote-owner':
      return HOST_OWNER_USER_ID
    case 'org-member':
      return principal.userId
    case 'guest':
      return `guest:${principal.guestId}`
    case 'system':
      return null
  }
}

/** How the person is named in events and notices. */
export function principalDisplayName(principal: Principal): string {
  switch (principal.kind) {
    case 'local-owner':
      return 'Host owner'
    case 'remote-owner':
      return principal.displayName ?? 'Host owner'
    case 'org-member':
    case 'guest':
      return principal.displayName
    case 'system':
      return 'Solus'
  }
}

/** Grant-admitted sockets end at the grant's expiry; the others live as long as the connection. */
export function principalExpiresAt(principal: Principal): number | null {
  return principal.kind === 'remote-owner' || principal.kind === 'org-member' || principal.kind === 'guest'
    ? principal.expiresAt
    : null
}
