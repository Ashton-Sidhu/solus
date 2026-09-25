import { describe, expect, test } from 'bun:test'
import { ResponseTextBuffer, splitResponseText } from '@solus/server/sessions/response-text-buffer'
import { DEFAULT_HOST_CONFIG, mergeHostConfig } from '@solus/contracts/host-config'

const chunk = (text: string, parentToolUseId?: string) => ({ type: 'text_chunk' as const, text, ...(parentToolUseId ? { parentToolUseId } : {}) })

describe('response delivery', () => {
  test('defaults to paragraphs and lets a host retain buffered delivery', () => {
    expect(DEFAULT_HOST_CONFIG.responseStreamingMode).toBe('paragraph')
    expect(mergeHostConfig(DEFAULT_HOST_CONFIG, { responseStreamingMode: 'buffered' }).responseStreamingMode).toBe('buffered')
  })
  test('delivers completed paragraphs and groups fast updates without losing their tail', () => {
    const buffer = new ResponseTextBuffer()
    expect(buffer.append('session', chunk('First.\n\nNext'), 'paragraph', 0)).toEqual([
      { type: 'text_pending' }, { ...chunk('First.\n\n'), streaming: true },
    ])
    expect(buffer.append('session', chunk('.\n\nThird'), 'paragraph', 100)).toEqual([])
    expect(buffer.append('session', chunk('.\n\nLast'), 'paragraph', 400)).toEqual([
      { ...chunk('Next.\n\nThird.\n\n'), streaming: true },
    ])
    expect(buffer.beforeEvent('session', { type: 'assistant_message', text: '' })).toEqual([
      { ...chunk('Last'), streaming: false },
    ])
    expect(buffer.flush('session')).toEqual([])
  })
  test('usage does not interrupt a paragraph, but an approval flushes its explanation', () => {
    const buffer = new ResponseTextBuffer()
    buffer.append('session', chunk('Please approve'), 'paragraph', 0)
    expect(buffer.beforeEvent('session', { type: 'usage', run: {} })).toEqual([])
    expect(buffer.beforeEvent('session', { type: 'permission_request', questionId: 'q', toolName: 'write', options: [] })).toEqual([
      { ...chunk('Please approve'), streaming: false },
    ])
  })
  test('buffered mode keeps a whole segment until the next event', () => {
    const buffer = new ResponseTextBuffer()
    expect(buffer.append('session', chunk('First.\n\n'), 'buffered', 0)).toEqual([{ type: 'text_pending' }])
    expect(buffer.append('session', chunk('Second.'), 'buffered', 500)).toEqual([])
    expect(buffer.beforeEvent('session', { type: 'usage', run: {} })).toEqual([chunk('First.\n\nSecond.')])
  })
  test('keeps sessions and child streams separate and drains all on failure', () => {
    const buffer = new ResponseTextBuffer()
    buffer.append('one', chunk('main'), 'paragraph', 0)
    buffer.append('one', chunk('child', 'tool'), 'paragraph', 0)
    buffer.append('two', chunk('other'), 'paragraph', 0)
    expect(buffer.beforeEvent('one', { type: 'error', message: 'failed', isError: true })).toEqual([
      { ...chunk('main'), streaming: false }, { ...chunk('child', 'tool'), streaming: false },
    ])
    expect(buffer.flush('two')).toEqual([{ ...chunk('other'), streaming: false }])
  })
  test('leaves a partial paragraph buffered on attach and emits it once on interruption', () => {
    const buffer = new ResponseTextBuffer()
    buffer.append('session', chunk('Done.\n\nPartial'), 'paragraph', 0)
    expect(buffer.flush('session', true)).toEqual([])
    expect(buffer.beforeEvent('session', { type: 'status_change', oldStatus: 'running', status: 'interrupted' })).toEqual([
      { ...chunk('Partial'), streaming: false },
    ])
    expect(buffer.flush('session')).toEqual([])
  })
  test('flushes oversized text and then finalizes without duplicating it', () => {
    const buffer = new ResponseTextBuffer()
    const text = 'x'.repeat(24_001)
    expect(buffer.append('session', chunk(text), 'paragraph', 0)).toEqual([
      { type: 'text_pending' }, { ...chunk(text), streaming: true },
    ])
    expect(buffer.flush('session')).toEqual([{ ...chunk(''), streaming: false }])
  })
})

