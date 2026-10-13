// Adapted from T3 Code apps/mobile/src/features/pull-requests/guide/guideDiffFocus.ts and guide/PullRequestGuideScreen.tsx (MIT, see UPSTREAM.md).
import { parsePatchFiles } from '@pierre/diffs/utils/parsePatchFiles'
import { quoteGitPath } from '@solus/client-core/git-path-name'
import type { GuideAttentionKind, GuideFileRef, GuideSection, ReviewGuide } from '@solus/contracts/review'
import type { NativeReviewDiffRow } from '../../diffs/nativeReviewDiffSurface'

/**
 * The guide as a tour: one stop for each guide section, in section order.
 * A stop shows the section's explanation and, for each file that names
 * hunks, an excerpt of those hunks on the diff surface. An excerpt opens
 * its file in the Files tab with the excerpt's lines selected.
 */

export const GUIDE_ATTENTION_LABELS = {
  tradeoff: 'A tradeoff to weigh',
  contract: 'A contract to check',
  product: 'A product call',
  risk: 'A risk to judge',
  accessibility: 'An accessibility call',
} as const satisfies Record<GuideAttentionKind, string>

/** The lines of a file an excerpt is about, on one side of the diff. */
export interface GuideDiffFocus {
  readonly side: 'old' | 'new'
  readonly start: number
  readonly end: number
}

export interface GuideExcerpt {
  readonly path: string
  /** A unified patch of the file's hunks, with a file header. */
  readonly patch: string
  readonly focus: GuideDiffFocus | null
}

/** The stops in section order; sections with the same order keep the guide's order. */
export function guideStops(guide: Pick<ReviewGuide, 'sections'>): GuideSection[] {
  return guide.sections.map((section, index) => ({ section, index }))
    .sort((a, b) => a.section.order - b.section.order || a.index - b.index)
    .map(({ section }) => section)
}

/** Every file the tour goes through, once. */
export function guideFileCount(guide: Pick<ReviewGuide, 'sections'>): number {
  return new Set(guide.sections.flatMap((section) => section.files.map((file) => file.path))).size
}

/** The hunks of a patch, as the parser reads them. */
function parsedHunks(patch: string) {
  return parsePatchFiles(patch).flatMap((part) => part.files).flatMap((file) => file.hunks)
}

/** The lines the hunks change: the new side, or the old side for hunks that only delete. */
export function guideExcerptFocus(hunks: string): GuideDiffFocus | null {
  const patch = guideExcerptPatch({ path: 'excerpt', hunks })
  const ranges = patch ? parsedHunks(patch) : []
  const first = ranges[0]
  const last = ranges.at(-1)
  if (!first || !last) return null
  if (ranges.every((range) => range.additionCount === 0)) {
    return { side: 'old', start: first.deletionStart, end: Math.max(first.deletionStart, last.deletionStart + last.deletionCount - 1) }
  }
  return { side: 'new', start: first.additionStart, end: Math.max(first.additionStart, last.additionStart + last.additionCount - 1) }
}

/**
 * The excerpt as plain text, for a build without the diff surface: each hunk
 * header and its lines, without the file header the path row already shows.
 * The lines are in the order the diff surface shows them.
 */
export function guideExcerptText(patch: string): string {
  const lines: string[] = []
  for (const file of parsePatchFiles(patch).flatMap((part) => part.files)) {
    for (const hunk of file.hunks) {
      lines.push(hunk.hunkSpecs?.replace(/\r?\n$/, '') ?? `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`)
      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          pushLines(lines, ' ', file.additionLines.slice(content.additionLineIndex, content.additionLineIndex + content.lines))
        } else {
          pushLines(lines, '-', file.deletionLines.slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions))
          pushLines(lines, '+', file.additionLines.slice(content.additionLineIndex, content.additionLineIndex + content.additions))
        }
      }
    }
  }
  return lines.join('\n')
}

/** Add parsed lines with their prefix. A parsed line with no line end is the
 *  last line of its file, so git's marker follows it. */
function pushLines(lines: string[], prefix: string, parsed: readonly string[]): void {
  for (const text of parsed) {
    if (text.endsWith('\n')) lines.push(prefix + text.slice(0, -1))
    else lines.push(prefix + text, '\\ No newline at end of file')
  }
}

/** The file's hunks as a patch the diff surface reads. The host stores them
 *  with their file header; a header is added when it is missing. */
export function guideExcerptPatch(file: Pick<GuideFileRef, 'path' | 'hunks'>): string | null {
  // Strip only line ends at the end: a blank context line is a single space.
  const hunks = file.hunks?.trimStart().replace(/(?:\r?\n)+$/, '')
  if (!hunks || !/^@@ /m.test(hunks)) return null
  const oldPath = quoteGitPath(`a/${file.path}`)
  const newPath = quoteGitPath(`b/${file.path}`)
  const header = /^(?:diff --git |--- )/.test(hunks) ? '' : `diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}\n`
  return `${header}${hunks}\n`
}

/** The excerpts of a stop: one for each file with hunks, in the section's file order. */
export function guideExcerpts(section: Pick<GuideSection, 'files'>): GuideExcerpt[] {
  return section.files.flatMap((file) => {
    const patch = guideExcerptPatch(file)
    return patch ? [{ path: file.path, patch, focus: guideExcerptFocus(file.hunks ?? '') }] : []
  })
}

/** The rows of `fileId` inside the focus, on its side. Nothing while the file is not loaded. */
export function guideFocusedRows(rows: readonly NativeReviewDiffRow[], fileId: string | undefined, focus: GuideDiffFocus | null | undefined): NativeReviewDiffRow[] {
  if (!fileId || !focus) return []
  return rows.filter((row) => {
    const line = focus.side === 'old' ? row.oldLineNumber : row.newLineNumber
    return row.fileId === fileId && row.kind === 'line' && line != null && line >= focus.start && line <= focus.end
  })
}
