import { describe, expect, test } from 'bun:test'
import {
  snoozedRowKeyForTab,
  type SidebarTask,
} from '@solus/workspace-ui/components/session/lib/task-list'

function sidebarTask(
  key: string,
  tabIds: string[],
  lifecycle: SidebarTask['lifecycle'],
  snoozedUntil = lifecycle === 'snoozed' ? 2_000 : 0,
): SidebarTask {
  return {
    id: key,
    key,
    title: key,
    projectKey: '/repo',
    projectLabel: 'repo',
    branchName: null,
    serverId: null,
    prNumber: null,
    status: 'idle',
    attention: null,
    unread: false,
    createdAt: 0,
    activityAt: 0,
    runStartedAt: 0,
    lifecycle,
    completedAt: 0,
    snoozedUntil,
    snoozeNote: null,
    lastReadAt: 0,
    woke: false,
    tabIds,
  }
}

describe('submitting a prompt to a snoozed session', () => {
  test('wakes the sidebar row that owns the target tab', () => {
    // WHY: a task row can own several session attempts. Sending to any one is
    // an explicit return to that work and must clear the row-level snooze.
    const tasks = [
      sidebarTask('task-1', ['tab-a', 'tab-b'], 'snoozed'),
    ]

    expect(snoozedRowKeyForTab(tasks, 'tab-b', 1_000)).toBe('task-1')
  })

  test('clears a snooze temporarily lifted by a question', () => {
    const tasks = [
      sidebarTask('task-1', ['tab-a'], 'active', 2_000),
    ]

    expect(snoozedRowKeyForTab(tasks, 'tab-a', 1_000)).toBe('task-1')
  })

  test('does not rewrite a row that is already awake', () => {
    const tasks = [
      sidebarTask('loose-tab', ['loose-tab'], 'active'),
    ]

    expect(snoozedRowKeyForTab(tasks, 'loose-tab', 1_000)).toBeNull()
  })
})
