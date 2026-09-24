import type { QuestionItem } from './types'

/**
 * How a question's answer is encoded on the wire. Both providers consume the
 * resulting `Record<string, string>` — `PermissionManager.respondToQuestion`
 * keys `updatedInput.answers` by it, and Codex maps it onto elicitation schema
 * properties — so every surface that answers a question MUST produce
 * byte-identical records for the same selection.
 */

export function questionKey(q: Pick<QuestionItem, 'id' | 'question'>): string {
  return q.id || q.question
}

/** One question's answer: the chosen option label(s), the free-text remark, or
 *  `choice — remark` when both were given. */
export function formatAnswer(choice: string, comment?: string): string {
  const remark = (comment ?? '').trim()
  if (choice && remark) return `${choice} — ${remark}`
  return choice || remark
}