describe('Markdown delivery boundaries', () => {
  test('holds partial lines, open fences, and indented fence content', () => {
    for (const text of ['unfinished', '```ts\na\n\nb\n', '```ts\na\n    ```\n']) {
      expect(splitResponseText(text)).toEqual({ ready: '', rest: text })
    }
  })
  test('closes matching fences only and accepts CRLF blank lines', () => {
    expect(splitResponseText('````ts\na\n```\n\n````\ntail')).toEqual({ ready: '````ts\na\n```\n\n````\n', rest: 'tail' })
    expect(splitResponseText('a\r\n\r\nb')).toEqual({ ready: 'a\r\n\r\n', rest: 'b' })
    expect(splitResponseText('a\n\u00a0\nb')).toEqual({ ready: '', rest: 'a\n\u00a0\nb' })
  })
})

describe('section titles wait for the text under them', () => {
  test('holds a heading alone and ships it with its paragraph', () => {
    expect(splitResponseText('intro\n\n## Setup\n\nInstall it')).toEqual({ ready: 'intro\n\n', rest: '## Setup\n\nInstall it' })
    expect(splitResponseText('intro\n\n# Plan\n\n## Setup\n\nInstall it.\n\nNext')).toEqual({
      ready: 'intro\n\n# Plan\n\n## Setup\n\nInstall it.\n\n', rest: 'Next',
    })
  })
  test('releases the paragraph above a heading that has no blank line before it', () => {
    expect(splitResponseText('para\n## Setup\n\nInstall')).toEqual({ ready: 'para\n', rest: '## Setup\n\nInstall' })
  })
  test('holds a bold-only line, but not bold text inside a sentence', () => {
    expect(splitResponseText('**Risk by area**\n\n| a |\n|---|\n')).toEqual({ ready: '', rest: '**Risk by area**\n\n| a |\n|---|\n' })
    expect(splitResponseText('**Use *npm* now:**\n\nInstall')).toEqual({ ready: '', rest: '**Use *npm* now:**\n\nInstall' })
    expect(splitResponseText('**Note:** read this.\n\nNext')).toEqual({ ready: '**Note:** read this.\n\n', rest: 'Next' })
    expect(splitResponseText('**a** and **b**\n\nNext')).toEqual({ ready: '**a** and **b**\n\n', rest: 'Next' })
  })
  test('ships a title with its first list item or its whole code block', () => {
    expect(splitResponseText('## Steps\n\n- one\n\n- tw')).toEqual({ ready: '## Steps\n\n- one\n\n', rest: '- tw' })
    expect(splitResponseText('## Code\n\n```ts\na\n\nb\n')).toEqual({ ready: '', rest: '## Code\n\n```ts\na\n\nb\n' })
    expect(splitResponseText('## Code\n\n```ts\na\n```\nafter')).toEqual({ ready: '## Code\n\n```ts\na\n```\n', rest: 'after' })
  })
  test('a held title still flushes on a tool call and at turn end', () => {
    const buffer = new ResponseTextBuffer()
    expect(buffer.append('session', chunk('Done.\n\n## Next steps\n\n'), 'paragraph', 0)).toEqual([
      { type: 'text_pending' }, { ...chunk('Done.\n\n'), streaming: true },
    ])
    expect(buffer.append('session', chunk(''), 'paragraph', 1_000)).toEqual([])
    expect(buffer.beforeEvent('session', { type: 'tool_call', toolName: 'Read', toolId: 't', index: 0 })).toEqual([
      { ...chunk('## Next steps\n\n'), streaming: false },
    ])
    buffer.append('session', chunk('**Summary**\n\n'), 'paragraph', 2_000)
    expect(buffer.flush('session')).toEqual([{ ...chunk('**Summary**\n\n'), streaming: false }])
  })
  test('a held title still flushes at the buffer cap', () => {
    const buffer = new ResponseTextBuffer()
    const text = `## Log\n\n${'x'.repeat(24_000)}`
    expect(buffer.append('session', chunk(text), 'paragraph', 0)).toEqual([
      { type: 'text_pending' }, { ...chunk(text), streaming: true },
    ])
  })
})
