import type { QuestionItem, QuestionOption } from '@solus/contracts/types'

/**
 * An answer on the wire is one string — `formatAnswer` joins chosen labels with
 * `, ` and appends a free-text remark after ` — `. The answered card wants to
 * show the choice as the option row the user actually picked, with its
 * consequence line, so this pulls the options back out of that string.
 */
export interface ResolvedAnswer {
  /** Options whose label appears in the answer, in the question's own order. */
  chosen: QuestionOption[]
  /** The free-text part: the whole answer when no option label matched. */
  remark: string
  /** No answer text at all — the user handed the decision to the agent. */
  deferred: boolean
}

export function resolveAnswer(question: Pick<QuestionItem, 'options'>, answer: string): ResolvedAnswer {
  const trimmed = answer.trim()
  if (!trimmed) return { chosen: [], remark: '', deferred: true }

  const separator = trimmed.indexOf(' — ')
  const choicePart = separator === -1 ? trimmed : trimmed.slice(0, separator)
  const remarkPart = separator === -1 ? '' : trimmed.slice(separator + 3).trim()

  // Labels may themselves hold `, `, so peel them off longest-first and only
  // accept the match when nothing but separators is left over.
  const picked = new Set<QuestionOption>()
  let rest = choicePart
  for (const option of [...question.options].sort((a, b) => b.label.length - a.label.length)) {
    if (!option.label || !rest.includes(option.label)) continue
    picked.add(option)
    rest = rest.replace(option.label, '')
  }
  if (picked.size > 0 && rest.replace(/,/g, '').trim() === '') {
    return {
      chosen: question.options.filter((option) => picked.has(option)),
      remark: remarkPart,
      deferred: false,
    }
  }

  return { chosen: [], remark: trimmed, deferred: false }
}
