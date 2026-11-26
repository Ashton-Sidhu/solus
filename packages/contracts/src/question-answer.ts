import type { QuestionItem, QuestionRequest } from './types'

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

/**
 * A standard question takes files in its free-form answer: an async Codex
 * question, and a callback question from Claude or Codex. The answer is text
 * with one `[Attached file: <path>]` line for each file, and both providers send
 * that text to the agent as it is. An MCP form maps answers onto its schema, and
 * the secret and machine cards have their own answers, so they take no files.
 */
export function questionTakesAttachments(request: Pick<QuestionRequest, 'kind'>): boolean {
  return !request.kind || request.kind === 'standard'
}

/** One question's choice and remark, followed by host file paths. */
export function formatAnswer(choice: string, comment?: string, attachmentPaths: readonly string[] = []): string {
  const remark = (comment ?? '').trim()
  const text = choice && remark ? `${choice} — ${remark}` : choice || remark
  if (attachmentPaths.length === 0) return text
  return [text, ...attachmentPaths.map((path) => `[Attached file: ${path}]`)].filter(Boolean).join('\n')
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
