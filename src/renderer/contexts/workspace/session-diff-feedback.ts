import type { AgentId, DiffComment, DiffCommentDraft, ReasoningEffort } from '../../../shared/types'
import type { WorkspaceContext } from './workspace.context.svelte'
import { formatDiffInlineComments } from './session.utils'

function targetTab(ctx: WorkspaceContext, tabId?: string) {
  return ctx.tabs[tabId ?? ctx.activeTabId]
}

export function addDiffComment(ctx: WorkspaceContext, comment: DiffComment, tabId?: string): void {
  const tab = targetTab(ctx, tabId)
  if (!tab) return
  tab.diffComments.push(comment)
}

export function updateDiffComment(ctx: WorkspaceContext, commentId: string, newText: string, tabId?: string): void {
  const tab = targetTab(ctx, tabId)
  if (!tab) return
  const c = tab.diffComments.find((dc) => dc.id === commentId)
  if (c) c.comment = newText
}

export function removeDiffComment(ctx: WorkspaceContext, commentId: string, tabId?: string): void {
  const tab = targetTab(ctx, tabId)
  if (!tab) return
  const idx = tab.diffComments.findIndex((dc) => dc.id === commentId)
  if (idx !== -1) tab.diffComments.splice(idx, 1)
}

export function restoreDiffComment(ctx: WorkspaceContext, comment: DiffComment, index: number, tabId?: string): void {
  const tab = targetTab(ctx, tabId)
  if (!tab) return
  if (tab.diffComments.some((dc) => dc.id === comment.id)) return
  const clamped = Math.max(0, Math.min(index, tab.diffComments.length))
  tab.diffComments.splice(clamped, 0, comment)
}

export function clearDiffComments(ctx: WorkspaceContext, tabId?: string): void {
  const tab = targetTab(ctx, tabId)
  if (!tab) return
  tab.diffComments.splice(0, tab.diffComments.length)
  tab.diffCommentDraft = null
}

export function setDiffCommentDraft(ctx: WorkspaceContext, draft: DiffCommentDraft | null, tabId?: string): void {
  const tab = targetTab(ctx, tabId)
  if (!tab) return
  tab.diffCommentDraft = draft
}

export function updateDiffCommentDraftValue(ctx: WorkspaceContext, value: string, tabId?: string): void {
  const tab = targetTab(ctx, tabId)
  if (!tab?.diffCommentDraft) return
  tab.diffCommentDraft.value = value
}

export function setDiffGeneralComment(ctx: WorkspaceContext, value: string, tabId?: string): void {
  const tab = targetTab(ctx, tabId)
  if (!tab) return
  tab.diffGeneralComment = value
}

export function submitDiffFeedback(ctx: WorkspaceContext, generalComment: string, tabId?: string): boolean {
  const tab = targetTab(ctx, tabId)
  if (!tab) return false
  const inlineComments = tab.diffComments
  if (!generalComment && inlineComments.length === 0) return false

  const parts: string[] = []
  if (generalComment) parts.push(generalComment)
  if (inlineComments.length > 0) {
    parts.push(`Inline comments:\n${formatDiffInlineComments(inlineComments)}`)
  }

  ctx.sendMessage(parts.join('\n\n'), undefined, tabId)
  clearDiffComments(ctx, tabId)
  tab.diffGeneralComment = ''
  return true
}

export async function submitDiffFeedbackToNewSession(ctx: WorkspaceContext, opts: {
  generalComment: string
  filePath: string | null
  diffText: string
  branchContext?: string
  /** Composer picks, applied to the fresh session before it dispatches. */
  provider?: AgentId
  modelConfig?: { modelId: string | null; reasoningEffort: ReasoningEffort }
  /** Run the fresh session in an isolated worktree off the source branch. */
  useWorktree?: boolean
  /** Tab whose queued comments and session context are being handed off. */
  sourceTabId?: string
}): Promise<boolean> {
  const { generalComment, filePath, diffText, branchContext } = opts
  const sourceTabId = opts.sourceTabId ?? ctx.activeTabId
  const tab = targetTab(ctx, sourceTabId)
  const inlineComments = tab?.diffComments ?? []
  if (!generalComment && inlineComments.length === 0) return false

  const newTabId = await ctx.createTab()
  const sourceSession = ctx.sessionFor(sourceTabId)
  const newSession = ctx.sessionFor(newTabId)
  if (sourceSession?.run.workingDirectory && newSession) {
    newSession.run.workingDirectory = sourceSession.run.workingDirectory
  }
  if (newSession && opts.provider) newSession.run.provider = opts.provider
  if (newSession && opts.modelConfig) {
    newSession.run.modelConfig.modelId = opts.modelConfig.modelId
    newSession.run.modelConfig.reasoningEffort = opts.modelConfig.reasoningEffort
  }
  if (newSession && opts.useWorktree) {
    newSession.run.worktreeBaseBranch = sourceSession?.run.gitContext?.targetBranch ?? null
  }

  const parts: string[] = []
  if (branchContext) parts.push(`Branch: ${branchContext}`)
  if (filePath) parts.push(`File: ${filePath}`)
  if (diffText) parts.push(`Diff:\n\`\`\`diff\n${diffText}\n\`\`\``)
  if (generalComment) parts.push(`Feedback: ${generalComment}`)
  if (inlineComments.length > 0) {
    parts.push(`Inline comments:\n${formatDiffInlineComments(inlineComments)}`)
  }

  ctx.sendMessage(parts.join('\n\n'), undefined, newTabId)
  if (tab) {
    tab.diffComments.splice(0, tab.diffComments.length)
    tab.diffCommentDraft = null
    tab.diffGeneralComment = ''
  }
  return true
}
