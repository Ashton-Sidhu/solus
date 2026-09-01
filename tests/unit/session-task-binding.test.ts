import { describe, expect, test } from 'bun:test'
import type { Prompt, Session } from '@solus/contracts/types'
import type { TasksStore } from '@solus/workspace-ui/contexts/tasks/tasks.store.svelte'
import type { PlanStore } from '@solus/workspace-ui/contexts/plans/plan.store.svelte'
import type { WorksStore } from '@solus/workspace-ui/contexts/works/works.store.svelte'
import { PromptComposer } from '@solus/workspace-ui/contexts/workspace/prompt-composer'
import { taskBindingSessionId } from '@solus/workspace-ui/contexts/workspace/session-draft.svelte'

describe('session task binding identity', () => {
  test('a regular session uses its stable Solus id after restoration', () => {
    const session = {
      id: 'solus-session',
      agentSessionId: 'provider-session',
    }

    // WHY: the provider thread id is replaceable and differs from the id used
    // to restore the tab. A task linked under it disappears after restart, so a
    // follow-up cannot reopen a completed task.
    expect(taskBindingSessionId(session)).toBe('solus-session')
  })

  test('a handoff keeps its stable Solus id when the provider thread changes', () => {
    const session = {
      id: 'original-solus-session',
      handoffId: 'solus-session',
      agentSessionId: 'second-provider-session',
    }

    // WHY: using the provider id here makes the first prompt after a handoff mint
    // a second task, which the sidebar then renders beside the original attempt.
    expect(taskBindingSessionId(session)).toBe('solus-session')
  })

  test('the prompt keeps the original task after a provider handoff', () => {
    const requestedSessionIds: Array<string | null | undefined> = []
    const tasksStore = {
      tasks: [{ id: 'task-1', title: 'Testing Handoff Feature' }],
      taskForSession: (sessionId: string | null | undefined) => {
        requestedSessionIds.push(sessionId)
        return sessionId === 'solus-session'
          ? { id: 'task-1', title: 'Testing Handoff Feature' }
          : null
      },
    } as unknown as TasksStore
    const composer = new PromptComposer(
      { get: () => null } as unknown as PlanStore,
      { get: () => null } as unknown as WorksStore,
      tasksStore,
    )
    const prompt = {
      planRefs: [],
      workRefs: [],
      sessionRefs: [],
      attachments: [],
    } as unknown as Prompt
    const session = {
      id: 'original-solus-session',
      handoffId: 'solus-session',
      agentSessionId: null,
      task: { kind: 'new' },
      boundWorkId: null,
    } as unknown as Session

    const composed = composer.compose('Continue the work', prompt, session)

    expect(requestedSessionIds).toEqual(['solus-session'])
    expect(composed).toContain('[Working On Task "Testing Handoff Feature" (task_id: task-1)]')
  })
})
