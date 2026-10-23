// Adapted from T3 Code apps/mobile/src/features/pull-requests/pullRequestFileFilters.ts and pullRequestTabScroll.ts (MIT, see UPSTREAM.md).
import type { ReviewParsedDiff } from '../../review/reviewModel'
import { type ChangeKind, changedFileKind } from '@solus/client-core/change-breakdown'

/** How many files the classification filter hides. */
export function hiddenFileCount(parsed: ReviewParsedDiff, visible: ReviewParsedDiff): number {
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
 * files, viewed files, and hidden files.
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
    hiddenCount ? `${hiddenCount} ${hiddenCount === 1 ? 'file' : 'files'} hidden` : null,
  ].filter(Boolean).join(' · ')
}

/** Classification filtering preserves each file and its comment line ids. */
export function filterPullRequestFileKinds(parsed: ReviewParsedDiff, kinds: readonly ChangeKind[] | null, includePath?: string): ReviewParsedDiff {
  if (parsed.kind !== 'files' || kinds === null) return parsed
  const files = parsed.files.filter((file) => file.path === includePath || kinds.includes(changedFileKind(file.path)))
  if (files.length === parsed.files.length) return parsed
  return {
    ...parsed,
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  }
}
