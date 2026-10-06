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

  test('a run with nothing in flight is only continued', () => {
    expect(restartContinuationPrompt({ backgroundTools: [] })).toBe('Continue where you left off')
  })
})
