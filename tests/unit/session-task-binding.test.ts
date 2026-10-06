import { describe, expect, test } from 'bun:test'
import type { Prompt, Session } from '@solus/contracts/types'
import type { PlanStore } from '@solus/workspace-ui/contexts/plans/plan.store.svelte'
import type { WorksStore } from '@solus/workspace-ui/contexts/works/works.store.svelte'
import { PromptComposer } from '@solus/workspace-ui/contexts/workspace/prompt-composer'

describe('session task binding identity', () => {
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
