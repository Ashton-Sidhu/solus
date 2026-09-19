import { readPrefetchedSessionHistoryPage, RESTORED_TRANSCRIPT_LIMIT } from '@solus/client-core/session-history-page'
import { materializeSessionTranscript } from './session-transcript'
import { markStartupTranscriptApplied } from './startup-transcript'
import type { PersistedTabs } from './tab-persistence'
import type { WorkspaceContext } from './workspace.context.svelte'

/** Seed the selected conversation during component setup, before its first
 * render. No metadata requests, live watch, or secondary store loads belong here. */
export function materializeStartupTranscript(ctx: WorkspaceContext, snapshot: PersistedTabs): void {
  const tabId = ctx.activeTabId
  const saved = snapshot.tabs.find((tab) => tab.tabId === tabId)
  const session = ctx.sessionFor(tabId)
  if (!saved?.agentSessionId || !saved.provider || saved.pendingFork || !session) return
  const displayCwd = session.run.workingDirectory
  const loadPath = saved.gitContext?.worktreePath || displayCwd
  const page = readPrefetchedSessionHistoryPage(ctx.apiFor(tabId), {
    sessionId: saved.agentSessionId,
    projectPath: loadPath,
    provider: saved.provider,
    limit: RESTORED_TRANSCRIPT_LIMIT,
    deferToolInputs: ctx.deferHistoryToolInputs,
  })
  if (!page) return
  const transcript = materializeSessionTranscript(ctx, {
    sessionId: saved.agentSessionId,
    loadPath,
    displayCwd,
    provider: saved.provider,
    ctx: ctx.ctxFor(tabId),
    limit: RESTORED_TRANSCRIPT_LIMIT,
  }, page)
  session.messages.splice(0, session.messages.length, ...transcript.messages)
  session.historyTruncated = transcript.truncated
  session.historyCursor = transcript.before
  session.historyPendingMessages = transcript.pendingMessages
  session.progress = transcript.progress
  ctx.eventReducer.rebuildAgentConversations(session)
  ctx.recomputeChangedFiles(tabId)
  session.loadingHistory = false
  if (session.messages.length) markStartupTranscriptApplied(tabId)
}
