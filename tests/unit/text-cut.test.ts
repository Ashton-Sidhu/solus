import { describe, expect, test } from 'bun:test'
import { cutText } from '@solus/contracts/text-cut'

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
