// Adapted from T3 Code apps/mobile/src/features/pull-requests/pullRequestFileFilters.ts and pullRequestTabScroll.ts (MIT, see UPSTREAM.md).
import type { ReviewParsedDiff } from '../../review/reviewModel'
import { changedFileKind } from '@solus/client-core/change-breakdown'

/** Test support such as fixtures and snapshots is hidden along with the tests. */
export function isPullRequestTestFile(path: string): boolean {
  const kind = changedFileKind(path)
  return kind === 'tests' || kind === 'mocks'
}

/**
 * Hides test files from the Files tab. Whole files go; the files that stay
 * keep their objects and line ids, so a hidden test never moves a comment
 * anchor. `includePath` stays visible even when it is a test: a guide jump
 * to a test file must find it.
 */
export function filterPullRequestTestFiles(parsed: ReviewParsedDiff, hideTestFiles: boolean, includePath?: string): ReviewParsedDiff {
  if (!hideTestFiles || parsed.kind !== 'files') return parsed
  const files = parsed.files.filter((file) => file.path === includePath || !isPullRequestTestFile(file.path))
  if (files.length === parsed.files.length) return parsed
  return {
    ...parsed,
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  }
}

/** How many test files `filterPullRequestTestFiles` took out of `parsed`. */
export function hiddenTestFileCount(parsed: ReviewParsedDiff, visible: ReviewParsedDiff): number {
  return parsed.kind === 'files' && visible.kind === 'files' ? parsed.fileCount - visible.fileCount : 0
}

/**
 * The scroll offset of the tab the person moves to. The header is shared:
 * while it is still in view, every tab shows it at the same place; after it
 * scrolled away, each tab goes back to its own reading position.
 */
export function pullRequestTabOffset(current: number, saved: number | undefined, headerEnd: number): number {
  return current < headerEnd ? current : Math.max(headerEnd, saved ?? headerEnd)
}

/**
 * The one-line summary over the Files tab: the commit, or the count of
 * files, viewed files, and hidden test files.
 */
export function pullRequestFilesSummary(input: {
  readonly commitSha: string | null
  readonly visible: ReviewParsedDiff
  readonly hiddenCount: number
  readonly viewedCount: number
}): string {
  const { commitSha, hiddenCount, viewedCount } = input
  const fileCount = input.visible.kind === 'files' ? input.visible.fileCount : 0
  return [
    commitSha ? `Commit ${commitSha.slice(0, 7)}` : `${fileCount} ${hiddenCount ? 'visible' : 'changed'} ${fileCount === 1 ? 'file' : 'files'}`,
    commitSha ? null : `${viewedCount} viewed`,
    hiddenCount ? `${hiddenCount} test ${hiddenCount === 1 ? 'file' : 'files'} hidden` : null,
  ].filter(Boolean).join(' · ')
}
