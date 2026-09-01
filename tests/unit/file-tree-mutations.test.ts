import { describe, expect, test } from 'bun:test'
import {
  addTreePath,
  canonicalTreePath,
  creationDirectoryFor,
  entryDisplayName,
  parentDirectoryOf,
  placeholderEntryPath,
  removeTreePath,
  renameTreePath,
} from '@solus/workspace-ui/components/files/lib/file-tree-mutations'
import { directoriesHoldingFiles } from '@solus/server/server/handlers/lib/project-listing'

describe('where a new entry goes', () => {
  test('a folder takes the new entry inside itself', () => {
    expect(creationDirectoryFor('src/lib/', true)).toBe('src/lib/')
  })

  test('a file takes the new entry alongside itself, not under it', () => {
    expect(creationDirectoryFor('src/lib/index.ts', false)).toBe('src/lib/')
  })

  test('a file at the top level puts the new entry at the project root', () => {
    expect(creationDirectoryFor('README.md', false)).toBe('')
  })

  test('the folder part keeps its trailing slash, so the header reads "src/" then the name', () => {
    expect(parentDirectoryOf('src/lib/a.ts')).toBe('src/lib/')
    expect(parentDirectoryOf('README.md')).toBe('')
  })
})

describe('placeholder names', () => {
  test('a folder placeholder keeps the trailing slash the tree needs to draw it as a folder', () => {
    expect(placeholderEntryPath('src/', 'folder', new Set())).toBe('src/untitled folder/')
  })

  test('steps past a name already on screen, because the tree refuses a duplicate path', () => {
    const taken = new Set(['src/untitled', 'src/untitled 2'])
    expect(placeholderEntryPath('src/', 'file', taken)).toBe('src/untitled 3')
  })
})

describe('keeping the pane path list in step with the tree', () => {
  test('an added path lands in sort order, so a later refresh does not reshuffle the row', () => {
    const paths = ['src/a.ts', 'src/c.ts']
    addTreePath(paths, 'src/b.ts')
    expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })

  test('deleting a folder takes its contents with it', () => {
    const paths = ['src/lib/', 'src/lib/a.ts', 'src/lib/deep/b.ts', 'src/other.ts']
    removeTreePath(paths, 'src/lib/')
    expect(paths).toEqual(['src/other.ts'])
  })

  test('deleting a file leaves a same-named prefix alone', () => {
    const paths = ['src/lib', 'src/libraries/a.ts']
    removeTreePath(paths, 'src/lib')
    expect(paths).toEqual(['src/libraries/a.ts'])
  })

  test('renaming a folder re-points every descendant', () => {
    const paths = ['src/lib/', 'src/lib/a.ts', 'src/lib/deep/b.ts', 'src/other.ts']
    renameTreePath(paths, 'src/lib/', 'src/core/')
    expect(paths).toEqual(['src/core/', 'src/core/a.ts', 'src/core/deep/b.ts', 'src/other.ts'])
  })

  test('reports the descendants it moved so an open file can follow its folder', () => {
    const moved = renameTreePath(['src/lib/a.ts', 'src/other.ts'], 'src/lib/', 'src/core/')
    expect(moved).toEqual([{ from: 'src/lib/a.ts', to: 'src/core/a.ts' }])
  })
})

describe('path shape', () => {
  test('the rename callback hands back a bare folder path, which the tree will not accept', () => {
    expect(canonicalTreePath('src/core', true)).toBe('src/core/')
    expect(canonicalTreePath('src/core/', true)).toBe('src/core/')
    expect(canonicalTreePath('src/core.ts', false)).toBe('src/core.ts')
  })

  test('a folder reads by its own name, not the empty segment after its slash', () => {
    expect(entryDisplayName('src/lib/')).toBe('lib')
    expect(entryDisplayName('src/lib/a.ts')).toBe('a.ts')
  })
})

describe('folders the host must report separately', () => {
  test('a folder some file already reveals is not sent twice', () => {
    expect(directoriesHoldingFiles(['src/lib/a.ts', 'README.md'])).toEqual(
      new Set(['src', 'src/lib']),
    )
  })
})
