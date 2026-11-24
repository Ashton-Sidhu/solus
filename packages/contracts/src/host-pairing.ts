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
