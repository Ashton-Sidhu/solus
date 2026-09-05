import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from '@solus/server/agents/system-hint'

describe('system prompt composition', () => {
  test('adds no Solus-authored behavior when the user configured none', () => {
    expect(buildSystemPrompt({})).toBe('')
  })

  test('contains only app-wide and model-specific user instructions', () => {
    expect(buildSystemPrompt({
      extraInstructions: '  Prefer short answers.  ',
      modelInstructions: '\nUse the fast test target.\n',
    })).toBe([
      'User extra instructions:',
      'Prefer short answers.',
      '',
      'Model-specific instructions:',
      'Use the fast test target.',
    ].join('\n'))
  })
})
