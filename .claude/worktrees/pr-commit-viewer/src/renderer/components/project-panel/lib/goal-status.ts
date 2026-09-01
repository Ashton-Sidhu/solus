import type { ThreadGoal, ThreadGoalStatus } from '../../../../shared/types'

/** Statuses the user can't leave from the panel — pausing a finished or blocked
 *  goal is meaningless, so the pause control drops out for these. */
export function isGoalTerminal(status: ThreadGoalStatus): boolean {
  return status === 'complete' || status === 'blocked'
}

/** The rail header has room for one word, so the camelCase limit statuses get
 *  shortened rather than truncated mid-word. */
export function goalStatusLabel(status: ThreadGoalStatus): string {
  if (status === 'budgetLimited') return 'Budget'
  if (status === 'usageLimited') return 'Usage'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

/** The label's colour reads as severity, not as identity — the word already
 *  names the state. Green while the goal is healthy (being pursued, or landed),
 *  grey for a deliberate hold, amber for a limit the user can lift, red only for
 *  the one state that stopped the goal for good. Brand terracotta is reserved
 *  for "agent working" elsewhere, so an active goal takes the live green. */
export function goalStatusColor(status: ThreadGoalStatus): string {
  if (status === 'active') return 'var(--solus-status-live)'
  if (status === 'complete') return 'var(--solus-status-complete)'
  if (status === 'paused') return 'var(--solus-status-idle)'
  if (status === 'blocked') return 'var(--solus-status-error)'
  return 'var(--solus-art-2)'
}

/** The card clamps at six lines, so anything that can't fit inside them earns a
 *  "Show more". Cheap enough to run per render: characters cover long prose,
 *  newlines cover the short-bulleted objectives that wrap far taller. */
export function objectiveOverflows(objective: string): boolean {
  return objective.length > 260 || objective.split('\n').length > 6
}

/** The card's one-line footnote: what the goal has cost, the budget it is
 *  spending against when there is one, and how long it has been running. */
export function goalMetaLine(goal: ThreadGoal): string {
  const used = formatTokens(goal.tokensUsed ?? 0)
  const tokens = goal.tokenBudget === undefined ? used : `${used} / ${formatTokens(goal.tokenBudget)}`
  return `${tokens} tokens · ${formatElapsed(goal.timeUsedSeconds ?? 0)}`
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
