import { describe, expect, test } from 'bun:test'
import type { Prompt, Session } from '@solus/contracts/types'
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

  test('the message carries no task block; the task rides the system prompt', () => {
    const composer = new PromptComposer(
      { get: () => null } as unknown as PlanStore,
      { get: () => null } as unknown as WorksStore,
    )
    const prompt = {
      planRefs: [],
      workRefs: [],
      sessionRefs: [],
      attachments: [],
    } as unknown as Prompt
    const session = {
      id: 'solus-session',
      agentSessionId: 'provider-session',
      task: { kind: 'existing', taskId: 'task-1' },
      boundWorkId: null,
    } as unknown as Session

    // WHY: the server appends the task packet to every run's system prompt. A
    // second block in each message repeated the header on every turn and told
    // the agent to fetch the task it already had.
    expect(composer.compose('Continue the work', prompt, session)).toBe('Continue the work')
  })
})
