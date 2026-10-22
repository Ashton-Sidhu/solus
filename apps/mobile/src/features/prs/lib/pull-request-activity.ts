// Adapted from T3 Code apps/mobile/src/features/pull-requests/pullRequestActivityFilter.ts (MIT, see UPSTREAM.md).
import type { PrCommit, PrConversationItem, ReviewThread } from '@solus/contracts/providers'

/**
 * The Activity tab's filter. It narrows what the detail already holds;
 * nothing is read again.
 */

export interface ActivityFilter {
  kind: 'all' | 'comments' | 'commits'
  bots: boolean
  resolved: boolean
  newestFirst: boolean
}

export const DEFAULT_ACTIVITY_FILTER: ActivityFilter = { kind: 'all', bots: false, resolved: false, newestFirst: true }

export interface PullRequestActivity {
  comments: PrConversationItem[]
  threads: ReviewThread[]
  commits: PrCommit[]
}

function isBot(login: string | undefined): boolean {
  return !!login && login.endsWith('[bot]')
}

function eventCount(activity: PullRequestActivity): number {
  return activity.comments.length + activity.threads.length + activity.commits.length
}

export interface FilteredActivity {
  activity: PullRequestActivity
  /** How many items the filter hides. */
  hiddenCount: number
}

/** The activity the filter keeps. A thread stays whole: a bot reply does not
 *  hide a person's thread. A dismissed review counts as resolved. */
export function filterPullRequestActivity(activity: PullRequestActivity, filter: ActivityFilter): FilteredActivity {
  const threads = filter.kind === 'commits' ? [] : activity.threads.filter((thread) =>
    (filter.resolved || !thread.isResolved)
    && (filter.bots || thread.comments.some((comment) => !isBot(comment.author))))
  const comments = filter.kind === 'commits' ? [] : activity.comments.filter((item) =>
    (filter.bots || !isBot(item.author))
    && (filter.resolved || item.kind !== 'review' || item.reviewState !== 'DISMISSED'))
  const filtered = { comments, threads, commits: filter.kind === 'comments' ? [] : activity.commits }
  return { activity: filtered, hiddenCount: eventCount(activity) - eventCount(filtered) }
}
