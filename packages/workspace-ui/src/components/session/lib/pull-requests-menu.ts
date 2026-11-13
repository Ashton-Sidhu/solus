import { prStatusBadge, REQUIRED_CHECKS_FAILING_BADGE, type PrStatusBadge } from '../../prs/lib/pr-utils'
import { taskPrMenuTitle } from './task-pr-menu'
import type { TaskPrChoice } from './task-list'

/** One pull request in a session's pull request menu. */
export interface PullRequestMenuRow {
  key: string
  choice: TaskPrChoice
  title: string
  /** `#412`, or `site#52` when the session's pull requests span repositories. */
  reference: string
  /** The state in words: the second line names it, the glyph only colours it. */
  stateLabel: string
  badge: PrStatusBadge | null
  /** The state line's colour: only a state that blocks the merge is tinted. */
  stateTone: string | undefined
  /** Merged or closed: it sinks below the open ones and dims. */
  isSettled: boolean
}

/**
 * The menu's rows: open pull requests first, settled ones after, each group in
 * the order the session linked them. A number alone names a pull request only
 * inside one repository, so once the session has two repositories every row
 * names its repository.
 */
export function pullRequestMenuRows(choices: readonly TaskPrChoice[]): PullRequestMenuRow[] {
  const repositories = new Set(choices.map((choice) => choice.targetScope.toLowerCase()))
  const rows = choices.map((choice): PullRequestMenuRow => {
    const pullRequest = choice.pullRequest
    const badge = choice.requiredChecksFail && pullRequest?.state === 'open' && !pullRequest.draft
      ? REQUIRED_CHECKS_FAILING_BADGE
      : prStatusBadge(pullRequest)
    return {
      key: `${choice.targetScope}:${choice.number}`,
      choice,
      title: taskPrMenuTitle(choice),
      reference: `${repositories.size > 1 ? (choice.targetScope.split('/').pop() ?? '') : ''}#${choice.number}`,
      stateLabel: badge?.label ?? 'Status unavailable',
      badge,
      stateTone: badge === REQUIRED_CHECKS_FAILING_BADGE || badge?.label === 'Merge conflicts' ? badge.tone : undefined,
      isSettled: pullRequest?.state === 'merged' || pullRequest?.state === 'closed',
    }
  })
  return [...rows.filter((row) => !row.isSettled), ...rows.filter((row) => row.isSettled)]
}
