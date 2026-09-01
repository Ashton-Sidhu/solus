import type { DiffComment, DiffCommentDraft } from '../../shared/types'
import type { WorkspaceContext } from './workspace.context.svelte'
import { formatDiffInlineComments } from './session.utils'

export function addDiffComment(ctx: WorkspaceContext, comment: DiffComment): void {
  const tab = ctx.tabs[ctx.activeTabId]
  if (!tab) return
  tab.diffComments.push(comment)
}

export function updateDiffComment(ctx: WorkspaceContext, commentId: string, newText: string): void {
  const tab = ctx.tabs[ctx.activeTabId]
  if (!tab) return
  const c = tab.diffComments.find((dc) => dc.id === commentId)
  if (c) c.comment = newText
}

export function removeDiffComment(ctx: WorkspaceContext, commentId: string): void {
  const tab = ctx.tabs[ctx.activeTabId]
  if (!tab) return
  const idx = tab.diffComments.findIndex((dc) => dc.id === commentId)
  if (idx !== -1) tab.diffComments.splice(idx, 1)
}

export function restoreDiffComment(ctx: WorkspaceContext, comment: DiffComment, index: number): void {
  const tab = ctx.tabs[ctx.activeTabId]
  if (!tab) return
  if (tab.diffComments.some((dc) => dc.id === comment.id)) return
  const clamped = Math.max(0, Math.min(index, tab.diffComments.length))
  tab.diffComments.splice(clamped, 0, comment)
}

export function clearDiffComments(ctx: WorkspaceContext): void {
  const tab = ctx.tabs[ctx.activeTabId]
  if (!tab) return
  tab.diffComments.splice(0, tab.diffComments.length)
  tab.diffCommentDraft = null
}

export function setDiffCommentDraft(ctx: WorkspaceContext, draft: DiffCommentDraft | null): void {
  const tab = ctx.tabs[ctx.activeTabId]
  if (!tab) return
  tab.diffCommentDraft = draft
}

export function updateDiffCommentDraftValue(ctx: WorkspaceContext, value: string): void {
  const tab = ctx.tabs[ctx.activeTabId]
  if (!tab?.diffCommentDraft) return
  tab.diffCommentDraft.value = value
}

export function setDiffGeneralComment(ctx: WorkspaceContext, value: string): void {
  const tab = ctx.tabs[ctx.activeTabId]
  if (!tab) return
  tab.diffGeneralComment = value
}

export function submitDiffFeedback(ctx: WorkspaceContext, generalComment: string): boolean {
  const tab = ctx.tabs[ctx.activeTabId]
  if (!tab) return false
  const inlineComments = tab.diffComments
  if (!generalComment && inlineComments.length === 0) return false

  const parts: string[] = []
  if (generalComment) parts.push(generalComment)
  if (inlineComments.length > 0) {
    parts.push(`Inline comments:\n${formatDiffInlineComments(inlineComments)}`)
  }

  ctx.sendMessage(parts.join('\n\n'))
  clearDiffComments(ctx)
  tab.diffGeneralComment = ''
  return true
}

export async function submitDiffFeedbackToNewSession(ctx: WorkspaceContext, opts: {
  generalComment: string
  filePath: string | null
  diffText: string
  branchContext?: string
}): Promise<boolean> {
  const { generalComment, filePath, diffText, branchContext } = opts
  const tab = ctx.tabs[ctx.activeTabId]
  const inlineComments = tab?.diffComments ?? []
  if (!generalComment && inlineComments.length === 0) return false

  const sourceTabId = ctx.activeTabId
  const newTabId = await ctx.createTab()
  const sourceSession = ctx.sessionFor(sourceTabId)
  if (sourceSession?.workingDirectory) {
    const newSession = ctx.sessionFor(newTabId)
    if (newSession) newSession.workingDirectory = sourceSession.workingDirectory
  }

  const parts: string[] = []
  if (branchContext) parts.push(`Branch: ${branchContext}`)
  if (filePath) parts.push(`File: ${filePath}`)
  if (diffText) parts.push(`Diff:\n\`\`\`diff\n${diffText}\n\`\`\``)
  if (generalComment) parts.push(`Feedback: ${generalComment}`)
  if (inlineComments.length > 0) {
    parts.push(`Inline comments:\n${formatDiffInlineComments(inlineComments)}`)
  }

  ctx.sendMessage(parts.join('\n\n'))
  if (tab) {
    tab.diffComments.splice(0, tab.diffComments.length)
    tab.diffCommentDraft = null
    tab.diffGeneralComment = ''
  }
  return true
}
