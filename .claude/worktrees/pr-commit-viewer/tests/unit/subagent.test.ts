import { describe, expect, test } from 'bun:test'
import {
  parseSubagentInput,
  subagentInputText,
} from '../../src/renderer/components/conversation/lib/subagent'

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
