import type { PullRequestCard } from '@solus/client-core/pull-request-card'
import type { SessionPullRequestWatchOutcome } from '@solus/contracts/session-pull-requests'
import { relativeTime } from '../../../lib/relative-time'

/** The line under a pull request card's title: `owner/repo #12 · author · 4m ago`. */
export function pullRequestCardMeta(card: PullRequestCard, now = Date.now()): string {
  return [card.reference, card.author, card.openedAt === null ? null : relativeTime(card.openedAt, now)]
    .filter((part) => part !== null)
    .join(' · ')
}

/** Why the host did not start a watch from the card, or null when the request is done. */
export function watchRefusal(outcome: SessionPullRequestWatchOutcome): string | null {
  switch (outcome) {
    case 'started':
    case 'already-watching':
    case 'stopped':
      return null
    case 'session-settled':
      return 'This session is settled. Make it active to watch its pull request.'
    case 'not-linked':
      return 'This pull request is no longer linked to the session.'
    case 'missing':
      return 'The code host no longer has this pull request.'
    case 'merged':
    case 'closed':
      return `This pull request is ${outcome}, so there is nothing to watch.`
  }
}
