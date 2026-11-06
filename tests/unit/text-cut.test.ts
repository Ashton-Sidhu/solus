import { describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { clip } from '@solus/contracts/session-exchange'
import { cutText, cutTextEnd } from '@solus/contracts/text-cut'
import { finishedSummary } from '@solus/server/attention/finished-summary'
import { middleEllipsis } from '@solus/workspace-ui/lib/browser-annotation'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { codexBackgroundCommandWake, codexSubagentWake } = await import('@solus/server/execution/agents/codex/codex-utils')

describe('cutText', () => {
  test('never ends on half of a surrogate pair, because strict JSON readers reject the message', () => {
    expect(cutText('ab😀cd', 3)).toBe('ab')
    expect(cutText('ab😀cd', 3).isWellFormed()).toBe(true)
  })

  test('keeps a whole pair that fits', () => {
    expect(cutText('ab😀cd', 4)).toBe('ab😀')
  })

  test('returns short text unchanged', () => {
    expect(cutText('ab😀', 4)).toBe('ab😀')
    expect(cutText('', 4)).toBe('')
  })
})

describe('cutTextEnd', () => {
  test('never starts on half of a surrogate pair', () => {
    expect(cutTextEnd('ab😀cd', 3)).toBe('cd')
    expect(cutTextEnd('ab😀cd', 3).isWellFormed()).toBe(true)
  })

  test('keeps a whole pair that fits', () => {
    expect(cutTextEnd('ab😀cd', 4)).toBe('😀cd')
  })

  test('returns short text unchanged', () => {
    expect(cutTextEnd('ab😀', 4)).toBe('ab😀')
  })
})

describe('text cut for a label or a provider', () => {
  const emojis = '😀'.repeat(400)

  test('every cut stays valid Unicode at each length', () => {
    // WHY: a cut in the middle of an emoji shows a broken character, and a strict
    // JSON reader rejects a whole message that holds one.
    for (const padding of ['', 'a']) {
      const text = padding + emojis
      expect(clip(text, 80).isWellFormed()).toBe(true)
      expect(middleEllipsis(text, 41).isWellFormed()).toBe(true)
      expect(middleEllipsis(text, 40).isWellFormed()).toBe(true)
      expect(finishedSummary({ firstMessage: text }).isWellFormed()).toBe(true)
      expect(codexBackgroundCommandWake({ command: text, aggregatedOutput: text.repeat(20) }).isWellFormed()).toBe(true)
      expect(codexSubagentWake({ threadId: 't', status: 'completed', report: text.repeat(20) }).isWellFormed()).toBe(true)
    }
  })
})
