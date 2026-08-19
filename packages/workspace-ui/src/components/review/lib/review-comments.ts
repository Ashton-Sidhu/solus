import type { DiffComment } from '@solus/contracts/types'
import { uuid } from '@solus/contracts/uuid'
import type { GuideDiffCommentSave } from '../../pr-review/guide/lib/guide-data'

/**
 * Inline comments written on a guide's diff cards go into the same list the
 * diff stream writes to — the reviewed tab's `diffComments`. A comment made
 * while reading the walkthrough and one made while reading the stream are the
 * same comment about the same lines, so they share an anchor, a count, and the
 * one send at the bottom of the pane.
 *
 * The pull-request pane keeps `ReviewDrafts` instead, because a draft there is
 * bound to a guide key on its way to becoming a GitHub review. A local review's
 * feedback goes to an agent, and the tab's own list is what an agent reads.
 */
export interface ReviewCommentStore {
  comments: DiffComment[]
  add: (comment: DiffComment) => void
  update: (id: string, text: string) => void
  remove: (id: string) => void
}

/** Edit when the save names an existing comment, else upsert on the anchor so
 *  re-commenting the same lines from the other view edits rather than duplicates. */
export function saveGuideComment(store: ReviewCommentStore, save: GuideDiffCommentSave): void {
  if (save.id) {
    store.update(save.id, save.comment)
    return
  }
  const existing = store.comments.find(
    (comment) =>
      comment.filePath === save.filePath &&
      comment.side === save.side &&
      comment.startLine === save.startLine &&
      comment.endLine === save.endLine,
  )
  if (existing) {
    store.update(existing.id, save.comment)
    return
  }
  store.add({
    id: uuid(),
    filePath: save.filePath,
    startLine: save.startLine,
    endLine: save.endLine,
    side: save.side,
    selectedCode: save.selectedCode,
    comment: save.comment,
    createdAt: save.createdAt ?? Date.now(),
  })
}

/** "18 files · about a minute" — what generating will cost, in this change's own
 *  terms. Sized off the file count because that is what the producer walks. */
export function guideEmptyHint(fileCount: number): string | undefined {
  if (fileCount === 0) return undefined
  const files = `${fileCount} file${fileCount === 1 ? '' : 's'}`
  const duration =
    fileCount <= 5 ? 'well under a minute' : fileCount <= 25 ? 'about a minute' : 'a few minutes'
  return `${files} · ${duration}`
}
