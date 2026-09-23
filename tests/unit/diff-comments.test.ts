import { describe, expect, test } from 'bun:test'
import {
  addDiffComment,
  removeDiffComment,
  restoreDiffComment,
  setDiffGeneralComment,
} from '@solus/workspace-ui/lib/diff-comments'
import type { DiffComment, Session } from '@solus/contracts/types'

function comment(filePath: string): DiffComment {
  return {
    id: crypto.randomUUID(),
    filePath,
    startLine: 2,
    endLine: 3,
    side: 'new',
    selectedCode: 'const value = true',
    comment: 'Keep this behavior.',
    createdAt: 1,
  }
}

function session(diffComments: DiffComment[] = []): Session {
  return { diffComments, diffCommentDraft: null, diffGeneralComment: '' } as unknown as Session
}

describe('queued diff comments belong to the session a surface shows', () => {
  test('a comment lands on the named session and no other', () => {
    // WHY: a diff beside a split chat reviews that chat's conversation. Its
    // comments must not join whichever session happens to be active.
    const activeComment = comment('active.ts')
    const active = session([activeComment])
    const shown = session()
    const added = comment('shown.ts')

    addDiffComment(shown, added)

    expect(active.diffComments).toEqual([activeComment])
    expect(shown.diffComments).toEqual([added])
  })

  test('undo puts a removed comment back where it was, once', () => {
    // WHY: the undo toast can fire after other edits; the comment must return
    // to its place in the review order and never appear twice.
    const [first, second, third] = [comment('a.ts'), comment('b.ts'), comment('c.ts')]
    const shown = session([first, second, third])

    removeDiffComment(shown, second.id)
    restoreDiffComment(shown, second, 1)
    restoreDiffComment(shown, second, 1)

    expect(shown.diffComments.map((c) => c.id)).toEqual([first.id, second.id, third.id])
  })

  test('a surface whose session closed underneath it changes nothing', () => {
    // WHY: a diff pane can outlive its tab for a frame; writes must not throw.
    expect(() => {
      addDiffComment(undefined, comment('gone.ts'))
      setDiffGeneralComment(undefined, 'note')
    }).not.toThrow()
  })
})
