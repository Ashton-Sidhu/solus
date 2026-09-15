import { z } from 'zod'
import type { QuestionItem } from './types'

export function isQuestionTool(name: string | undefined): boolean {
  return !!name && /(?:^|[._])(?:AskUserQuestion|request_user_input)$/.test(name)
}

const inputSchema = z.object({
  questions: z.array(z.object({
    id: z.string().optional(),
    question: z.string(),
    header: z.string().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })).default([]),
    multiSelect: z.boolean().default(false),
  })),
  answers: z.record(z.string(), z.string()).optional(),
})

export function parseQuestionInput(input: string | undefined): {
  questions: QuestionItem[]
  answers?: Record<string, string>
} | undefined {
  if (!input) return undefined
  try {
    const parsed = inputSchema.safeParse(JSON.parse(input))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
