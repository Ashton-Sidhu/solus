import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildHandoff,
  composeHandoffSeed,
} from '@solus/server/execution/agents/session-handoff'

describe('session handoff', () => {
  let handoffRoot: string

  beforeEach(() => {
    handoffRoot = mkdtempSync(join(tmpdir(), 'solus-handoff-test-'))
  })

  afterEach(() => {
    rmSync(handoffRoot, { recursive: true, force: true })
  })

  test('labels visible history and excludes private reasoning and tool state', async () => {
    const handoff = await buildHandoff('session-r', '/project', {
      loadSession: async () => [
        { role: 'user', content: 'Fix the bug', timestamp: 1 },
        { role: 'reasoning', content: 'The bug is a null deref in the parser', timestamp: 2 },
        { role: 'tool', content: 'ran the tests', toolName: 'Bash', timestamp: 3 },
        { role: 'assistant', content: 'Fixed it', timestamp: 4 },
      ],
      handoffRoot,
      fromProvider: 'claude-code',
      now: () => 1,
    })

    expect(handoff.transcriptFilePath).toBe(join(handoffRoot, 'session-r-transcript-1.md'))
    expect(handoff.reasoningFilePath).toBeNull()
    const text = readFileSync(handoff.transcriptFilePath!, 'utf8')
    expect(text).toContain('Source session: session-r')
    expect(text).toContain('Turn 1 — Assistant (claude-code); item 4; time 4')
    expect(text).toContain('Fix the bug')
    expect(text).toContain('Fixed it')
    expect(text).not.toContain('null deref')
    expect(text).not.toContain('ran the tests')
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
    const text = readFileSync(handoff.transcriptFilePath!, 'utf8')
    expect(text.indexOf('Visible request')).toBeLessThan(text.indexOf('Visible answer'))
    expect(text).not.toContain('hidden')
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

  test('never refers to an old reasoning receipt', () => {
    const seed = composeHandoffSeed({
      fromProvider: 'claude-code',
      transcriptFilePath: '/tmp/solus-handoffs/session-r-transcript-1.md',
      reasoningFilePath: '/tmp/solus-handoffs/session-r-reasoning-1.md',
    })

    expect(seed).toContain('previously run by claude-code')
    expect(seed).toContain('transcript at: /tmp/solus-handoffs/session-r-transcript-1.md')
    expect(seed).not.toContain('reasoning at:')
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

  test('bounds long history, preserves attribution and order, and provides retrieval', async () => {
    const handoff = await buildHandoff('source', '/project', {
      handoffRoot, historyTokens: 700,
      fromProvider: 'claude-code',
      loadSession: async () => [
        { role: 'user', content: 'Original objective', timestamp: 1, messageId: 'u1' },
        { role: 'assistant', content: 'Old response'.repeat(200), timestamp: 2 },
        { role: 'user', content: 'Next step', timestamp: 3 },
        { role: 'assistant', content: 'Recent response', timestamp: 4, sourceProvider: 'codex', sourceSessionId: 'native-2' },
      ],
    })
    const text = readFileSync(handoff.transcriptFilePath!, 'utf8')
    expect(text).toContain('1 visible history items omitted')
    expect(text).toContain('read_session with session_id "source"')
    expect(text).toContain('message u1')
    expect(text).toContain('Assistant (codex)')
    expect(text).toContain('session native-2')
    expect(text.indexOf('Original objective')).toBeLessThan(text.indexOf('Next step'))
    expect(text).not.toContain('Old response')
  })

  test('rejects required context without shortening the new prompt', async () => {
    await expect(buildHandoff('source', '/project', {
      handoffRoot, contextWindow: 9_000, nextPrompt: 'new prompt'.repeat(300),
      loadSession: async () => [{ role: 'user', content: 'Required objective', timestamp: 1 }],
    })).rejects.toThrow('cannot fit')
  })

  test('carries partial visible work once and labels its source state', async () => {
    const messages = [{ role: 'user' as const, content: 'Make a change', timestamp: 1 }]
    const handoff = await buildHandoff('source', '/project', {
      handoffRoot, loadSession: async () => messages, partialReply: 'The first file is changed.', sourceStatus: 'interrupted',
    })
    expect(readFileSync(handoff.transcriptFilePath!, 'utf8')).toContain('source session interrupted')
    expect(readFileSync(handoff.transcriptFilePath!, 'utf8')).toContain('The first file is changed.')
    expect(messages).toHaveLength(1)
  })
})
