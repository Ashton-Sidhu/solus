import { describe, expect, test } from 'bun:test'
import {
  boundHitWindow,
  composePreviewParts,
  extractPreviewMessages,
  passageAround,
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

  test('keeps markdown structure in the assistant excerpt', () => {
    // WHY: the picker renders this excerpt as markdown. Flattening its line
    // breaks turns a list or fenced block back into visible markdown syntax.
    const messages: PreviewMessage[] = [
      msg({
        role: 'assistant',
        content: '## Result\n\n- First item\n- **Second item**\n\n```ts\nconst ready = true\n```',
      }),
    ]

    expect(extractPreviewMessages(messages).lastAssistantMessage?.snippet).toBe(
      '## Result\n\n- First item\n- **Second item**\n\n```ts\nconst ready = true\n```',
    )
  })
})

describe('passageAround', () => {
  const lead = 'setting the scene with many words that come first '.repeat(12)
  const tail = ' and then a great deal of trailing discussion'.repeat(12)

  test('cuts around the first query word, on word boundaries, with ellipses where it cut', () => {
    // WHY: the hit can sit anywhere in a long reply. A passage cut from the
    // start would show the reply's opening and none of the words that matched.
    const passage = passageAround(`${lead}the OAuth token expired${tail}`, 'oauth token', 200)
    expect(passage).toMatch(/^…[^…]*the OAuth token expired[^…]*…$/)
    expect(passage.length).toBeLessThanOrEqual(202)
    expect(passage).not.toMatch(/^… /)
    expect(passage).not.toMatch(/ …$/)
    // The hit sits in the first half of the passage so the eye lands on it.
    expect(passage.indexOf('OAuth')).toBeLessThan(passage.length / 2)
  })

  test('any word of the query anchors the passage, whichever comes first', () => {
    const passage = passageAround(`${lead}second word here${tail}`, 'missing second', 120)
    expect(passage).toContain('second word here')
  })

  test('falls back to the head when no query word is spelled in the text', () => {
    // The index matched a stem ("run" for "running"); the pane still shows something readable.
    const text = `${lead}${tail}`
    expect(passageAround(text, 'zzz', 100)).toBe(truncateAtWord(text, 100))
  })

  test('leaves short text whole', () => {
    expect(passageAround('a  short\nreply', 'reply')).toBe('a short reply')
  })
})

describe('boundHitWindow', () => {
  test('cuts the hit around the words and its neighbours from their start', () => {
    const long = `${'filler words before the point '.repeat(20)}the RATE LIMIT hit${' more after'.repeat(30)}`
    const bounded = boundHitWindow(
      {
        window: {
          messages: [
            { messageId: 1, role: 'user', text: long, ts: 1 },
            { messageId: 2, role: 'assistant', text: long, ts: 2 },
            { messageId: 3, role: 'user', text: 'thanks', ts: 3 },
          ],
          hiddenBefore: 4,
          hiddenAfter: 9,
        },
        hitMessageId: 2,
      },
      'rate limit',
    )
    expect(bounded.messages.map((message) => message.isHit)).toEqual([false, true, false])
    expect(bounded.messages[1].passage).toContain('RATE LIMIT hit')
    expect(bounded.messages[0].passage).toMatch(/^filler words/)
    expect(bounded.messages[0].passage).not.toContain('RATE LIMIT')
    expect(bounded.messages[2]).toEqual({ role: 'user', passage: 'thanks', isHit: false })
    expect(bounded).toMatchObject({ hiddenBefore: 4, hiddenAfter: 9 })
  })
})

describe('composePreviewParts', () => {
  const ends = {
    firstUserMessage: { role: 'user' as const, snippet: 'fix login' },
    lastAssistantMessage: { role: 'assistant' as const, snippet: 'done' },
  }
  const hit = { role: 'assistant' as const, passage: 'the token', isHit: true }
  const neighbour = { role: 'user' as const, passage: 'why', isHit: false }
  const window = (hiddenBefore: number, hiddenAfter: number) => ({
    messages: [neighbour, hit],
    hiddenBefore,
    hiddenAfter,
  })

  test('without a hit the pane is the two ends', () => {
    expect(composePreviewParts(ends, null)).toEqual({
      opening: ends.firstUserMessage,
      hit: null,
      closing: ends.lastAssistantMessage,
    })
  })

  test('the opening and the last reply frame the hit, without its neighbours', () => {
    // WHY: the reader searched for a passage but still needs to know what the
    // conversation was for and where it ended up. The neighbours the index
    // returned are not shown: the pane is three parts, not a transcript.
    expect(composePreviewParts(ends, window(5, 3))).toEqual({
      opening: ends.firstUserMessage,
      hit,
      closing: ends.lastAssistantMessage,
    })
  })

  test('a hit that is one of the ends takes that slot, cut around the words', () => {
    // WHY: a window with nothing hidden after it ends at the last reply. If
    // the hit is that reply, showing it as the middle part and again as the
    // closing would show one message twice.
    expect(composePreviewParts(ends, window(5, 0))).toEqual({
      opening: ends.firstUserMessage,
      hit: null,
      closing: { role: 'assistant', snippet: 'the token' },
    })
    const openingHit = { role: 'user' as const, passage: 'fix the token', isHit: true }
    expect(
      composePreviewParts(ends, { messages: [openingHit, hit], hiddenBefore: 0, hiddenAfter: 3 }),
    ).toEqual({
      opening: { role: 'user', snippet: 'fix the token' },
      hit: null,
      closing: ends.lastAssistantMessage,
    })
  })

  test('without the ends the hit stands alone', () => {
    expect(composePreviewParts(null, window(12, 3))).toEqual({
      opening: null,
      hit,
      closing: null,
    })
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
