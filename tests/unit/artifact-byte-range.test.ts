import { describe, expect, test } from 'bun:test'
import { parseByteRange } from '@solus/server/server/byte-range'

describe('artifact byte ranges', () => {
  test('resolves bounded, open-ended, and suffix ranges', () => {
    expect(parseByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
    expect(parseByteRange('bytes=7-', 10)).toEqual({ start: 7, end: 9 })
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseByteRange('bytes=-20', 10)).toEqual({ start: 0, end: 9 })
    expect(parseByteRange('bytes=7-20', 10)).toEqual({ start: 7, end: 9 })
  })

  test('rejects malformed and unsatisfiable ranges', () => {
    expect(parseByteRange(undefined, 10)).toBeNull()
    expect(parseByteRange('items=0-1', 10)).toBeNull()
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBeNull()
    expect(parseByteRange('bytes=-0', 10)).toBeNull()
    expect(parseByteRange('bytes=10-', 10)).toBeNull()
    expect(parseByteRange('bytes=5-4', 10)).toBeNull()
    expect(parseByteRange('bytes=0-', 0)).toBeNull()
  })
})
