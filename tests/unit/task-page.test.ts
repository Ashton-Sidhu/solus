import { describe, expect, test } from 'bun:test'
import {
  taskPageCapabilities,
  taskProviderLabel,
  taskSessionLabel,
} from '../../src/renderer/components/tasks/task-page/lib/task-page'
import { taskRow } from '../../src/renderer/components/tasks/lib/tasks-list-view'
import { upstreamTaskDetails } from '../../src/renderer/contexts/tasks/upstream-task-details'
import type { Task } from '../../src/shared/task-types'

describe('task page session labels', () => {
  test('prefers the live title while the history index is catching up', () => {
    // WHY: a newly started attempt is mounted before its persisted session
    // metadata exists, but the task page must still show the title users see
    // on the tab and in the session sidebar.
    expect(taskSessionLabel({ sessionId: 'session-123', linkedAt: 1 }, 'Fix task labels')).toBe(
      'Fix task labels',
    )
  })

  test('uses persisted metadata for closed sessions', () => {
    expect(
      taskSessionLabel({
        sessionId: 'session-123',
        sessionTitle: 'Indexed session name',
        linkedAt: 1,
      }),
    ).toBe('Indexed session name')
  })

  test('shows the session id rather than claiming the session is untitled', () => {
    expect(taskSessionLabel({ sessionId: 'session-123', linkedAt: 1 })).toBe('session-123')
  })
})

describe('task page provider labels', () => {
  test('identifies GitHub as the owner of an upstream task', () => {
    // WHY: the task page action opens the upstream ticket, so its label must
    // name that provider rather than incorrectly describing it as local.
    expect(taskProviderLabel({ providerId: 'github' } as Task)).toBe('GitHub')
  })

  test('identifies a local task as living in Solus', () => {
    expect(taskProviderLabel({ providerId: 'local' } as Task)).toBe('Local task')
  })
})

describe('task page capabilities', () => {
  test('allows GitHub issue content edits and comments', () => {
    // WHY: the GitHub adapter already implements issue updates and comments;
    // the detail page must not hide those actions merely because it is upstream.
    expect(taskPageCapabilities({ providerId: 'github' } as Task)).toEqual({
      canEditContent: true,
      canEditPlanningFields: false,
      canComment: true,
    })
  })

  test('only enables GitHub planning fields when a Projects board owns them', () => {
    // WHY: due date and priority have no native issue fields off a Projects v2
    // board, so presenting those controls would accept edits GitHub cannot save.
    expect(taskPageCapabilities({
      providerId: 'github',
      canEditPlanningFields: true,
    } as Task).canEditPlanningFields).toBe(true)
  })
})

describe('task list assignee avatars', () => {
  test('uses the provider avatar for an assigned GitHub task', () => {
    // WHY: an issue assigned to the connected GitHub user should show their
    // recognizable profile image on the tasks page, not generated initials.
    const task = {
      id: '31',
      providerId: 'github',
      kind: 'task',
      title: 'GitHub issue',
      body: '',
      status: 'todo',
      url: 'https://github.com/example/solus/issues/31',
      assignee: 'octocat',
      assigneeAvatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
      labels: [],
      updatedAt: Date.parse('2026-08-04T12:00:00Z'),
    } satisfies Task

    expect(taskRow(task, 0, Date.parse('2026-08-04T13:00:00Z')).people).toEqual([
      expect.objectContaining({
        id: 'octocat',
        initials: 'OC',
        avatarUrl: task.assigneeAvatarUrl,
      }),
    ])
  })
})

describe('upstream task details', () => {
  test('adapts hydrated GitHub issue comments for the task page', () => {
    // WHY: selecting a GitHub row must use its upstream hydration instead of
    // asking the local SQLite task store for an unrelated numeric id.
    const task: Task = {
      id: '31',
      providerId: 'github',
      projectKey: '/workspace/solus',
      kind: 'task',
      title: 'GitHub issue',
      body: 'Issue body',
      status: 'todo',
      url: 'https://github.com/example/solus/issues/31',
      labels: [],
      updatedAt: Date.parse('2026-08-04T12:00:00Z'),
      raw: {
        comments: [{
          id: 'comment-1',
          author: { login: 'octocat' },
          body: 'A provider comment',
          createdAt: '2026-08-04T12:30:00Z',
        }],
      },
    }

    expect(upstreamTaskDetails(task, [task], [])).toMatchObject({
      task,
      links: [],
      events: [],
      comments: [{
        id: 'comment-1',
        taskId: '31',
        author: 'octocat',
        source: 'external',
        externalId: 'comment-1',
        body: 'A provider comment',
        createdAt: Date.parse('2026-08-04T12:30:00Z'),
      }],
    })
  })
})
