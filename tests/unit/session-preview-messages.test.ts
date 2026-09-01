import { describe, expect, test } from 'bun:test'
import {
  extractPreviewMessages,
  truncateAtWord,
  type PreviewMessage,
} from '@solus/workspace-ui/lib/sessionPreviewMessages'

function msg(overrides: Partial<PreviewMessage> & { role: string; content: string }): PreviewMessage {
  return { toolName: undefined, ...overrides } as PreviewMessage
}

describe('extractPreviewMessages', () => {
  test('picks the first meaningful user message and the last meaningful assistant reply', () => {
    const messages: PreviewMessage[] = [
      msg({ role: 'user', content: 'Please fix the login bug' }),
      msg({ role: 'assistant', content: 'Sure, looking into it now' }),
      msg({ role: 'user', content: 'Any update?' }),
      msg({ role: 'assistant', content: 'Fixed — the token was expiring early' }),
    ]

    const result = extractPreviewMessages(messages)

    expect(result.firstUserMessage).toEqual({ role: 'user', snippet: 'Please fix the login bug' })
    expect(result.lastAssistantMessage).toEqual({
      role: 'assistant',
      snippet: 'Fixed — the token was expiring early',
    })
  })

  test('skips tool calls and empty assistant messages when scanning from either end', () => {
    const messages: PreviewMessage[] = [
      msg({ role: 'tool', content: '', toolName: 'Read' } as any),
      msg({ role: 'user', content: 'Investigate the crash' }),
      msg({ role: 'assistant', content: 'Working on it', toolName: 'Bash' } as any),
      msg({ role: 'assistant', content: 'Root cause found' }),
      msg({ role: 'assistant', content: '' }),
      msg({ role: 'tool', content: 'ok', toolName: 'Edit' } as any),
    ]

    const result = extractPreviewMessages(messages)

    // The tool-call and empty-content assistant messages must not win over the
    // one meaningful reply, even though they sit closer to either end.
    expect(result.firstUserMessage?.snippet).toBe('Investigate the crash')
    expect(result.lastAssistantMessage?.snippet).toBe('Root cause found')
  })

  test('bounds a very long first message to a word-boundary excerpt instead of rendering it in full', () => {
    const longMessage = 'debug the flaky retry loop in the worker queue '.repeat(20)
    const messages: PreviewMessage[] = [msg({ role: 'user', content: longMessage })]

    const result = extractPreviewMessages(messages)

    expect(result.firstUserMessage).not.toBeNull()
    const snippet = result.firstUserMessage!.snippet
    expect(snippet.length).toBeLessThan(longMessage.length)
    expect(snippet.length).toBeLessThanOrEqual(221) // limit + ellipsis
    expect(snippet.endsWith('…')).toBe(true)
    // Never cuts mid-word: the excerpt (minus the ellipsis) is a clean prefix
    // of the original, whitespace-collapsed message.
    expect(longMessage.replace(/\s+/g, ' ').trim().startsWith(snippet.slice(0, -1).trim())).toBe(true)
  })

  test('returns null for both when there is no meaningful conversation yet', () => {
    expect(extractPreviewMessages([])).toEqual({ firstUserMessage: null, lastAssistantMessage: null })
    expect(extractPreviewMessages(null)).toEqual({ firstUserMessage: null, lastAssistantMessage: null })

    const onlyTools: PreviewMessage[] = [
      msg({ role: 'tool', content: 'ok', toolName: 'Read' } as any),
    ]
    expect(extractPreviewMessages(onlyTools)).toEqual({
      firstUserMessage: null,
      lastAssistantMessage: null,
    })
  })

  test('skips whitespace-only user messages the same as empty assistant/tool-call ones', () => {
    const messages: PreviewMessage[] = [
      msg({ role: 'user', content: '   \n\t  ' }),
      msg({ role: 'user', content: 'Investigate the crash' }),
      msg({ role: 'assistant', content: 'Root cause found' }),
    ]

    const result = extractPreviewMessages(messages)

    expect(result.firstUserMessage?.snippet).toBe('Investigate the crash')
  })

  test('a user-only conversation has no last assistant reply', () => {
    const messages: PreviewMessage[] = [msg({ role: 'user', content: 'Anyone there?' })]
    const result = extractPreviewMessages(messages)

    expect(result.firstUserMessage?.snippet).toBe('Anyone there?')
    expect(result.lastAssistantMessage).toBeNull()
  })
})

describe('truncateAtWord', () => {
  test('collapses whitespace and leaves short text untouched', () => {
    expect(truncateAtWord('hello   world\n\nagain', 220)).toBe('hello world again')
  })

  test('cuts at the nearest word boundary and appends an ellipsis when over the limit', () => {
    const text = 'one two three four five six seven eight nine ten'
    const truncated = truncateAtWord(text, 20)

    expect(truncated.endsWith('…')).toBe(true)
    expect(truncated.length).toBeLessThanOrEqual(21)
    expect(text.startsWith(truncated.slice(0, -1))).toBe(true)
  })
})
