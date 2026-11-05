import { describe, expect, test } from 'bun:test'
import { restartContinuationPrompt } from '@solus/server/execution/sessions/restart-continuation'

describe('the restart continuation prompt', () => {
  // WHY: a restart can kill the work the agent left running. Told only to
  // continue, the agent waited for a result that could never come.
  test('names each kind of work that was running, once', () => {
    const prompt = restartContinuationPrompt({
      backgroundTools: [{ toolId: 'a', name: 'Bash' }, { toolId: 'b', name: 'Bash' }, { toolId: 'c', name: 'Child agent (Explore)' }],
    })
    expect(prompt).toContain('running: Bash, Child agent (Explore).')
  })

  // WHY: a command that ran to completion before the restart has already
  // changed the workspace; running it again can repeat a deploy or a push.
  test('tells the agent to confirm a command did not already take effect', () => {
    const prompt = restartContinuationPrompt({ backgroundTools: [{ toolId: 'a', name: 'Bash' }] })
    expect(prompt).toContain('A command may already have finished and taken effect, so confirm its result before you run it again.')
    expect(prompt).not.toContain('More tools were running')
  })

  // WHY: the list holds at most 32 tools. Without this, the agent would read
  // the list as complete and miss the work that did not fit.
  test('says the list is incomplete when more tools ran than it holds', () => {
    const prompt = restartContinuationPrompt({ backgroundTools: [{ toolId: 'a', name: 'Bash' }], moreToolsRunning: true })
    expect(prompt).toContain('running: Bash. More tools were running than this list shows.')
  })

  test('a run with nothing in flight is only continued', () => {
    expect(restartContinuationPrompt({ backgroundTools: [] })).toBe('Continue where you left off')
  })
})
