import { z } from 'zod'
import type { VerifiedWsTicket } from './auth'

/**
 * Who a request comes from (docs/plans/personal-uplink.md, P1). Every RPC call carries
 * one; a call with none is refused. Three kinds today:
 *
 * - `local-owner` — the person at the machine or on a network it already trusts:
 *   the desktop renderer, a paired device, a trusted requester. Pairing is local
 *   authorization, so a paired phone is the owner too.
 * - `remote-owner` — the owner arriving through a control-plane grant over the
 *   tunnel. Everything the owner can do except change how the host is reached.
 *   `userId` and `deviceId` are what a team host will attribute turns and queue
 *   ownership to; they are the seed of `team-user`, not a redesign.
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

export function principalFor(evidence: AdmissionEvidence): Principal {
  if (evidence.kind !== 'ticket') return { kind: 'local-owner', deviceId: null, deviceLabel: 'Web' }
  const ticket = evidence.ticket
  if (ticket.kind === 'pairing') {
    return { kind: 'local-owner', deviceId: ticket.deviceId, deviceLabel: ticket.deviceLabel }
  }
  return {
    kind: 'remote-owner',
    userId: ticket.userId,
    deviceId: ticket.deviceId,
    expiresAt: ticket.expiresAt,
    deviceLabel: REMOTE_OWNER_DEVICE_LABEL,
  }
}
