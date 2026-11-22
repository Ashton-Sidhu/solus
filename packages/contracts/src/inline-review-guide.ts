import { z } from 'zod'

export const INLINE_REVIEW_FENCE = 'review-guide'

const file = z.object({ path: z.string().min(1), turn: z.number().int().positive() })
const section = z.object({
  title: z.string().min(1),
  significance: z.enum(['core', 'supporting', 'low-signal']),
  explanation: z.string().min(1),
  attention: z.object({
    kind: z.enum(['tradeoff', 'contract', 'product', 'risk', 'accessibility']),
    note: z.string().min(1),
  }).optional(),
  files: z.array(file).refine(files => new Set(files.map(ref => ref.path)).size === files.length),
})
const guide = z.object({ title: z.string().min(1), summary: z.string(), sections: z.array(section).min(1) })

export type InlineReviewGuide = z.infer<typeof guide>

export function parseInlineReviewGuide(text: string): InlineReviewGuide | null {
  try {
    const result = guide.safeParse(JSON.parse(text))
    return result.success ? result.data : null
  } catch {
    return null
  }
}
