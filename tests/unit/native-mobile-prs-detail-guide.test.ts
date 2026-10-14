import { describe, expect, spyOn, test } from 'bun:test'
import type { ReviewThread } from '@solus/contracts/providers'
import type { GuideSection } from '@solus/contracts/review'
import { annotatePullRequestDiff, draftAnchor } from '../../apps/mobile/src/features/prs/lib/pull-request-diff-comments'
import { guideExcerptFocus, guideExcerptPatch, guideExcerptText, guideExcerpts, guideFileCount, guideFocusedRows, guideStops } from '../../apps/mobile/src/features/prs/lib/pull-request-guide-tour'
import type { NativeReviewDiffData } from '../../apps/mobile/src/features/review/nativeReviewDiffAdapter'
import { buildNativeReviewDiffData } from '../../apps/mobile/src/features/review/nativeReviewDiffAdapter'
import { buildReviewParsedDiff } from '../../apps/mobile/src/features/review/reviewModel'

// The guide is a tour in section order; each stop's excerpts are the hunks the
// host cut for it, and an excerpt focuses the lines it is about. Review
// comments sit under the exact line and side they were written on.

const section = (id: string, order: number, files: GuideSection['files'] = []): GuideSection =>
  ({ id, title: id, order, significance: 'core', explanation: '', files })

