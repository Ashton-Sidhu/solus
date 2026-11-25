import { z } from 'zod'
import type { HostListing } from './host-list'

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
}).strict().refine((request) => !!request.code !== !!request.checkCode, { message: 'Give a pairing code or a check code, not both.' })
export type HostPairRequest = z.infer<typeof hostPairRequestSchema>

/** A host this host paired. `pairedAt` changes only when the owner pairs it again:
 * a client whose own token the host refuses pairs again once for each new value. */
export interface HostPairing {
  listing: HostListing
  pairedAt: number
  url?: string
  /** Only in the owner's list (`hostsListPaired`). An older host sends none. */
  health?: HostPairingHealth
}

/**
 * How one pairing of this host is doing, from its uses (docs/host-pairing.md,
 * "Pairing health"). Nothing is dialed to find it out: a use records what happened.
 */
export interface HostPairingHealth {
  /** The last time the machine accepted this host's credential. */
  lastReachedAt: number
  /** Why the last use of the pairing failed; null after a use that worked. */
  lastError: string | null
  /** When the credential ends if nothing uses it. Each use after a day renews it. Null when it has ended: refused, or unused for too long. */
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
