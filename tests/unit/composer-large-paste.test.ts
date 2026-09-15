import { describe, expect, test } from 'bun:test'
import {
  LARGE_PASTE_MIN_BYTES,
  isLargePaste,
  pastedTextFile,
} from '@solus/workspace-ui/components/input/lib/attachment-upload'

describe('large paste folding', () => {
  test('leaves an ordinary paste inline', () => {
    // WHY: folding a normal paste would put the user's own sentence behind a
    // file chip they then have to open to read.
    expect(isLargePaste('a short note')).toBe(false)
  })

  test('folds a paste at the threshold', () => {
    expect(isLargePaste('a'.repeat(LARGE_PASTE_MIN_BYTES))).toBe(true)
  })

  test('leaves a paste one byte under the threshold inline', () => {
    expect(isLargePaste('a'.repeat(LARGE_PASTE_MIN_BYTES - 1))).toBe(false)
  })

  test('measures bytes, not code units', () => {
    // WHY: a CJK or emoji-heavy paste reaches the byte threshold at roughly a
    // third of the character count, and it is the bytes that cost context.
    const justUnderInChars = '中'.repeat(Math.ceil(LARGE_PASTE_MIN_BYTES / 3))
    expect(justUnderInChars.length).toBeLessThan(LARGE_PASTE_MIN_BYTES)
    expect(isLargePaste(justUnderInChars)).toBe(true)
  })

  test('files the text as a readable .txt carrying the whole paste', () => {
    const file = pastedTextFile('hello', new Date(2026, 8, 10, 14, 3, 9))
    expect(file.name).toBe('pasted text 2026-09-10 140309.txt')
    // The constructor appends the charset; what matters is that it uploads as
    // readable text rather than falling back to an opaque binary type.
    expect(file.type.startsWith('text/plain')).toBe(true)
    expect(file.size).toBe(5)
  })
})
