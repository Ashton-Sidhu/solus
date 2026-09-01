import { describe, expect, test } from 'bun:test'
import {
  appendPathSegment,
  breadcrumbTrail,
  browsePathPlatform,
  browseDirectoryPath,
  browseLeafSegment,
  browseParentPath,
  canNavigateUp,
  ensureDirectoryPath,
  hasTrailingSeparator,
  inferFolderName,
  isRootedPath,
  joinBrowsePath,
  normalizeBrowsePath,
  resolveRelativePath,
} from '@solus/workspace-ui/components/pickers/lib/browse-path'

// The picker keeps a single typed path as its only state. Every navigation
// decision below is derived from that string, so these tests pin the
// navigation semantics rather than the string formatting.
describe('browse path', () => {
  test('a trailing separator marks a directory boundary, a leaf marks a filter', () => {
    expect(hasTrailingSeparator('~/dev/')).toBe(true)
    expect(hasTrailingSeparator('~/dev/so')).toBe(false)

    // At a boundary the picker lists the directory itself and filters nothing.
    expect(browseDirectoryPath('~/dev/')).toBe('~/dev/')
    expect(browseLeafSegment('~/dev/')).toBe('')

    // Mid-name it lists the *parent* and filters by the partial name, which is
    // what lets typing narrow the list without refetching.
    expect(browseDirectoryPath('~/dev/so')).toBe('~/dev/')
    expect(browseLeafSegment('~/dev/so')).toBe('so')
  })

  test('descending a folder lands on the next boundary', () => {
    expect(appendPathSegment('~/dev/', 'solus')).toBe('~/dev/solus/')
    // Typing a partial name then clicking a row replaces the partial name.
    expect(appendPathSegment('~/dev/so', 'solus')).toBe('~/dev/solus/')
  })

  test('walking up stops at the root of each anchor', () => {
    expect(browseParentPath('~/dev/solus/')).toBe('~/dev/')
    expect(browseParentPath('~/dev/')).toBe('~/')
    expect(browseParentPath('~/')).toBeNull()
    expect(browseParentPath('/repo/src/')).toBe('/repo/')
    expect(browseParentPath('/repo/')).toBe('/')
    expect(browseParentPath('/')).toBeNull()
  })

  test('up-navigation is only offered after entering a directory', () => {
    // "~/dev/so" is a filter inside "~/dev/", not a place you can leave.
    expect(canNavigateUp('~/dev/so')).toBe(false)
    expect(canNavigateUp('~/dev/')).toBe(true)
    expect(canNavigateUp('~/')).toBe(false)
    expect(canNavigateUp('/')).toBe(false)
  })

  test('seed paths open inside the folder rather than filtering its parent', () => {
    expect(ensureDirectoryPath('/repo/app')).toBe('/repo/app/')
    expect(ensureDirectoryPath('/repo/app/')).toBe('/repo/app/')
    expect(ensureDirectoryPath('')).toBe('')
  })

  test('committed paths drop the trailing separator but keep the root', () => {
    expect(normalizeBrowsePath(' ~/dev/solus/ ')).toBe('~/dev/solus')
    expect(normalizeBrowsePath('/')).toBe('/')
  })

  test('explicit relative paths resolve against the tab cwd, tilde stays unexpanded', () => {
    expect(resolveRelativePath('./docs', '/repo/app')).toBe('/repo/app/docs')
    expect(resolveRelativePath('../docs', '/repo/app')).toBe('/repo/docs')
    expect(resolveRelativePath('..', '/repo/app')).toBe('/repo')
    expect(resolveRelativePath('./docs', '~/dev')).toBe('~/dev/docs')
    // A bare tilde path is *not* relative — it must reach the host untouched so
    // the host expands it to its own home.
    expect(resolveRelativePath('~/dev/solus/', '/repo/app')).toBe('~/dev/solus')
    // Without a cwd there is nothing to resolve against.
    expect(resolveRelativePath('./docs', null)).toBe('./docs')
  })

  test('the trail covers the folder being listed, never the name being typed', () => {
    // "so" is a filter inside "~/dev/", so it must not appear as a place.
    expect(breadcrumbTrail('~/dev/so').map((c) => c.label)).toEqual(['~', 'dev'])
    // Each crumb navigates to a boundary, so clicking it lists that folder.
    expect(breadcrumbTrail('/repo/src/').map((c) => c.path)).toEqual([
      '/',
      '/repo/',
      '/repo/src/',
    ])
    expect(breadcrumbTrail('~/')).toEqual([{ label: '~', path: '~/' }])
    // Nothing typed yet — no trail to walk.
    expect(breadcrumbTrail('')).toEqual([])
  })

  test('a value carrying its own root replaces the trail rather than extending it', () => {
    expect(isRootedPath('/tmp')).toBe(true)
    expect(isRootedPath('~/dev')).toBe(true)
    expect(isRootedPath('~')).toBe(true)
    // A hidden folder name is typed *into* the current folder, not a new root.
    expect(isRootedPath('.config')).toBe(false)
    expect(isRootedPath('solus')).toBe(false)
  })

  test('the commit button names the last segment', () => {
    expect(inferFolderName('~/dev/solus/')).toBe('solus')
    expect(inferFolderName('~/dev/solus')).toBe('solus')
    expect(inferFolderName('/')).toBe('/')
  })
})

