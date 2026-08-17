import { describe, expect, test } from 'bun:test'
import type { Prompt, Session } from '../../src/shared/types'
import type { TasksStore } from '../../src/renderer/contexts/tasks/tasks.store.svelte'
import type { PlanStore } from '../../src/renderer/contexts/plans/plan.store.svelte'
import type { WorksStore } from '../../src/renderer/contexts/works/works.store.svelte'
import { PromptComposer } from '../../src/renderer/contexts/workspace/prompt-composer'
import { taskBindingSessionId } from '../../src/renderer/contexts/workspace/session-draft.svelte'

describe('session task binding identity', () => {
  test('a handoff keeps its stable Solus id when the provider thread changes', () => {
    const session = {
      handoffId: 'solus-session',
      agentSessionId: 'second-provider-session',
    } as Session

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
