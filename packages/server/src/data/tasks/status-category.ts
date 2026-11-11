import type { TaskStatusCategory } from '@solus/contracts/task-sources'

/**
 * The status category rules (docs/plans/provider-owned-tasks.md §4.5). A
 * category is the one coarse fact Solus derives from a provider's state or
 * column: `open`, `active` or `done`. Each rule is one pure function.
 */

/** Jira gives the category of each status: `new`, `indeterminate` or `done`. A key Solus does not know is `open`. */
export function jiraStatusCategory(statusCategoryKey: string): TaskStatusCategory {
  if (statusCategoryKey === 'done') return 'done'
  if (statusCategoryKey === 'indeterminate') return 'active'
  return 'open'
}

/** A GitHub issue is open or closed. GitHub has no state for work in progress. */
export function githubIssueCategory(state: 'OPEN' | 'CLOSED'): TaskStatusCategory {
  return state === 'CLOSED' ? 'done' : 'open'
}

const DONE_OPTION = /\b(done|complete|completed|closed|shipped|merged|released)\b/i
const ACTIVE_OPTION = /\b(in[\s_-]?progress|in[\s_-]?review|review|doing|started|active)\b/i

/** A GitHub Project Status option has only a name, so Solus detects the
 *  category from it. An option Solus does not know is `open`. */
export function githubProjectOptionCategory(optionName: string): TaskStatusCategory {
  if (DONE_OPTION.test(optionName)) return 'done'
  if (ACTIVE_OPTION.test(optionName)) return 'active'
  return 'open'
}

/** `Task.category`: `done` when the provider's state is done; else `active`
 *  when the state or one column of the task is active; else `open`. */
export function taskCategory(state: TaskStatusCategory, columns: readonly TaskStatusCategory[]): TaskStatusCategory {
  if (state === 'done') return 'done'
  if (state === 'active' || columns.includes('active')) return 'active'
  return 'open'
}
