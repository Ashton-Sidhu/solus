import { describe, expect, test } from 'bun:test'
import { uniqueDiffTreePaths } from '@solus/workspace-ui/components/diff/lib/diff-file-tree'

describe('diff file tree paths', () => {
  test('one file changed more than once still creates one navigation row', () => {
    expect(uniqueDiffTreePaths([
      'CLAUDE.md',
      'src/index.ts',
      'CLAUDE.md',
    ])).toEqual([
      'CLAUDE.md',
      'src/index.ts',
    ])
  })
})
