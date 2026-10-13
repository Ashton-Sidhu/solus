// Adapted from T3 Code apps/mobile/src/features/pull-requests/pullRequestDiffPages.ts (MIT, see UPSTREAM.md).
import type { PrDiffSlice } from '@solus/contracts/providers'

/**
 * A pull request's diff arrives in pages: each page is complete file patches,
 * and the provider's cursor names the next one. The device keeps the pages
 * it read, in order, and joins them into one unified patch for the diff
 * surface. Parsing the patch is the diff surface's work, not this one's.
 */

export interface PullRequestDiffPage {
  /** The cursor this page was asked with; null for the first page. */
  cursor: string | null
  patch: string
  truncated: boolean
  nextCursor: string | null
}

/** The pages after a read of `cursor`. A page that did not change keeps the
 *  same array. A page that changed drops the pages after it: their cursors
 *  belong to the patch before the change. */
export function retainPullRequestDiffPage(
  pages: readonly PullRequestDiffPage[],
  cursor: string | null,
  slice: PrDiffSlice,
): readonly PullRequestDiffPage[] {
  const index = pages.findIndex((page) => page.cursor === cursor)
  const page: PullRequestDiffPage = { cursor, patch: slice.patch, truncated: slice.truncated, nextCursor: slice.nextCursor }
  if (index === -1) return [...pages, page]
  const previous = pages[index]!
  if (previous.patch === page.patch && previous.truncated === page.truncated && previous.nextCursor === page.nextCursor) return pages
  return [...pages.slice(0, index), page]
}

/** The unified patch of every page read, in page order. */
export function pullRequestDiffPatch(pages: readonly PullRequestDiffPage[]): string {
  return pages
    .map((page) => page.patch)
    .filter((patch) => patch.length > 0)
    .map((patch) => (patch.endsWith('\n') ? patch : `${patch}\n`))
    .join('')
}

/** The cursor of the page after the last one read; null when there is none. */
export function nextDiffCursor(pages: readonly PullRequestDiffPage[]): string | null {
  return pages.at(-1)?.nextCursor ?? null
}

/** True when a page left out file contents the provider would not send. */
export function diffIsTruncated(pages: readonly PullRequestDiffPage[]): boolean {
  return pages.some((page) => page.truncated)
}
