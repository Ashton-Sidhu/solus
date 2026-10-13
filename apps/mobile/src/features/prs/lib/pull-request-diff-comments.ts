// Adapted from T3 Code apps/mobile/src/features/pull-requests/pullRequestDiffComments.ts (MIT, see UPSTREAM.md).
import type { DraftReviewComment, ReviewThread } from '@solus/contracts/providers'
import type { NativeReviewDiffRow } from '../../diffs/nativeReviewDiffSurface'
import type { NativeReviewDiffData } from '../../review/nativeReviewDiffAdapter'
import type { ReviewRenderableLineRow } from '../../review/reviewModel'
import type { PendingReviewComment } from './pull-request-review-draft'

/**
 * Review comments on the diff surface. A review thread and a draft comment
 * show as a comment row under the line they are anchored to: by path, side,
 * and line number, because an old and a new line can have the same number.
 * An outdated thread, or an anchor in a file not loaded yet, shows no row.
 */

export type DraftAnchor = Pick<DraftReviewComment, 'side' | 'line' | 'startLine'>

/**
 * Where a comment on the selected lines goes. The last line names the side:
 * a deleted line is on the old side (LEFT), every other line on the new side
 * (RIGHT). The range starts at the first selected line that has a number on
 * that side. Null when no line has one.
 */
export function draftAnchor(lines: readonly Pick<ReviewRenderableLineRow, 'change' | 'oldLineNumber' | 'newLineNumber'>[]): DraftAnchor | null {
  const last = lines.at(-1)
  if (!last) return null
  const side = last.change === 'delete' ? 'LEFT' : 'RIGHT'
  const numberOf = (line: (typeof lines)[number]) => side === 'LEFT' ? line.oldLineNumber : line.newLineNumber
  const line = numberOf(last)
  if (line === null) return null
  const start = lines.map(numberOf).find((value): value is number => value !== null) ?? line
  return start !== line ? { side, line, startLine: start } : { side, line }
}

const lineKey = (path: string, side: 'LEFT' | 'RIGHT', line: number) => `${path}\u0000${side}\u0000${line}`

/** The rows a comment can be anchored to: line rows by path, side, and number; file rows by path. */
interface AnchorRows {
  readonly lines: Map<string, NativeReviewDiffRow>
  readonly fileHeaders: Map<string, NativeReviewDiffRow>
}

function indexAnchorRows(data: NativeReviewDiffData): AnchorRows {
  const paths = new Map(data.files.map((file) => [file.id, file.path]))
  const lines = new Map<string, NativeReviewDiffRow>()
  const fileHeaders = new Map<string, NativeReviewDiffRow>()
  for (const row of data.rows) {
    const path = row.filePath ?? (row.fileId ? paths.get(row.fileId) : undefined)
    if (!path) continue
    if (row.kind === 'file') fileHeaders.set(path, row)
    if (row.kind !== 'line') continue
    if (row.oldLineNumber) lines.set(lineKey(path, 'LEFT', row.oldLineNumber), row)
    if (row.newLineNumber) lines.set(lineKey(path, 'RIGHT', row.newLineNumber), row)
  }
  return { lines, fileHeaders }
}

/** The text of the comment row of a review thread: author, state, first comment, and count. */
function threadCommentText(thread: ReviewThread): string {
  const first = thread.comments[0]
  const count = thread.comments.length
  return `${first?.author ?? 'Discussion'}${thread.isResolved ? ' · Resolved' : ''}\n${first?.body ?? ''}\n${count} ${count === 1 ? 'comment' : 'comments'} · Tap to open`
}

/** The diff rows with a comment row after each anchored line. */
export function annotatePullRequestDiff(
  data: NativeReviewDiffData,
  threads: readonly ReviewThread[],
  drafts: readonly PendingReviewComment[],
  headSha: string | undefined,
): NativeReviewDiffData {
  if (threads.length === 0 && drafts.length === 0) return data
  const { lines, fileHeaders } = indexAnchorRows(data)
  const anchored = new Map<string, NativeReviewDiffRow[]>()
  const attach = (anchor: NativeReviewDiffRow | undefined, path: string, id: string, text: string, label: string) => {
    if (!anchor) return
    const rows = anchored.get(anchor.id) ?? []
    rows.push({ kind: 'comment', id, fileId: anchor.fileId, filePath: path, commentText: text, commentRangeLabel: label })
    anchored.set(anchor.id, rows)
  }
  for (const thread of threads) {
    if (thread.isOutdated) continue
    const anchor = thread.line === null ? fileHeaders.get(thread.filePath) : lines.get(lineKey(thread.filePath, thread.side, thread.line))
    attach(
      anchor,
      thread.filePath,
      `discussion:${thread.id}`,
      threadCommentText(thread),
      thread.line === null ? 'file' : String(thread.line),
    )
  }
  for (const draft of drafts) {
    // A draft written on another head is not on this code.
    if (draft.headSha !== headSha) continue
    attach(lines.get(lineKey(draft.path, draft.side, draft.line)), draft.path, `draft:${draft.id}`, `Pending review · Tap to edit\n${draft.body}`, String(draft.line))
  }
  return { ...data, rows: data.rows.flatMap((row) => [row, ...(anchored.get(row.id) ?? [])]) }
}
