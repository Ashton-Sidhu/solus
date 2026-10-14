import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from '@solus/server/execution/agents/system-hint'

describe('system prompt composition', () => {
  test('adds no Solus-authored behavior when the user configured none', () => {
    expect(buildSystemPrompt({})).toBe('')
  })

  test('contains only the user\'s extra instructions, trimmed', () => {
    expect(buildSystemPrompt({ extraInstructions: '  Prefer short answers.  ' })).toBe([
      'User extra instructions:',
      'Prefer short answers.',
    ].join('\n'))
  })
})
