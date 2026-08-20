import { describe, expect, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import type { Task } from '@solus/contracts/task-types'
import { shouldReturnToActiveSession } from '@solus/workspace-ui/contexts/workspace/settings-exit'

function session(started = true): Pick<
  Session,
  'id' | 'agentSessionId' | 'handoffId' | 'status' | 'messages'
> {
  return {
    id: 'session-1',
    agentSessionId: started ? 'agent-1' : null,
    handoffId: null,
    status: 'idle',
    messages: [],
  }
}

function lookup(status: Task['status'] | null) {
  return {
    taskForSession: (): Pick<Task, 'status'> | null => status ? { status } : null,
  }
}

describe('closing Settings', () => {
  test('returns to sessions for current work', () => {
    // WHY: in-progress and in-review sessions remain useful destinations when
    // Settings closes, including when the task belongs to a remote host.
    expect(shouldReturnToActiveSession(session(), lookup('in_progress'))).toBe(true)
    expect(shouldReturnToActiveSession(session(), lookup('in_review'))).toBe(true)
  })

  test('uses the composer when the selected task is not current work', () => {
    // WHY: closing Settings must not expose an empty or stale chat for work
    // that is still in the backlog or has already finished.
    expect(shouldReturnToActiveSession(session(), lookup('todo'))).toBe(false)
    expect(shouldReturnToActiveSession(session(), lookup('done'))).toBe(false)
    expect(shouldReturnToActiveSession(session(false), lookup(null))).toBe(false)
  })

  test('keeps a started legacy session that has no task', () => {
    // WHY: older sessions can predate task binding. They are still valid chat
    // destinations and must not be replaced only because no task is found.
    expect(shouldReturnToActiveSession(session(), lookup(null))).toBe(true)
  })
})
