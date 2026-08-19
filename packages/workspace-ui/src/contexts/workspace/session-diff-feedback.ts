import type { AgentId, DiffComment, DiffCommentDraft, ReasoningEffort } from '@solus/contracts/types'
import type { WorkspaceContext } from './workspace.context.svelte'
import { formatDiffInlineComments } from './session.utils'

/** The conversation a diff surface is reviewing. Callers name the tab they are
 *  looking at; the queued feedback belongs to the session behind it. */
function targetSession(ctx: WorkspaceContext, tabId?: string) {
  return ctx.sessionFor(tabId ?? ctx.activeTabId)
}

export function addDiffComment(ctx: WorkspaceContext, comment: DiffComment, tabId?: string): void {
  const session = targetSession(ctx, tabId)
  if (!session) return
  session.diffComments.push(comment)
}

export function updateDiffComment(ctx: WorkspaceContext, commentId: string, newText: string, tabId?: string): void {
  const session = targetSession(ctx, tabId)
  if (!session) return
  const c = session.diffComments.find((dc) => dc.id === commentId)
  if (c) c.comment = newText
}

export function removeDiffComment(ctx: WorkspaceContext, commentId: string, tabId?: string): void {
  const session = targetSession(ctx, tabId)
  if (!session) return
  const idx = session.diffComments.findIndex((dc) => dc.id === commentId)
  if (idx !== -1) session.diffComments.splice(idx, 1)
}

export function restoreDiffComment(ctx: WorkspaceContext, comment: DiffComment, index: number, tabId?: string): void {
  const session = targetSession(ctx, tabId)
  if (!session) return
  if (session.diffComments.some((dc) => dc.id === comment.id)) return
  const clamped = Math.max(0, Math.min(index, session.diffComments.length))
  session.diffComments.splice(clamped, 0, comment)
}

export function clearDiffComments(ctx: WorkspaceContext, tabId?: string): void {
  const session = targetSession(ctx, tabId)
  if (!session) return
  session.diffComments.splice(0, session.diffComments.length)
  session.diffCommentDraft = null
}

export function setDiffCommentDraft(ctx: WorkspaceContext, draft: DiffCommentDraft | null, tabId?: string): void {
  const session = targetSession(ctx, tabId)
  if (!session) return
  session.diffCommentDraft = draft
}

export function updateDiffCommentDraftValue(ctx: WorkspaceContext, value: string, tabId?: string): void {
  const session = targetSession(ctx, tabId)
  if (!session?.diffCommentDraft) return
  session.diffCommentDraft.value = value
}

export function setDiffGeneralComment(ctx: WorkspaceContext, value: string, tabId?: string): void {
  const session = targetSession(ctx, tabId)
  if (!session) return
  session.diffGeneralComment = value
}

export function submitDiffFeedback(ctx: WorkspaceContext, generalComment: string, tabId?: string): boolean {
  const session = targetSession(ctx, tabId)
  if (!session) return false
  const inlineComments = session.diffComments
  if (!generalComment && inlineComments.length === 0) return false

  const parts: string[] = []
  if (generalComment) parts.push(generalComment)
  if (inlineComments.length > 0) {
    parts.push(`Inline comments:\n${formatDiffInlineComments(inlineComments)}`)
  }

  ctx.sendMessage(parts.join('\n\n'), undefined, tabId)
  clearDiffComments(ctx, tabId)
  session.diffGeneralComment = ''
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
  /** The tab the reviewer is looking at; its session's queued comments and run
   *  context are what get handed off. */
  sourceTabId?: string
}): Promise<boolean> {
  const { generalComment, filePath, diffText, branchContext } = opts
  const sourceTabId = opts.sourceTabId ?? ctx.activeTabId
  const session = targetSession(ctx, sourceTabId)
  const inlineComments = session?.diffComments ?? []
  if (!generalComment && inlineComments.length === 0) return false

  const newTabId = await ctx.createTab()
  const newSession = ctx.sessionFor(newTabId)
  if (session?.run.workingDirectory && newSession) {
    newSession.run.workingDirectory = session.run.workingDirectory
  }
  if (newSession && opts.provider) newSession.run.provider = opts.provider
  if (newSession && opts.modelConfig) {
    newSession.run.modelConfig.modelId = opts.modelConfig.modelId
    newSession.run.modelConfig.reasoningEffort = opts.modelConfig.reasoningEffort
  }
  if (newSession && opts.useWorktree) {
    newSession.run.worktree = { baseBranch: session?.run.gitContext?.targetBranch ?? null }
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
  if (session) {
    session.diffComments.splice(0, session.diffComments.length)
    session.diffCommentDraft = null
    session.diffGeneralComment = ''
  }
  return true
}
