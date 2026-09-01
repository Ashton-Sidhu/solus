import { describe, expect, test } from 'bun:test'
import { changeBlocks } from '@solus/workspace-ui/components/pr-review/lib/change-blocks'
import { defaultMergeMethod } from '@solus/workspace-ui/components/pr-review/lib/merge-method'

describe('pull request change blocks', () => {
  test('never rounds a real deletion away', () => {
    // WHY: the squares answer "what shape is this change". A 2-line deletion
    // inside a 400-line addition is still a deletion, and a reader who sees an
    // all-green row will not go looking for it.
    expect(changeBlocks(400, 2)).toEqual([
      'added',
      'added',
      'added',
      'added',
      'removed',
    ])
    expect(changeBlocks(2, 400)).toEqual([
      'added',
      'removed',
      'removed',
      'removed',
      'removed',
    ])
  })

  test('a one-sided change is one colour, and no change draws nothing', () => {
    expect(changeBlocks(22, 0).every((block) => block === 'added')).toBe(true)
    expect(changeBlocks(0, 9).every((block) => block === 'removed')).toBe(true)
    expect(changeBlocks(0, 0)).toEqual([])
  })
})

describe('merge method naming', () => {
  test('names the method the merge button starts on', () => {
    // WHY: the method used to be derived from whether the PR was blocked, so a
    // mergeable PR on a squash-only repo was told it would land as a merge
    // commit. The button's own label is now the only place the method is
    // stated, which makes this the only thing that decides what it says.
    expect(defaultMergeMethod(['squash', 'rebase'])).toBe('squash')
    expect(defaultMergeMethod(['rebase'])).toBe('rebase')
    expect(defaultMergeMethod(['merge', 'squash'])).toBe('merge')
  })

})
