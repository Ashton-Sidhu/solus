import { z } from 'zod'
import type { HostListing } from './host-list'
import { hostIdentityKeySchema } from './host-identity'

/**
 * An explicit owner pairing. Codes travel only through this request, never a listing.
 * Exactly one of `code` (the host's pairing code or link) and `checkCode` (an approval
 * request: the caller makes the check code, shows it, and the call resolves when the
 * host's owner approves; docs/plans/add-machine-card.md).
 */
export const hostPairRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  code: z.string().trim().min(1).max(2048).optional(),
  checkCode: z.string().trim().length(9).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  /** A Settings link is bound to the selected machine and leaves client connection to the user. */
  link: z.object({
    installationId: z.string().min(1).max(200),
    identityKey: hostIdentityKeySchema,
  }).strict().optional(),
}).strict().refine((request) => !!request.code !== !!request.checkCode && (!request.link || !!request.code), { message: 'Give one pairing code or one check code. A Settings link needs a pairing code.' })
export type HostPairRequest = z.infer<typeof hostPairRequestSchema>

/** A host this host paired. `pairedAt` changes only when the owner pairs it again:
 * a client whose own token the host refuses pairs again once for each new value. */
export interface HostPairing {
  listing: HostListing
  pairedAt: number
  url?: string
  clientConnect?: 'on-request'
}

/**
 * How one machine link of this host is doing (docs/host-pairing.md, "Link health").
 * `status` is read when the health is asked for: `reachable` when the machine answers
 * as itself at the link's address, `unreachable` when it does not, and `expired` when
 * this host holds no credential for it or the credential is past `expiresAt`. A
 * reachable link can still have a `lastError`: the address answers, but the last use
 * of the link failed.
 */
export interface HostLinkHealth {
  installationId: string
  status: 'reachable' | 'unreachable' | 'expired'
  /** The last time the machine accepted this host's credential. */
  lastReachedAt: number
  /** Why the last use of the link failed; null after a use that worked. */
  lastError: string | null
  /** When the credential ends if nothing uses it. Each use after a day renews it. Null when expired. */
  expiresAt: number | null
}

export interface HostPairingsSnapshot {
  hosts: HostPairing[]
  forgotten: string[]
}

/** A fresh, one-use code for this client; never the host's stored session token. */
export interface HostClientPairing {
  listing: HostListing
  url: string
  code: string
}
