import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildHandoff,
  composeHandoffSeed,
} from '../../src/main/agents/session-handoff'

describe('session handoff', () => {
  let handoffRoot: string

  beforeEach(() => {
    handoffRoot = mkdtempSync(join(tmpdir(), 'solus-handoff-test-'))
  })

  afterEach(() => {
    rmSync(handoffRoot, { recursive: true, force: true })
  })

  test('writes the conversation to a transcript file and reasoning to its own file', async () => {
    const handoff = await buildHandoff('session-r', '/project', {
      loadSession: async () => [
        { role: 'user', content: 'Fix the bug', timestamp: 1 },
        { role: 'reasoning', content: 'The bug is a null deref in the parser', timestamp: 2 },
        { role: 'tool', content: 'ran the tests', toolName: 'Bash', timestamp: 3 },
        { role: 'assistant', content: 'Fixed it', timestamp: 4 },
      ],
      handoffRoot,
      now: () => 1,
    })

    expect(handoff.transcriptFilePath).toBe(join(handoffRoot, 'session-r-transcript-1.md'))
    expect(handoff.reasoningFilePath).toBe(join(handoffRoot, 'session-r-reasoning-1.md'))
    expect(readFileSync(handoff.transcriptFilePath!, 'utf8')).toBe('User: Fix the bug\n\nAssistant: Fixed it\n')
    expect(readFileSync(handoff.reasoningFilePath!, 'utf8')).toBe('The bug is a null deref in the parser\n')
  })

  test('drops tool noise and blank turns from the carried transcript', async () => {
    const handoff = await buildHandoff('session-1', '/project', {
      loadSession: async () => [
        { role: 'user', content: '  ', timestamp: 1 },
        { role: 'tool', content: 'hidden tool call', timestamp: 2 },
        { role: 'tool_result', content: 'hidden result', timestamp: 3 },
        { role: 'user', content: 'Visible request', timestamp: 4 },
        { role: 'assistant', content: 'Visible answer', timestamp: 5 },
      ],
      handoffRoot,
      now: () => 2,
    })

    expect(handoff.reasoningFilePath).toBeNull()
    expect(readFileSync(handoff.transcriptFilePath!, 'utf8')).toBe('User: Visible request\n\nAssistant: Visible answer\n')
  })

  test('writes nothing and returns null paths when the session has no carry-over turns', async () => {
    const handoff = await buildHandoff('session-empty', '/project', {
      loadSession: async () => [
        { role: 'tool', content: 'hidden tool call', timestamp: 1 },
      ],
      handoffRoot,
      now: () => 3,
    })

    expect(handoff).toEqual({ transcriptFilePath: null, reasoningFilePath: null })
  })

  test('composes takeover instructions that point at the transcript, then the reasoning file', () => {
    const seed = composeHandoffSeed({
      fromProvider: 'claude-code',
      transcriptFilePath: '/tmp/solus-handoffs/session-r-transcript-1.md',
      reasoningFilePath: '/tmp/solus-handoffs/session-r-reasoning-1.md',
    })

    expect(seed).toContain('previously run by claude-code')
    expect(seed.indexOf('transcript at: /tmp/solus-handoffs/session-r-transcript-1.md'))
      .toBeLessThan(seed.indexOf('reasoning at: /tmp/solus-handoffs/session-r-reasoning-1.md'))
  })

  test('omits the reasoning instruction when no reasoning was carried over', () => {
    const seed = composeHandoffSeed({
      fromProvider: 'codex',
      transcriptFilePath: '/tmp/solus-handoffs/session-1-transcript-2.md',
      reasoningFilePath: null,
    })

    expect(seed).toContain('transcript at: /tmp/solus-handoffs/session-1-transcript-2.md')
    expect(seed).not.toContain('reasoning at:')
  })

  test('skips file instructions entirely when there is nothing to carry over', () => {
    const seed = composeHandoffSeed({
      fromProvider: 'codex',
      transcriptFilePath: null,
      reasoningFilePath: null,
    })

    expect(seed).not.toContain('read the prior conversation transcript')
    expect(seed).toContain('answer the user\'s next message')
  })
})
