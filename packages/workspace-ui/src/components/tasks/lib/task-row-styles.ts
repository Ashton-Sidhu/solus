/**
 * The task row's state glyph. It borrows the pull request row's inks, so a
 * colour means the same thing on both lists: green is open work, violet is
 * finished work. Work in progress takes the running tint.
 */
import { CircleCheck, CircleDot, CircleDotDashed } from '@lucide/svelte'
import type { IssueStatusCategory } from '@solus/contracts/task-sources'
import type { ListIcon } from '../../ui/list-page/list-page'
import { CATEGORY_META } from './tasks-api'

export interface TaskStatusGlyph {
  icon: ListIcon
  label: string
  /** The state's tone as text-colour classes, light and dark. */
  toneClass: string
}

const TASK_STATUS_ICON = {
  open: CircleDot,
  active: CircleDotDashed,
  done: CircleCheck,
} satisfies Record<IssueStatusCategory, ListIcon>

const TASK_STATUS_TONE = {
  open: 'text-emerald-600 dark:text-emerald-300/90',
  active: 'text-(--running)',
  done: 'text-violet-600 dark:text-violet-300/90',
} satisfies Record<IssueStatusCategory, string>

export function taskStatusGlyph(category: IssueStatusCategory): TaskStatusGlyph {
  return {
    icon: TASK_STATUS_ICON[category],
    label: CATEGORY_META[category].label,
    toneClass: TASK_STATUS_TONE[category],
  }
}
