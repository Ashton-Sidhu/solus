import { describe, expect, test } from 'bun:test'
import type { Prompt, Session } from '@solus/contracts/types'
import type { PlanStore } from '@solus/workspace-ui/contexts/plans/plan.store.svelte'
import type { WorksStore } from '@solus/workspace-ui/contexts/works/works.store.svelte'
import { PromptComposer } from '@solus/workspace-ui/contexts/workspace/prompt-composer'

describe('a referenced work in the prompt', () => {
  test('names the work id the read_work tool takes, never a file path', () => {
    // WHY: a work is a database row on its host. A path under `.solus/works`
    // would send the agent to a file that does not exist.
    const composer = new PromptComposer(
      { get: () => null } as unknown as PlanStore,
      { get: (workId: string) => (workId === 'work-a' ? { id: 'work-a', type: 'artifact' } : undefined) } as unknown as WorksStore,
    )
    const prompt = {
      planRefs: [],
      workRefs: [{ workId: 'work-a', title: 'Architecture', type: 'artifact' }],
      sessionRefs: [],
      attachments: [],
    } as unknown as Prompt
    const session = {
      id: 'session',
      agentSessionId: null,
      boundWorkId: null,
      task: { kind: 'none' },
      run: { serverId: 'local' },
    } as unknown as Session

    const composed = composer.compose('Review this', prompt, session)

    expect(composed).toContain('[Referenced Work: Architecture]')
    expect(composed).toContain('Type: artifact')
    expect(composed).toContain('Work id: work-a (read it with read_work)')
    expect(composed).not.toContain('File path:')
    expect(composed).not.toContain('.solus/works')
  })
})

describe('a host chip in the prompt', () => {
  test('adds the note for the agent after the typed text, and leaves a prompt with no host as it is', () => {
    // WHY: docs/plans/host-fleet.md D12. The chip is a link in the typed text;
    // the note that says what the agent can do with the host rides the prompt
    // the host runs, not the text the person sees.
    const composer = new PromptComposer({ get: () => null } as unknown as PlanStore, { get: () => undefined } as unknown as WorksStore)
    const prompt = { planRefs: [], workRefs: [], sessionRefs: [], attachments: [] } as unknown as Prompt
    const session = { id: 'session', agentSessionId: null, boundWorkId: null, task: { kind: 'none' }, run: { location: { checkout: { serverId: 'local' } } } } as unknown as Session
    const typed = 'Run the tests on [studio-mini](host://ref?serverId=install-1&state=online).'

    const composed = composer.compose(typed, prompt, session)

    expect(composed.startsWith(`${typed}\n\n[Referenced Host: "studio-mini" (host: install-1)]`)).toBe(true)
    expect(composed).toContain('It is not the host you run on.')
    expect(composer.compose('Review this', prompt, session)).toBe('Review this')
  })
})
