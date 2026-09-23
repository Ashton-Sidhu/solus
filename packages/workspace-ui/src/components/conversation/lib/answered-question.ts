import type { QuestionItem, QuestionOption } from '@solus/contracts/types'
import { optionLabelParts } from './interrupt'

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

export interface AnsweredRecord {
  question: Pick<QuestionItem, 'question'>
  resolved: ResolvedAnswer | null
}

export interface AnsweredSummary {
  /** The sentence on the row: the question itself, or how many there were. */
  label: string
  /** What the user picked, after the arrow. Empty when nothing was recorded. */
  target: string
}

/**
 * An answered question is history, so the transcript folds it to one row like
 * any other completed step. The row must say which decision this was and how it
 * went without being opened: the question and the pick when there is one
 * question, a count and every pick when there are several.
 */
export function summarizeAnswered(records: AnsweredRecord[]): AnsweredSummary {
  const label =
    records.length === 0
      ? 'Agent question'
      : records.length === 1
        ? records[0].question.question
        : `${records.length} questions`

  const target = records
    .map(({ resolved }) => {
      if (!resolved) return ''
      if (resolved.deferred) return 'left to the agent'
      if (resolved.chosen.length) return resolved.chosen.map((option) => optionLabelParts(option.label).text).join(', ')
      return resolved.remark
    })
    .filter(Boolean)
    .join(' · ')

  return { label, target }
}
