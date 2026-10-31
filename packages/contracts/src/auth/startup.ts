import { z } from 'zod'
import { accountResponseSchema, directoryResponseSchema } from '../uplink'
import { accountSettingsResponseSchema } from '../settings'

/** Data read with a fresh client grant. Later reads use the account APIs. */
export const accountStartupSchema = z.object({
  account: accountResponseSchema,
  settings: accountSettingsResponseSchema,
  /** What `GET /v1/hosts` answers. Optional: an older server does not send it. */
  directory: directoryResponseSchema.optional(),
})
export type AccountStartup = z.infer<typeof accountStartupSchema>
