import { z } from 'zod'
import { attributionSchema } from './user'

/** Files and automations retain the host that owns them. Works retain their existing session membership. */
export const sessionLinkInputSchema = z.strictObject({
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('work'), targetId: z.string().min(1).max(256) }),
    z.strictObject({ kind: z.literal('automation'), targetId: z.string().min(1).max(256), hostId: z.string().min(1).max(256) }),
    z.strictObject({ kind: z.literal('file'), path: z.string().min(1).max(4096), hostId: z.string().min(1).max(256) }),
  ]),
  title: z.string().max(512).optional(),
})
export type SessionLinkInput = z.infer<typeof sessionLinkInputSchema>

/** The existing sessions outbox delivers `link-item` to the session's record home. */
export const sessionLinkOpSchema = sessionLinkInputSchema.extend({ actor: attributionSchema })
