import type { DiffComment, DiffCommentDraft, Session } from '@solus/contracts/types'

// Queued review feedback belongs to a session, not to the tab or pane showing
// it: every surface reviewing one conversation edits one list. A surface names
// the session it shows; `undefined` (the tab closed underneath it) is a no-op.

export function addDiffComment(session: Session | undefined, comment: DiffComment): void {
  session?.diffComments.push(comment)
}

export function updateDiffComment(session: Session | undefined, commentId: string, newText: string): void {
  const c = session?.diffComments.find((dc) => dc.id === commentId)
  if (c) c.comment = newText
}

export function removeDiffComment(session: Session | undefined, commentId: string): void {
  if (!session) return
  const idx = session.diffComments.findIndex((dc) => dc.id === commentId)
  if (idx !== -1) session.diffComments.splice(idx, 1)
}

export function restoreDiffComment(session: Session | undefined, comment: DiffComment, index: number): void {
  if (!session) return
  if (session.diffComments.some((dc) => dc.id === comment.id)) return
  const clamped = Math.max(0, Math.min(index, session.diffComments.length))
  session.diffComments.splice(clamped, 0, comment)
}

export function setDiffCommentDraft(session: Session | undefined, draft: DiffCommentDraft | null): void {
  if (session) session.diffCommentDraft = draft
}

export function updateDiffCommentDraftValue(session: Session | undefined, value: string): void {
  if (session?.diffCommentDraft) session.diffCommentDraft.value = value
}

export function setDiffGeneralComment(session: Session | undefined, value: string): void {
  if (session) session.diffGeneralComment = value
}
