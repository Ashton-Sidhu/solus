import { describe, expect, test } from 'bun:test'
import type { Prompt, Session } from '@solus/contracts/types'
import type { TasksStore } from '@solus/workspace-ui/contexts/tasks/tasks.store.svelte'
import type { PlanStore } from '@solus/workspace-ui/contexts/plans/plan.store.svelte'
import type { WorksStore } from '@solus/workspace-ui/contexts/works/works.store.svelte'
import { PromptComposer } from '@solus/workspace-ui/contexts/workspace/prompt-composer'

describe('a referenced work in the prompt', () => {
  test('names the work id the read_work tool takes, never a file path', () => {
    // WHY: a work is a database row on its host. A path under `.solus/works`
    // would send the agent to a file that does not exist.
    const composer = new PromptComposer(
      { get: () => null } as unknown as PlanStore,
      { get: (workId: string) => (workId === 'work-a' ? { id: 'work-a', type: 'diagram' } : undefined) } as unknown as WorksStore,
      { tasks: [], taskForSession: () => null } as unknown as TasksStore,
    )
    const prompt = {
      planRefs: [],
      workRefs: [{ workId: 'work-a', title: 'Architecture', type: 'diagram' }],
      sessionRefs: [],
      attachments: [],
    } as unknown as Prompt
    const session = {
      id: 'session',
      agentSessionId: null,
      boundWorkId: null,
      task: { kind: 'new' },
      run: { serverId: 'local' },
    } as unknown as Session

    const composed = composer.compose('Review this', prompt, session)

    expect(composed).toContain('[Referenced Work: Architecture]')
    expect(composed).toContain('Type: diagram')
    expect(composed).toContain('Work id: work-a (read it with read_work)')
    expect(composed).not.toContain('File path:')
    expect(composed).not.toContain('.solus/works')
  })
})
