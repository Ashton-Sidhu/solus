import type { SessionSuggestion } from '@solus/contracts/session-suggestions'

/** Decided suggestions of their own an author still sees, newest last. */
const OWN_DECIDED_SHOWN = 3

/** One suggestion as the conversation shows it to this reader. */
export interface SuggestionRow {
  suggestion: SessionSuggestion
  /** Send and Dismiss: the reader may prompt the session. */
  canDecide: boolean
  /** Withdraw: the reader wrote it and it still waits. */
  canWithdraw: boolean
  /** The line under it: who wrote it, or what became of it. */
  caption: string
}

/**
 * What the conversation shows of a session's suggestions (docs/plans/custom-roles.md
 * §7). Every waiting one the host gave the reader; and of the decided ones, only the
 * reader's own latest few, so an author sees what became of theirs and nobody else's
 * transcript fills with closed ones.
 */
export function suggestionRows(suggestions: readonly SessionSuggestion[], mayPrompt: boolean): SuggestionRow[] {
  const waiting = suggestions.filter((suggestion) => suggestion.state === 'waiting')
  const ownDecided = suggestions.filter((suggestion) => suggestion.state !== 'waiting' && suggestion.isMine).slice(-OWN_DECIDED_SHOWN)
  return [...ownDecided, ...waiting].map((suggestion) => ({
    suggestion,
    canDecide: mayPrompt && suggestion.state === 'waiting',
    canWithdraw: suggestion.isMine && suggestion.state === 'waiting',
    caption: captionOf(suggestion, mayPrompt),
  }))
}

function captionOf(suggestion: SessionSuggestion, mayPrompt: boolean): string {
  switch (suggestion.state) {
    case 'waiting': return suggestion.isMine && !mayPrompt ? 'Waiting for someone who can prompt to send it' : `Suggested by ${suggestion.authorName}`
    case 'sent': return suggestion.decidedByName ? `Sent by ${suggestion.decidedByName}` : 'Sent'
    case 'dismissed': return 'Not sent'
    case 'withdrawn': return 'Withdrawn'
  }
}
