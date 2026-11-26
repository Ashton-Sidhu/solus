import { z } from 'zod'

/** Details include task fields, comments and Solus attachments. Provider context pages independently.
 *  `cached` answers the host's own copy with no provider call: a client re-reads that way after
 *  `issues.invalidated`, because the event means the host's copy already changed. */
export const taskReadOptionsSchema = z.discriminatedUnion('section', [
  z.object({ section: z.literal('details'), cached: z.literal(true).optional() }).strict(),
  z
    .object({
      section: z.literal('provider'),
      cursor: z.string().min(1).max(2048).optional(),
      timelineOnly: z.literal(true).optional()
    })
    .strict()
])
export type TaskReadOptions = z.infer<typeof taskReadOptionsSchema>
export type TaskDetailsRead = Extract<TaskReadOptions, { section: 'details' }>
export type TaskProviderRead = Extract<TaskReadOptions, { section: 'provider' }>
