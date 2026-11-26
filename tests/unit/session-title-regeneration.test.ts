import { describe, expect, test } from 'bun:test'
import { sessionTitleRegenerationInput } from '@solus/workspace-ui/contexts/workspace/session-title-regeneration'

describe('session title regeneration input', () => {
  test('uses indexed metadata when the conversation transcript is not mounted', () => {
    // WHY: sidebar and picker rows can exist before their conversation view has
    // loaded, but title regeneration must still work from that closed state.
    expect(sessionTitleRegenerationInput([], '  Add a closed-session fallback  '))
      .toBe('Add a closed-session fallback')
  })

  test('prefers the mounted opening prompt when it is available', () => {
    expect(sessionTitleRegenerationInput([
      { role: 'assistant', content: 'Ready.' },
      { role: 'user', content: '  Use the live transcript  ' },
    ], 'Older indexed text')).toBe('Use the live transcript')
  })

  test('removes appended reference context from the mounted prompt', () => {
    const prompt = [
      'Use the selected plan',
      '',
      '[Referenced Plan: "Release" (plan_id: plan-1)]',
    ].join('\n')

    expect(sessionTitleRegenerationInput([{ role: 'user', content: prompt }]))
      .toBe('Use the selected plan')
  })
})
