import { describe, expect, test } from 'bun:test'
import { resolveDirectorySelection } from '../../src/renderer/components/pickers/lib/directory-selection'

const folders = [
  { name: 'alpha', path: '/projects/solus/alpha', isDir: true },
  { name: 'beta', path: '/projects/solus/beta', isDir: true },
]

describe('directory picker selection', () => {
  test('keeps the folder being browsed as the destination until a child is explicitly selected', () => {
    expect(resolveDirectorySelection('/projects/solus', 'solus', folders, -1)).toEqual({
      entry: null,
      path: '/projects/solus',
      name: 'solus',
    })
  })

  test('uses an explicitly selected child as the destination', () => {
    expect(resolveDirectorySelection('/projects/solus', 'solus', folders, 1)).toEqual({
      entry: folders[1],
      path: '/projects/solus/beta',
      name: 'beta',
    })
  })

  test('falls back to the current folder when filtering invalidates the selected index', () => {
    expect(resolveDirectorySelection('/projects/solus', 'solus', folders.slice(0, 1), 1).path)
      .toBe('/projects/solus')
  })
})
