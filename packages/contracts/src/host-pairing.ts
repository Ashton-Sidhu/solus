import { z } from 'zod'
import type { HostListing } from './host-list'

/** An explicit owner pairing. Codes travel only through this request, never a listing. */
export const hostPairRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  code: z.string().trim().min(1).max(2048),
  label: z.string().trim().min(1).max(200).optional(),
}).strict()
export type HostPairRequest = z.infer<typeof hostPairRequestSchema>

export interface HostPairingsSnapshot {
  hosts: HostListing[]
  forgotten: string[]
}

/** A fresh, one-use code for this client; never the host's stored session token. */
export interface HostClientPairing {
  listing: HostListing
  url: string
  code: string
}
