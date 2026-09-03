import { describe, expect, test } from 'bun:test'
import {
  SWIPE_FULL_COMMIT_RATIO,
  SWIPE_REVEAL_COMMIT_RATIO,
  swipeRelease,
} from '@solus/workspace-ui/lib/swipe-actions'

describe('swipe action release', () => {
  test('opens after one quarter of the tray instead of half of it', () => {
    // WHY: half of four controls takes too much thumb travel. One quarter is
    // about one control width, while still clearing ordinary touch drift.
    const revealWidth = 256
    const commit = revealWidth * SWIPE_REVEAL_COMMIT_RATIO
    expect(swipeRelease(commit - 1, revealWidth, 320, false, false)).toBe('closed')
    expect(swipeRelease(commit, revealWidth, 320, false, false)).toBe('revealed')
  })

  test('closes after the same travel in the opposite direction', () => {
    const revealWidth = 256
    const commit = revealWidth * SWIPE_REVEAL_COMMIT_RATIO
    expect(swipeRelease(revealWidth - commit + 1, revealWidth, 320, false, true))
      .toBe('revealed')
    expect(swipeRelease(revealWidth - commit, revealWidth, 320, false, true)).toBe('closed')
  })

  test('a status-only row always rests at the controls instead of choosing one', () => {
    // WHY: no status is universally safe. Even a long swipe only reveals the
    // choices when the host supplies no full-swipe action.
    expect(swipeRelease(256, 256, 320, false, false)).toBe('revealed')
  })

  test('a host can still opt into an explicit full-swipe action', () => {
    const width = 320
    expect(swipeRelease(width * SWIPE_FULL_COMMIT_RATIO, 204, width, true, false))
      .toBe('revealed')
    expect(swipeRelease(width * SWIPE_FULL_COMMIT_RATIO + 1, 204, width, true, false))
      .toBe('full')
    expect(swipeRelease(204, 204, width, true, true)).toBe('revealed')
  })
})

describe('mobile Tasks page status controls', () => {
  test('puts every board workflow state behind the compact row swipe', async () => {
    // WHY: the task page must expose the same status capability on a phone as
    // its desktop board. A gesture with no controls, or controls not connected
    // to the page update path, does not satisfy that capability.
    const row = await Bun.file(
      'packages/workspace-ui/src/components/tasks/TaskListRow.svelte',
    ).text()
    const page = await Bun.file(
      'packages/workspace-ui/src/components/tasks/TasksPage.svelte',
    ).text()

    expect(row).toContain('use:swipeActions')
    expect(row).toContain('<TaskStatusSwipeControls')
    expect(row).toContain('onSetStatus(next)')
    expect(page).toContain('revealed={revealedTaskId === item.row.key}')
    expect(page).toContain('if (recordTask) void onSetStatus(recordTask, status)')
  })

  test('uses the same status controls on mobile picker task rows', async () => {
    // WHY: the task/session picker is another mobile task list. Its task rows
    // must expose the same workflow choices, while session rows stay inert.
    const pickerRow = await Bun.file(
      'packages/workspace-ui/src/components/session/unified-picker/UnifiedPickerRow.svelte',
    ).text()
    const picker = await Bun.file(
      'packages/workspace-ui/src/components/session/unified-picker/UnifiedPicker.svelte',
    ).text()

    const taskStart = pickerRow.indexOf('{:else if row.kind === "task"}')
    const taskBranch = pickerRow.slice(taskStart, pickerRow.indexOf('{:else}', taskStart + 1))
    expect(taskBranch).toContain('<TaskStatusSwipeControls')
    expect(taskBranch).toContain('use:swipeActions')
    expect(taskBranch).toContain('enabled: mobile')
    expect(picker).toContain('onSetStatus={(task, status) => void setStatus(task, status)}')
  })
})
