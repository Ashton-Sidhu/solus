import { describe, expect, test } from 'bun:test'
import type { Task } from '../../src/shared/task-types'
import { railSubtaskRow } from '../../src/renderer/components/project-panel/lib/rail-task-card'

function subtask(status: Task['status']): Task {
  return {
    id: 'child',
    providerId: 'local',
    kind: 'task',
    title: 'Restore GitHub connection state',
    body: '',
    status,
    url: null,
    labels: [],
    parentId: 'parent',
    updatedAt: 1,
  }
}

describe('project-panel task family', () => {
  test('keeps an unstarted sibling visible beside the current subtask', () => {
    // WHY: the session sidebar shows the whole durable task family. The project
    // rail must not drop a sibling only because it has no session link yet.
    expect(railSubtaskRow(subtask('todo'), 'another-child', 0)).toMatchObject({
      statusLabel: 'To do',
      sessionLabel: 'No sessions',
      current: false,
      dimmed: false,
    })
  })

  test('marks the focused child and keeps completed siblings as history', () => {
    expect(railSubtaskRow(subtask('done'), 'child', 2)).toMatchObject({
      statusLabel: 'Done',
      sessionLabel: '2 sessions',
      current: true,
      dimmed: true,
    })
  })
})
