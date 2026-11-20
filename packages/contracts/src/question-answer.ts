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

/** The composer's draft with the remarks typed for a question that closed
 *  without an answer, so that no typed word is lost. Each remark goes after the
 *  draft, separated by a blank line. A blank remark adds nothing. A selection is
 *  not kept: it has a meaning only as an answer to that question. */
export function draftWithUnsentRemarks(draft: string, remarks: readonly string[]): string {
  const typed = remarks.map((remark) => remark.trim()).filter(Boolean)
  if (typed.length === 0) return draft
  const text = typed.join('\n\n')
  return draft.trim() ? `${draft.trimEnd()}\n\n${text}` : text
}

/** An option's preview as markdown. A preview is usually a mockup or a code
 *  snippet laid out in columns, and markdown reflows its lines and drops its
 *  leading spaces. So a preview with no fenced block of its own shows verbatim,
 *  as one fenced block. A preview with a fence is markdown the agent wrote. */
export function previewMarkdown(preview: string): string {
  if (/^ {0,3}(```|~~~)/m.test(preview)) return preview
  return `\`\`\`\n${preview.replace(/\n+$/, '')}\n\`\`\``
}
