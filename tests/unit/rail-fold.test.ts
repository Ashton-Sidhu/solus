import { expect, it } from 'bun:test'
import { isRailFolded, RAIL_FOLD_MAX } from '@solus/workspace-ui/components/pr-review/lib/rail-rows'
import { isTaskRailFolded, TASK_RAIL_FOLD_MAX } from '@solus/workspace-ui/components/tasks/task-page/lib/task-page'

it('folds the PR rail only after its pane is measured', () => {
  expect(isRailFolded(0)).toBe(false)
  expect(isRailFolded(RAIL_FOLD_MAX)).toBe(true)
  expect(isRailFolded(RAIL_FOLD_MAX + 1)).toBe(false)
})

it('folds the task rail only after its pane is measured', () => {
  expect(isTaskRailFolded(0)).toBe(false)
  expect(isTaskRailFolded(TASK_RAIL_FOLD_MAX)).toBe(true)
  expect(isTaskRailFolded(TASK_RAIL_FOLD_MAX + 1)).toBe(false)
})
