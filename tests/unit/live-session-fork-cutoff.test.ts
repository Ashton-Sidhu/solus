import { describe, expect, test } from 'bun:test'
import { findClaudeForkResumeId } from '@solus/server/agents/claude/claude-session-helpers'
import { codexForkCutoffTurnId } from '@solus/server/agents/codex/codex-utils'

function claudeLine(
  type: 'user' | 'assistant',
  uuid: string,
  content: string,
  extras: { isMeta?: boolean; parent_tool_use_id?: string } = {},
): string {
  return JSON.stringify({
    type,
    uuid,
    timestamp: '2026-08-14T00:00:00.000Z',
    message: { content },
    ...extras,
  })
}

describe('live-session fork cutoff', () => {
  test('Claude resumes at the assistant message before the latest user prompt', () => {
    const lines = [
      claudeLine('user', 'user-1', 'First request'),
      claudeLine('assistant', 'assistant-1', 'First answer'),
      claudeLine('user', 'meta-1', 'Injected context', { isMeta: true }),
      claudeLine('assistant', 'sidechain-1', 'Subagent answer', { parent_tool_use_id: 'tool-1' }),
      claudeLine('user', 'user-2', 'Live request'),
      claudeLine('assistant', 'assistant-live', 'Partial live answer'),
    ]

    expect(findClaudeForkResumeId(lines)).toBe('assistant-1')
  })

  test('Codex includes the last completed turn when the active turn is present', () => {
    const turns = [{ id: 'turn-1' }, { id: 'turn-2' }]

    expect(codexForkCutoffTurnId(turns, 'turn-2')).toBe('turn-1')
  })

  test('Codex keeps the last returned turn when the active turn is not persisted yet', () => {
    const turns = [{ id: 'turn-1' }]

    expect(codexForkCutoffTurnId(turns, 'turn-2')).toBe('turn-1')
  })

  test('Codex excludes the latest turn if it settled after the fork was requested', () => {
    const turns = [{ id: 'turn-1' }, { id: 'turn-2' }]

    expect(codexForkCutoffTurnId(turns, null)).toBe('turn-1')
  })
})
