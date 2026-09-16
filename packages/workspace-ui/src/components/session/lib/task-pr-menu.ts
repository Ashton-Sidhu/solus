import type { TaskPrChoice } from './task-list'
import { titleWithoutPrRef } from '../../tasks/task-page/lib/task-prs'

/** The reference is shown separately. Prefer the current title over the link snapshot. */
export function taskPrMenuTitle(choice: TaskPrChoice): string {
  return titleWithoutPrRef(
    (choice.pullRequest?.title || choice.title).trim(),
    `#${choice.number}`,
  ) || 'Pull request'
}
