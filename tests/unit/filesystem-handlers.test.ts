import { describe, expect, test } from 'bun:test'
import { expandHome } from '@solus/server/server/handlers/lib/host-path'

describe('filesystem handler paths', () => {
  test('expands home shorthand with the browsed host separator', () => {
    expect(expandHome('~/code', '/home/solus', 'linux')).toBe('/home/solus/code')
    expect(expandHome('~\\code', String.raw`C:\Users\solus`, 'win32')).toBe(
      String.raw`C:\Users\solus\code`,
    )
    expect(expandHome('~/code', String.raw`C:\Users\solus`, 'win32')).toBe(
      String.raw`C:\Users\solus\code`,
    )
  })

  test('does not interpret a backslash as a home separator on POSIX', () => {
    expect(expandHome('~\\code', '/home/solus', 'linux')).not.toBe('/home/solus/code')
  })
})
