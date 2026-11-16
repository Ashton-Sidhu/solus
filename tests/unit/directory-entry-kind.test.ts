import { describe, expect, test } from 'bun:test'
import type { DirectoryEntry } from '@solus/contracts/types'
import { entryCountLabel, entryKindLabel } from '@solus/workspace-ui/components/pickers/lib/entry-kind'

const folder: DirectoryEntry = { name: 'site', isDir: true, path: '/work/site' }

describe('entryKindLabel', () => {
  test('a bare folder is a Folder', () => {
    expect(entryKindLabel(folder)).toBe('Folder')
  })

  test('a checkout is a Git repository', () => {
    expect(entryKindLabel({ ...folder, isRepo: true, branch: 'main' })).toBe('Git repository')
  })

  // A project is almost always a checkout too. That Solus already tracks it is
  // the fact the person cannot see from the folder, so it wins.
  test('a folder Solus tracks is a Project, also when it is a checkout', () => {
    expect(entryKindLabel({ ...folder, isRepo: true, isProject: true })).toBe('Project')
  })

  test('an entry that is not a folder is a File', () => {
    expect(entryKindLabel({ name: 'id_ed25519', isDir: false, path: '/home/a/.ssh/id_ed25519' })).toBe('File')
  })
})

describe('entryCountLabel', () => {
  test('counts folders, with the singular for one', () => {
    expect(entryCountLabel(12, false)).toBe('12 folders')
    expect(entryCountLabel(1, false)).toBe('1 folder')
  })

  // A picker that chooses an entry lists files too, so "folders" would be wrong.
  test('counts items when the list shows files too', () => {
    expect(entryCountLabel(3, true)).toBe('3 items')
    expect(entryCountLabel(1, true)).toBe('1 item')
  })
})
