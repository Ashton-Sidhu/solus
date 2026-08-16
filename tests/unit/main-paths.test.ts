import { describe, expect, test } from 'bun:test'
import { sep } from 'path'
import { isInsideRoot, toRootRelativePath } from '../../src/main/paths'

describe('isInsideRoot', () => {
  test('accepts the root itself and paths beneath it', () => {
    expect(isInsideRoot('/repo', '/repo')).toBe(true)
    expect(isInsideRoot('/repo', '/repo/a.txt')).toBe(true)
    expect(isInsideRoot('/repo', '/repo/nested/deep/a.txt')).toBe(true)
  })

  test('rejects a sibling whose path merely shares the root prefix', () => {
    // A plain `startsWith` check would wrongly accept this.
    expect(isInsideRoot('/repo', '/repo-evil/a.txt')).toBe(false)
  })

  test('rejects escapes, including ones that only appear after resolution', () => {
    expect(isInsideRoot('/repo', '/escape.txt')).toBe(false)
    expect(isInsideRoot('/repo', '/repo/../escape.txt')).toBe(false)
    expect(isInsideRoot('/repo', '/repo/sub/../../escape.txt')).toBe(false)
  })

  test('a traversal that stays inside the root is still inside', () => {
    expect(isInsideRoot('/repo', '/repo/sub/../a.txt')).toBe(true)
  })

  /**
   * The predicate this replaced tested `startsWith('../')`. On Windows
   * `relative()` answers `..\escape.txt`, so that check returned *true* for an
   * escaping path and the caller served a file outside the root. Encoding the
   * platform separator is the whole point of sharing this function.
   */
  test('rejects an escape expressed with the platform separator', () => {
    expect(`..${sep}escape.txt`.startsWith(`..${sep}`)).toBe(true)
    expect(isInsideRoot('/repo', `/repo/..${sep}escape.txt`)).toBe(false)
  })
})

describe('toRootRelativePath', () => {
  test('normalizes a path that stays inside the root', () => {
    expect(toRootRelativePath('/repo', 'a.txt')).toBe('a.txt')
    expect(toRootRelativePath('/repo', './a.txt')).toBe('a.txt')
    expect(toRootRelativePath('/repo', 'sub/../a.txt')).toBe('a.txt')
    expect(toRootRelativePath('/repo', 'nested//deep/a.txt')).toBe('nested/deep/a.txt')
    expect(toRootRelativePath('/repo', '  a.txt  ')).toBe('a.txt')
  })

  test('rebases an absolute path that is genuinely inside the root', () => {
    expect(toRootRelativePath('/repo', '/repo/a.txt')).toBe('a.txt')
  })

  test('throws on empty, on the root itself, and on any escape', () => {
    expect(() => toRootRelativePath('/repo', '')).toThrow()
    expect(() => toRootRelativePath('/repo', '   ')).toThrow()
    expect(() => toRootRelativePath('/repo', '.')).toThrow()
    expect(() => toRootRelativePath('/repo', '../escape.txt')).toThrow()
    expect(() => toRootRelativePath('/repo', 'sub/../../escape.txt')).toThrow()
    expect(() => toRootRelativePath('/repo', '/etc/passwd')).toThrow()
  })
})
