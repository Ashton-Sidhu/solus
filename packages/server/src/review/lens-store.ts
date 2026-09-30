import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  ReviewLens,
  ReviewLensAddress,
  ReviewLensComment,
  ReviewLensCommentChange,
  ReviewLensPost,
  ReviewLensRecord,
  ReviewLensVersion,
} from '@solus/contracts/review'
import { dataDir } from '../platform/paths'
import { readJson, reviewGuidePath, writeJsonAtomic } from './review-store'

// One record per review target: the current lens, one previous version for
// Restore, and the comments of each version (docs/plans/review-lenses.md).
// The transitions below are pure so the rules are testable without a disk.

/** A root of its own: a lens key is a guide key, so sharing the guide
 * directory would put `<branch>.json` guides and lenses in one namespace. */
export function lensPath(address: ReviewLensAddress, root = join(dataDir(), 'review-lenses')): string {
  return reviewGuidePath(address.repoRoot, address.key, root)
}

export function readLensRecord(address: ReviewLensAddress): Promise<ReviewLensRecord | null> {
  return readJson<ReviewLensRecord>(lensPath(address))
}

export function writeLensRecord(address: ReviewLensAddress, record: ReviewLensRecord, canCommit?: () => boolean): Promise<boolean> {
  return writeJsonAtomic(lensPath(address), record, `review-lens ${address.key}`, canCommit)
}

/** Record a new lens. The current version becomes the previous one; the old
 * previous version is dropped. A new lens starts with no comments, because
 * pins on a different render point at nothing. A lens edit keeps the current
 * comments and resolves the ones it applied. */
export function commitLens(
  record: ReviewLensRecord | null,
  lens: ReviewLens,
  now: number,
  appliedCommentIds: readonly string[] | null,
): ReviewLensRecord {
  const comments = appliedCommentIds && record
    ? record.current.comments.map((comment) =>
        appliedCommentIds.includes(comment.id) && !comment.resolvedAt ? { ...comment, resolvedAt: now } : comment)
    : []
  const next: ReviewLensRecord = { version: 1, current: { lens, comments }, updatedAt: now }
  if (record) next.previous = record.current
  return next
}

/** Swap the current lens and the previous version. Restore is its own reverse. */
export function restoreLens(record: ReviewLensRecord, now: number): ReviewLensRecord | null {
  if (!record.previous) return null
  return { version: 1, current: record.previous, previous: record.current, updatedAt: now }
}

export function changeLensComments(
  record: ReviewLensRecord,
  change: ReviewLensCommentChange,
  now: number,
  newId: () => string = randomUUID,
): ReviewLensRecord {
  const comments = record.current.comments
  const update = (commentId: string, apply: (comment: ReviewLensComment) => ReviewLensComment | null): ReviewLensComment[] => {
    const existing = comments.find((comment) => comment.id === commentId)
    if (!existing) throw new Error('This lens comment no longer exists.')
    const next = apply(existing)
    return comments.flatMap((comment) => comment !== existing ? [comment] : next ? [next] : [])
  }
  let nextComments: ReviewLensComment[]
  switch (change.kind) {
    case 'add':
      nextComments = [...comments, { ...change.comment, id: newId(), createdAt: now }]
      break
    case 'edit':
      nextComments = update(change.commentId, (comment) => ({ ...comment, body: change.body }))
      break
    case 'resolve':
      nextComments = update(change.commentId, ({ resolvedAt: _resolvedAt, ...comment }) =>
        change.resolved ? { ...comment, resolvedAt: now } : comment)
      break
    case 'delete':
      nextComments = update(change.commentId, (comment) => {
        // The PR copy would be orphaned: nothing here could retract it later.
        if (comment.posted?.kind === 'conversation') throw new Error('Retract the pull-request comment before you delete it.')
        return null
      })
      break
    case 'mark-drafted':
      nextComments = update(change.commentId, ({ posted: _posted, ...comment }) =>
        change.draftId ? { ...comment, posted: { kind: 'draft-line', draftId: change.draftId }, resolvedAt: comment.resolvedAt ?? now } : comment)
      break
  }
  return withCurrent(record, { ...record.current, comments: nextComments }, now)
}

/** A comment posted to the pull request, or taken back (`post: null`). */
export function markLensCommentPosted(
  record: ReviewLensRecord,
  commentId: string,
  post: ReviewLensPost | null,
  now: number,
): ReviewLensRecord {
  const comments = record.current.comments.map((comment) => {
    if (comment.id !== commentId) return comment
    if (!post) {
      const { posted: _posted, ...rest } = comment
      return rest
    }
    return { ...comment, posted: post, resolvedAt: comment.resolvedAt ?? now }
  })
  return withCurrent(record, { ...record.current, comments }, now)
}

function withCurrent(record: ReviewLensRecord, current: ReviewLensVersion, now: number): ReviewLensRecord {
  return { ...record, current, updatedAt: now }
}

/** The PR body for a posted lens comment: the reader on the code host has no
 * lens, so the pinned text travels with the comment. */
export function lensCommentPostBody(comment: ReviewLensComment, lensTitle: string): string {
  const lines: string[] = []
  const quote = comment.quote?.trim()
  if (quote) {
    lines.push(...quote.slice(0, 280).split('\n').map((line) => `> ${line}`), '')
  }
  lines.push(comment.body.trim(), '', `<sub>From the Solus lens “${lensTitle}”.</sub>`)
  return lines.join('\n')
}
