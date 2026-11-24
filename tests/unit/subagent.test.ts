import { describe, expect, test } from 'bun:test'
import {
  parseSubagentInput,
  subagentInputText,
  subagentTitle,
} from '@solus/contracts/subagent-input'

describe('sub-agent input', () => {
  test('extracts the Solus MCP prompt', () => {
    const input = parseSubagentInput(JSON.stringify({
      description: 'Inspect auth',
      prompt: 'Read the auth flow and report risks.',
      model: 'gpt-5.5',
    }))

    expect(subagentInputText(input)).toBe('Read the auth flow and report risks.')
  })

  test('supports alternate sub-agent task fields', () => {
    expect(subagentInputText(parseSubagentInput(JSON.stringify({
      task: 'Review the database migration.',
    })))).toBe('Review the database migration.')
    expect(subagentInputText(parseSubagentInput(JSON.stringify({
      instructions: 'Find missing accessibility labels.',
    })))).toBe('Find missing accessibility labels.')
  })

  test('preserves raw-string sub-agent input', () => {
    expect(subagentInputText(parseSubagentInput('Summarize the test failures.')))
      .toBe('Summarize the test failures.')
  })
})

describe('sub-agent title', () => {
  // The host's digest, the conversation's card, and the native app all name an
  // agent with this one rule, so the Agents section and the card agree.
  test('is the description, else the prompt on one line, else a placeholder', () => {
    expect(subagentTitle(JSON.stringify({ description: '  Audit auth ', prompt: 'Read every file' }))).toBe('Audit auth')
    expect(subagentTitle(JSON.stringify({ prompt: 'Read every\n  file' }))).toBe('Read every file')
    expect(subagentTitle(JSON.stringify({ task: 'Run the tests' }))).toBe('Run the tests')
    expect(subagentTitle('Fix the build')).toBe('Fix the build')
    expect(subagentTitle(undefined)).toBe('Sub-agent')
    expect(subagentTitle('{}')).toBe('Sub-agent')
  })
})