describe('browse path on Windows hosts', () => {
  const platform = 'win32' as const

  test('recognizes Windows hosts and pasted Windows roots', () => {
    expect(browsePathPlatform('win32')).toBe('win32')
    expect(browsePathPlatform(null, String.raw`C:\code`)).toBe('win32')
    expect(browsePathPlatform('linux', String.raw`C:\code`)).toBe('posix')
    expect(isRootedPath(String.raw`C:\code`, platform)).toBe(true)
    expect(isRootedPath(String.raw`\\server\share\code`, platform)).toBe(true)
    expect(isRootedPath(String.raw`~\code`, platform)).toBe(true)
  })

  test('uses both slash styles as input and emits host-native boundaries', () => {
    expect(ensureDirectoryPath('C:/code/solus', platform)).toBe('C:\\code\\solus\\')
    expect(browseDirectoryPath(String.raw`C:\code\sol`, platform)).toBe('C:\\code\\')
    expect(browseLeafSegment(String.raw`C:\code\sol`, platform)).toBe('sol')
    expect(appendPathSegment(String.raw`C:\code\so`, 'solus', platform)).toBe(
      'C:\\code\\solus\\',
    )
    expect(joinBrowsePath(String.raw`C:\code`, 'solus', platform)).toBe(
      String.raw`C:\code\solus`,
    )
  })

  test('walks drive and UNC roots without crossing their boundary', () => {
    expect(browseParentPath('C:\\code\\solus\\', platform)).toBe('C:\\code\\')
    expect(browseParentPath('C:\\code\\', platform)).toBe('C:\\')
    expect(browseParentPath('C:\\', platform)).toBeNull()
    expect(browseParentPath('\\\\server\\share\\code\\', platform)).toBe(
      '\\\\server\\share\\',
    )
    expect(browseParentPath('\\\\server\\share\\', platform)).toBeNull()
  })

  test('builds breadcrumbs for drive, UNC, and home paths', () => {
    expect(breadcrumbTrail('C:\\code\\solus\\', platform)).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'code', path: 'C:\\code\\' },
      { label: 'solus', path: 'C:\\code\\solus\\' },
    ])
    expect(breadcrumbTrail('\\\\server\\share\\code\\', platform)[0]).toEqual({
      label: String.raw`\\server\share`,
      path: '\\\\server\\share\\',
    })
    expect(breadcrumbTrail('~\\code\\', platform)[0]).toEqual({
      label: '~',
      path: '~\\',
    })
  })

  test('resolves Windows relative paths against the selected host cwd', () => {
    expect(resolveRelativePath(String.raw`.\docs`, String.raw`C:\code\app`, platform)).toBe(
      String.raw`C:\code\app\docs`,
    )
    expect(resolveRelativePath(String.raw`..\docs`, String.raw`C:\code\app`, platform)).toBe(
      String.raw`C:\code\docs`,
    )
    expect(inferFolderName('C:\\code\\solus\\', platform)).toBe('solus')
  })
})
