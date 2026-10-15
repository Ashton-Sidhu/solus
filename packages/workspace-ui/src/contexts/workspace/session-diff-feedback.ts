import type { AgentId, GitCheckout, ReasoningEffort, Session } from '@solus/contracts/types'
import type { WorkspaceContext } from './workspace.context.svelte'
import { formatDiffInlineComments } from './session.utils'
import { checkoutGit, checkoutPlace, folderLocation, projectHome, runHost } from './run-location'

/** The conversation a diff surface is reviewing. Callers name the tab they are
 *  looking at; the queued feedback belongs to the session behind it. */
function targetSession(ctx: WorkspaceContext, tabId?: string) {
  return ctx.sessionFor(tabId ?? ctx.activeTabId)
}

function clearDiffComments(session: Session): void {
  session.diffComments.splice(0, session.diffComments.length)
  session.diffCommentDraft = null
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

  ctx.dispatch.sendMessage(parts.join('\n\n'), undefined, tabId)
  clearDiffComments(session)
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
  modelConfig?: { modelId: string | null; reasoningEffort: ReasoningEffort; fastMode: boolean }
  /** Run the fresh session in an isolated worktree off the source branch. */
  useWorktree?: boolean
  /** Override the source conversation's checkout for a detached review, such
   *  as a pull request prepared on another host or in another repository. */
  sessionTarget?: {
    workingDirectory: string
    gitContext: GitCheckout | null
    serverId?: string
  }
  /** The tab the reviewer is looking at; its session's queued comments and run
   *  context are what get handed off. */
  sourceTabId?: string
}): Promise<boolean> {
  const { generalComment, filePath, diffText, branchContext } = opts
  const sourceTabId = opts.sourceTabId ?? ctx.activeTabId
  const session = targetSession(ctx, sourceTabId)
  const inlineComments = session?.diffComments ?? []
  if (!generalComment && inlineComments.length === 0) return false

  const workingDirectory = opts.sessionTarget?.workingDirectory ?? checkoutPlace(session?.run)?.path
  const gitContext = opts.sessionTarget
    ? opts.sessionTarget.gitContext
    : checkoutGit(session?.run) ?? null
  const serverId = opts.sessionTarget?.serverId ?? runHost(session?.run)
  const newTabId = await ctx.createTab(workingDirectory, {
    gitContext,
    serverId,
    sourceId: sourceTabId,
  })
  const newSession = ctx.sessionFor(newTabId)
  if (newSession) {
    newSession.run.location = folderLocation(
      { serverId: runHost(newSession.run), path: workingDirectory ?? checkoutPlace(newSession.run).path },
      {
        git: gitContext ? { ...gitContext } : null,
        // Feedback on a dispatched session keeps its project, and its tasks, home.
        project: session && !opts.sessionTarget ? projectHome(session.run) : undefined,
        newWorktree: opts.useWorktree ? { baseBranch: checkoutGit(session?.run)?.targetBranch ?? null } : null,
      },
    )
  }
  if (newSession) newSession.task = { kind: 'none' }
  if (newSession && opts.provider) newSession.run.provider = opts.provider
  if (newSession && opts.modelConfig) {
    newSession.run.modelConfig.modelId = opts.modelConfig.modelId
    newSession.run.modelConfig.reasoningEffort = opts.modelConfig.reasoningEffort
    newSession.run.modelConfig.fastMode = opts.modelConfig.fastMode
  }

  const parts: string[] = []
  if (branchContext) parts.push(`Branch: ${branchContext}`)
  if (filePath) parts.push(`File: ${filePath}`)
  if (diffText) parts.push(`Diff:\n\`\`\`diff\n${diffText}\n\`\`\``)
  if (generalComment) parts.push(`Feedback: ${generalComment}`)
  if (inlineComments.length > 0) {
    parts.push(`Inline comments:\n${formatDiffInlineComments(inlineComments)}`)
  }

  ctx.dispatch.sendMessage(parts.join('\n\n'), undefined, newTabId)
  if (session) {
    session.diffComments.splice(0, session.diffComments.length)
    session.diffCommentDraft = null
    session.diffGeneralComment = ''
  }
  return true
}
