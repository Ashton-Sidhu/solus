import { z } from 'zod'

/** Details include task fields, comments and Solus attachments. Provider context pages independently. */
export const taskReadOptionsSchema = z.discriminatedUnion('section', [
  z.object({ section: z.literal('details') }).strict(),
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
