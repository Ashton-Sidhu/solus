import { describe, expect, test } from 'bun:test'
import { makeSession } from '@solus/workspace-ui/contexts/workspace/session.factories'
import {
  requestedTaskTarget,
  taskTargetFrom,
} from '@solus/workspace-ui/contexts/workspace/session-draft.svelte'

const settings = { rateLimitBehavior: 'ask' } as Parameters<typeof makeSession>[0]

describe('the task a new session files under', () => {
  test('a session has no task unless it joins one', () => {
    // WHY: a session never makes a task of its own. A task is made by a
    // person, an agent, a ticket or an automation, and a session joins it
    // (docs/plans/task-conversation.md, decision 8).
    expect(makeSession(settings).task).toEqual({ kind: 'none' })
    expect(requestedTaskTarget({ freshTask: true }, null)).toEqual({ kind: 'none' })
    expect(requestedTaskTarget({}, null)).toEqual({ kind: 'none' })
  })

  test('a fresh session leaves the task of the session it was opened from', () => {
    expect(requestedTaskTarget({ freshTask: true }, 'task-1')).toEqual({ kind: 'none' })
    expect(requestedTaskTarget({ withoutTask: true }, 'task-1')).toEqual({ kind: 'none' })
  })

  test('a session started inside a task is more of that task', () => {
    expect(requestedTaskTarget({}, 'task-1')).toEqual({ kind: 'existing', taskId: 'task-1' })
  })

  test('a named task wins, and carries the lead role when asked', () => {
    expect(requestedTaskTarget({ taskId: 'task-2' }, 'task-1')).toEqual({ kind: 'existing', taskId: 'task-2' })
    expect(requestedTaskTarget({ taskId: 'task-2', taskRole: 'lead' }, null))
      .toEqual({ kind: 'existing', taskId: 'task-2', role: 'lead' })
  })

  test('a restored tab files under the task it was saved with, or under none', () => {
    expect(taskTargetFrom({ pendingTaskId: 'task-1' })).toEqual({ kind: 'existing', taskId: 'task-1' })
    expect(taskTargetFrom({ pendingTaskId: null })).toEqual({ kind: 'none' })
    expect(taskTargetFrom({})).toEqual({ kind: 'none' })
  })
})
