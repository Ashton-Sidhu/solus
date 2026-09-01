import { z } from 'zod'

/** The persisted shape shared by Folio works and plan annotations. */
export const workExternalLinkSchema = z.object({
  provider: z.enum(['gdrive', 'confluence']),
  externalKey: z.string(),
  externalId: z.string(),
  url: z.string(),
  scope: z.string(),
  upstreamVersion: z.string().optional(),
  lastPushedContentHash: z.string().optional(),
  syncState: z.enum(['ok', 'dirty', 'upstream_changed', 'conflict', 'error', 'auth_error']),
  syncError: z.string().optional(),
})
