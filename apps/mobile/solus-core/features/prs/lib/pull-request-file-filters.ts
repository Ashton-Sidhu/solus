// Adapted from T3 Code apps/mobile/src/features/pull-requests/pullRequestFileFilters.ts and pullRequestTabScroll.ts (MIT, see UPSTREAM.md).
import type { ReviewParsedDiff } from '../../../../src/features/review/reviewModel'
import { type ChangeKind, changedFileKind } from '@solus/client-core/change-breakdown'

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