describe('guide tour', () => {
  test('stops follow section order; equal orders keep the guide order', () => {
    const stops = guideStops({ sections: [section('c', 3), section('a', 1), section('b1', 2), section('b2', 2)] })
    expect(stops.map((stop) => stop.id)).toEqual(['a', 'b1', 'b2', 'c'])
  })

  test('a file counts once across stops', () => {
    const file = (path: string) => ({ path, additions: 1, deletions: 0 })
    expect(guideFileCount({ sections: [section('a', 1, [file('x.ts'), file('y.ts')]), section('b', 2, [file('x.ts')])] })).toBe(2)
  })

  test('only files with hunks become excerpts; a stored header is kept, a missing one is added', () => {
    const withHeader = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -10,2 +10,3 @@\n a\n+b\n c'
    const bare = '@@ -1 +1 @@\n-old\n+new'
    const excerpts = guideExcerpts(section('s', 1, [
      { path: 'x.ts', additions: 1, deletions: 0, hunks: withHeader },
      { path: 'whole.ts', additions: 4, deletions: 0 },
      { path: 'y.ts', additions: 1, deletions: 1, hunks: bare },
    ]))
    expect(excerpts.map((excerpt) => excerpt.path)).toEqual(['x.ts', 'y.ts'])
    expect(excerpts[0]!.patch).toBe(`${withHeader}\n`)
    expect(excerpts[1]!.patch).toBe('diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-old\n+new\n')
    expect(guideExcerptPatch({ path: 'z.ts', hunks: '   ' })).toBeNull()
    // The excerpt parses as one file on the diff surface.
    const parsed = buildReviewParsedDiff(excerpts[1]!.patch, 'guide-test')
    expect(parsed.kind === 'files' ? parsed.files.map((file) => file.path) : []).toEqual(['y.ts'])
  })

  test('the focus spans the hunks on the new side, or the old side when they only delete', () => {
    // The parser counts the lines a hunk has, so each hunk here has the lines its header names.
    expect(guideExcerptFocus('@@ -10,2 +12,3 @@\n a\n+x\n b\n@@ -40,1 +45,4 @@\n b\n+c\n+d\n+e')).toEqual({ side: 'new', start: 12, end: 48 })
    expect(guideExcerptFocus('@@ -7,3 +6,0 @@\n-a\n-b\n-c')).toEqual({ side: 'old', start: 7, end: 9 })
    expect(guideExcerptFocus('@@ -1 +1 @@\n-a\n+b')).toEqual({ side: 'new', start: 1, end: 1 })
    expect(guideExcerptFocus('no hunks')).toBeNull()
  })

  test('blank context lines at the end of a hunk are kept', () => {
    // WHY: a blank context line is a single space; dropping it breaks the
    // hunk's line count and the parser reports a mismatch.
    const errorSpy = spyOn(console, 'error')
    try {
      expect(guideExcerptFocus('@@ -1,5 +1,6 @@\n a\n-b\n+c\n+d\n e\n \n \n')).toEqual({ side: 'new', start: 1, end: 6 })
      expect(guideExcerptPatch({ path: 'x.ts', hunks: '@@ -1,2 +1,2 @@\n-a\n+b\n \n' })).toEndWith('+b\n \n')
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('the focus of a deleted file is its old lines', () => {
    const deleted = 'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b'
    expect(guideExcerptFocus(deleted)).toEqual({ side: 'old', start: 1, end: 2 })
  })

  test('the text fallback shows the hunks without the file header, and keeps the no-newline marker', () => {
    // WHY: a build without the diff surface still shows the change, and a
    // marker line is not mistaken for code.
    const patch = 'diff --git a/n.ts b/n.ts\nindex 1111111..2222222 100644\n--- a/n.ts\n+++ b/n.ts\n@@ -1,2 +1,2 @@ fn\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n'
    expect(guideExcerptText(patch)).toBe('@@ -1,2 +1,2 @@ fn\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file')
    expect(guideExcerptFocus(patch)).toEqual({ side: 'new', start: 1, end: 2 })
  })

  test('focused rows match the side and range, only in the target file (ported from T3)', () => {
    const rows = [
      { id: 'old', kind: 'line' as const, fileId: 'a', oldLineNumber: 10, change: 'delete' as const },
      { id: 'new', kind: 'line' as const, fileId: 'a', newLineNumber: 20, change: 'add' as const },
      { id: 'context', kind: 'line' as const, fileId: 'a', oldLineNumber: 11, newLineNumber: 21 },
      { id: 'other', kind: 'line' as const, fileId: 'b', newLineNumber: 20 },
    ]
    expect(guideFocusedRows(rows, 'a', { side: 'old', start: 10, end: 11 }).map((row) => row.id)).toEqual(['old', 'context'])
    expect(guideFocusedRows(rows, 'a', { side: 'new', start: 20, end: 21 }).map((row) => row.id)).toEqual(['new', 'context'])
    expect(guideFocusedRows(rows, undefined, { side: 'new', start: 20, end: 21 })).toEqual([])
    expect(guideFocusedRows(rows, 'a', null)).toEqual([])
  })
})

describe('review comments on the diff (ported from T3)', () => {
  const data: NativeReviewDiffData = {
    rows: [
      { kind: 'file', id: 'header', fileId: 'f', filePath: 'a.ts' },
      { kind: 'line', id: 'old', fileId: 'f', change: 'delete', oldLineNumber: 2 },
      { kind: 'line', id: 'new', fileId: 'f', change: 'add', newLineNumber: 2 },
    ],
    files: [{ id: 'f', path: 'a.ts', language: 'typescript', additions: 1, deletions: 1 }],
    commentTargetsByRowId: new Map(),
    rowIdByCommentLineId: new Map(),
    additions: 1,
    deletions: 1,
  }
  const thread: ReviewThread = { id: 't', filePath: 'a.ts', line: 2, side: 'LEFT', isResolved: false, isOutdated: false, comments: [{ id: 'c', author: 'ada', body: 'Why?', createdAt: '' }] }

  test('old and new lines with one number get their own threads', () => {
    const annotated = annotatePullRequestDiff(data, [thread, { ...thread, id: 'right', side: 'RIGHT' }], [], 'head')
    expect(annotated.rows.map((row) => row.id)).toEqual(['header', 'old', 'discussion:t', 'new', 'discussion:right'])
    expect(annotated.rows[2]!.commentText).toContain('ada\nWhy?')
  })

  test('outdated threads, missing files, and drafts of another head stay off the code', () => {
    const draft = { id: 'd', path: 'a.ts', line: 2, side: 'RIGHT' as const, body: 'Feedback', headSha: 'old' }
    const annotated = annotatePullRequestDiff(data, [{ ...thread, isOutdated: true }, { ...thread, id: 'missing', filePath: 'b.ts' }], [draft], 'head')
    expect(annotated.rows.map((row) => row.id)).toEqual(['header', 'old', 'new'])
    const current = annotatePullRequestDiff(data, [], [{ ...draft, headSha: 'head' }], 'head')
    expect(current.rows.map((row) => row.id)).toEqual(['header', 'old', 'new', 'draft:d'])
  })

  test('a file thread sits under the file header', () => {
    const annotated = annotatePullRequestDiff(data, [{ ...thread, line: null }], [], 'head')
    expect(annotated.rows.map((row) => row.id)).toEqual(['header', 'discussion:t', 'old', 'new'])
  })

  test('the anchor of a selection takes its side from the last line', () => {
    const line = (change: 'context' | 'add' | 'delete', oldLineNumber: number | null, newLineNumber: number | null) => ({ change, oldLineNumber, newLineNumber })
    expect(draftAnchor([line('add', null, 5)])).toEqual({ side: 'RIGHT', line: 5 })
    expect(draftAnchor([line('context', 3, 3), line('delete', 4, null), line('add', null, 4)])).toEqual({ side: 'RIGHT', line: 4, startLine: 3 })
    expect(draftAnchor([line('delete', 7, null), line('delete', 8, null)])).toEqual({ side: 'LEFT', line: 8, startLine: 7 })
    expect(draftAnchor([])).toBeNull()
  })

  test('a real parsed diff takes a comment row on its line', () => {
    const parsed = buildReviewParsedDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n', 'comments-test')
    const annotated = annotatePullRequestDiff(buildNativeReviewDiffData(parsed), [{ ...thread, side: 'RIGHT', line: 1 }], [], 'head')
    const index = annotated.rows.findIndex((row) => row.id === 'discussion:t')
    expect(annotated.rows[index - 1]).toMatchObject({ kind: 'line', newLineNumber: 1 })
  })
})
