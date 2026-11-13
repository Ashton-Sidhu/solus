// The shape of a row, for the backend and the UI. Keep this file free of
// backend code: the UI imports it.
import { z } from 'zod'

export const Note = z.object({ id: z.string(), text: z.string(), created_at: z.number() })
export type Note = z.infer<typeof Note>
