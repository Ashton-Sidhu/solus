import { loadSessionHistoryPage } from '@solus/client-core/session-history-page'
import type { SessionHistoryPageRequest } from '@solus/contracts/session-history'
import type { Session, WatchSessionResult } from '@solus/contracts/types'
import { loadSessionTranscript, type SessionTranscriptLoadArgs } from './session-transcript'
import type { SurfaceContext } from '../app/surface-context.svelte'
import type { WorkspaceContext } from './workspace.context.svelte'

/** What a fit reads and changes in the workspace. */
type FitWorkspace = SurfaceContext & Pick<WorkspaceContext, 'eventReducer' | 'apiFor' | 'sessionFor' | 'applyRuntimeAttach' | 'applyPendingQuestions'>

/** What an open read: the turn its page left out, and the turn its watch replayed. */
export interface OpenedTurns {
  pageTurn: number | undefined
  watchedTurn: number | undefined
}

/**
 * The history page and the watch of an open fit when they name the same
 * running turn: the page left out the turn that the watch replays
 * (docs/plans/running-turn-open.md). When a turn starts or ends between the two
 * reads they do not, and one opening read gives both at one moment: the host
 * watches first and reads the page after. The events the first watch replayed
 * are dropped; the second watch replays them again.
 */
export async function fitTranscriptToWatch(
  workspace: FitWorkspace, tabId: string, session: Session | null, turns: OpenedTurns,
  request: SessionHistoryPageRequest, transcriptArgs: Omit<SessionTranscriptLoadArgs, 'history'>,
): Promise<void> {
  // A tab that a newer open took over has nothing to fit.
  if (!session || turns.pageTurn === turns.watchedTurn) return
  workspace.eventReducer.dropHeldEvents(session.id)
  let watched: WatchSessionResult | undefined
  const api = workspace.apiFor(tabId)
  const history = loadSessionHistoryPage(api, { ...request, openSession: true }, undefined, 0, {
    onOpened: (opened) => { watched = opened.resumedWatch },
  })
  const transcript = await loadSessionTranscript(workspace, { ...transcriptArgs, history })
  if (workspace.sessionFor(tabId) !== session) return
  session.messages.splice(0, session.messages.length, ...transcript.messages)
  workspace.eventReducer.rebuildAgentConversations(session)
  session.progress = transcript.progress
  session.historyTruncated = transcript.truncated
  session.historyCursor = transcript.before
  session.historyPendingMessages = transcript.pendingMessages
  if (!watched) return
  workspace.applyRuntimeAttach(tabId, watched.runtime)
  workspace.applyPendingQuestions(tabId, watched.pendingQuestions)
}
