import { describe, expect, test } from 'bun:test'
import {
  hostPathBaseName,
  hostPathKey,
  hostPathSegments,
  isAbsoluteHostPath,
  joinHostPath,
  isInsideHostPath,
  relativeHostPath,
  sameHostPath,
  trimTrailingSeparators,
} from '@solus/contracts/host-path'

// WHY: a client on a Mac reads paths from a Windows host, and a Windows host
// reads paths from Node (`C:\x`) and from git (`C:/x`). Each rule below was
// once a `'/'` at a call site, and each broke a feature on Windows: a main
// checkout read as a worktree, an @ mention named the main checkout from a
// worktree, a project label showed its whole path.

describe('a Windows host path', () => {
  test('is the same path in either separator and either case', () => {
    expect(sameHostPath(String.raw`C:\code\scratch`, 'C:/code/scratch')).toBe(true)
    expect(sameHostPath('C:\\Code\\Scratch\\', 'c:/code/scratch')).toBe(true)
    expect(sameHostPath(String.raw`C:\code\scratch`, String.raw`C:\code\scratch2`)).toBe(false)
  })

  test('is inside its root in either separator, and the rest is written with / as on the wire', () => {
    expect(relativeHostPath(String.raw`C:\code\scratch`, String.raw`C:\code\scratch\src\a.ts`)).toBe('src/a.ts')
    expect(relativeHostPath('C:/code/scratch', String.raw`C:\code\scratch\README.md`)).toBe('README.md')
    expect(relativeHostPath(String.raw`C:\code\scratch`, String.raw`C:\code\scratch`)).toBe('')
    expect(relativeHostPath(String.raw`C:\code\scratch`, String.raw`C:\code\scratch2\a`)).toBeNull()
    expect(isInsideHostPath('C:\\', String.raw`C:\code`)).toBe(true)
  })

  test('has names, a last name, and a root that stays a root', () => {
    expect(hostPathSegments('C:\\code\\scratch\\')).toEqual(['C:', 'code', 'scratch'])
    expect(hostPathBaseName('C:\\code\\scratch\\')).toBe('scratch')
    expect(hostPathBaseName('C:\\')).toBe('')
    expect(trimTrailingSeparators('C:\\')).toBe('C:\\')
    expect(isAbsoluteHostPath(String.raw`C:\code`)).toBe(true)
    expect(isAbsoluteHostPath(String.raw`\\server\share`)).toBe(true)
    expect(isAbsoluteHostPath(String.raw`src\a.ts`)).toBe(false)
  })
})

describe('a POSIX host path', () => {
  test('keeps its case and compares exactly', () => {
    expect(sameHostPath('/Users/me/Repo', '/Users/me/repo')).toBe(false)
    expect(hostPathKey('/Users/me/repo/')).toBe('/Users/me/repo')
    expect(relativeHostPath('/Users/me/repo', '/Users/me/repo/src/a.ts')).toBe('src/a.ts')
    expect(relativeHostPath('/', '/etc')).toBe('etc')
    expect(trimTrailingSeparators('/')).toBe('/')
    expect(hostPathBaseName('/Users/me/repo')).toBe('repo')
  })
})

describe('joining a name to a host path', () => {
  test('uses the directory own separator, or the host platform for ~', () => {
    expect(joinHostPath(String.raw`C:\code\scratch`, 'src/a.ts')).toBe(String.raw`C:\code\scratch\src\a.ts`)
    expect(joinHostPath('C:\\', 'code')).toBe(String.raw`C:\code`)
    expect(joinHostPath('/Users/me/repo/', 'src/a.ts')).toBe('/Users/me/repo/src/a.ts')
    expect(joinHostPath('~', 'Projects', 'win32')).toBe(String.raw`~\Projects`)
    expect(joinHostPath('~', 'Projects')).toBe('~/Projects')
  })
})
