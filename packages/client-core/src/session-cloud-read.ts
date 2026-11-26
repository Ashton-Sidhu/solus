import type { SessionHistoryPage, SessionHistoryPageRequest } from '@solus/contracts/session-history'
import type { SessionTurnDiff } from '@solus/contracts/session-repositories'
import type { HostApi } from './host-api'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import { rpcErrorCode } from './rpc-error'
import type { SessionCloudHead, SessionHostTurn } from './session-heads'
import { INITIAL_HISTORY_TURNS } from './session-history-page'

/**
 * Read-only open of a session with no host that holds it online
 * (docs/plans/portable-sessions-cloud.md, "The mirror for readers"). The Solus
 * API answers the rows and the turn diffs from the transcript mirror: the
 * rows of a published organization session, and of a personal session whose
 * owner has cloud sync on. Desktop, web, and mobile use these rules; each
 * client draws them its own way.
 *
 * The rule of the source does not change: read the host when a host that
 * holds the session can be reached, else the Solus API. What the copy holds is
 * the mirror's answer, not a fact of the session repository: a client asks,
 * and a page with no rows is "no copy".
 */

/** Where a started session's conversation comes from when no host shows it. */
export type SessionCloudReadSource =
  /** Read the rows from the Solus API. */
  | 'cloud'
  /** No host shows the session, and this client has no Solus API connection. */
  | 'not-signed-in'

export interface SessionCloudReadSourceInput {
  hasStarted: boolean
  /** The tab shows rows a host gave, or a host reads them now. */
  hasHostRows: boolean
  /** This client has a Solus API connection to ask. */
  isSignedIn: boolean
  runServerId: string
  isRunHostAway: boolean
  /** A connected host failed to read its history or has no local copy. */
  isHostReadUnavailable?: boolean
  /** What the run host holds of the session, as this client read it. */
  runTurn: SessionHostTurn | undefined
  /** Where the session last ran, from the index that a host continues from;
   *  null when this client has no such facts. It decides only whether an
   *  online run host holds the session. */
  cloud: SessionCloudHead | null | undefined
}

/**
 * Whether the conversation comes from the Solus API, and if not, why it
 * cannot. Null: a host that holds the session shows it. An online run host is
 * taken to hold the session unless another host ran its last turn and the run
 * host has no turn of it (the rule of `conversationAwaitsMachine`).
 */
export function sessionCloudReadSource(input: SessionCloudReadSourceInput): SessionCloudReadSource | null {
  if (!input.hasStarted || input.hasHostRows) return null
  if (!input.isRunHostAway && !input.isHostReadUnavailable) {
    const { cloud, runTurn } = input
    if (!cloud?.head || cloud.syncedTurn <= 0 || cloud.lastRunServerId === input.runServerId) return null
    return runTurn && runTurn.syncedTurn > 0 ? null : 'cloud'
  }
  return input.isSignedIn ? 'cloud' : 'not-signed-in'
}

/** How far the client read the cloud read of one session. */
export type SessionCloudReadStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

export interface SessionCloudReadProgress {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  /** The mirror got rows after this client read the copy (`session.transcriptChanged`). */
  hasNewerRows: boolean
}

/** The one state a read-only conversation shows. */
export type SessionCloudReadView =
  | { kind: 'not-signed-in' }
  /** The mirror has no row of the session, and the run host's cloud sync is known to be off. */
  | { kind: 'sync-off' }
  /** The mirror has no row of the session. */
  | { kind: 'not-in-cloud' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }
  /** `host-online`: a host that holds the session is online; its conversation
   *  replaces the copy. `newer-rows`: the mirror has rows that the copy does not show. */
  | { kind: 'stale'; reason: 'host-online' | 'newer-rows' }

export interface SessionCloudReadViewInput {
  /** The answer of `sessionCloudReadSource`, read with `hasHostRows` false
   *  while the cloud read is on screen. */
  source: SessionCloudReadSource | null
  /** The cloud read this client read; null when none. */
  read: SessionCloudReadProgress | null
  /** The rows on screen. */
  messageCount: number
  /** A turn runs on screen now: the run host holds the session. */
  isTurnLive: boolean
  /** Another connected host holds the session while these rows still show. */
  liveServerId?: string | null
  /** False only when the run host's setting is known to be off. */
  isCloudSyncOn?: boolean | null
}

export function sessionCloudReadView(input: SessionCloudReadViewInput): SessionCloudReadView | null {
  const { source, read } = input
  if (source === null) {
    // A live turn appended to the copy: the run host holds the session, and the
    // older turns on screen are the same turns. Nothing to say.
    return read && input.messageCount > 0 && !input.isTurnLive ? { kind: 'stale', reason: 'host-online' } : null
  }
  if (source === 'not-signed-in') return { kind: 'not-signed-in' }
  if (!read || read.status === 'loading') return { kind: 'loading' }
  if (read.status === 'error') return { kind: 'error', message: read.error ?? 'The conversation could not be read from Solus Cloud.' }
  if (input.liveServerId && input.messageCount > 0 && !input.isTurnLive) return { kind: 'stale', reason: 'host-online' }
  if (read.hasNewerRows && !input.isTurnLive) return { kind: 'stale', reason: 'newer-rows' }
  if (input.messageCount === 0) return { kind: input.isCloudSyncOn === false ? 'sync-off' : 'not-in-cloud' }
  return { kind: 'ready' }
}

/**
 * Read one page of a session's copy from a Solus API connection: the newest
 * turns, or the turns before a cursor. The Solus API refuses a session that is
 * not in the mirror for this person; that is a copy with no rows, not a failed
 * read.
 */
export async function readSessionCloudPage(
  api: Pick<HostApi, 'loadSessionPage'>,
  request: Pick<SessionHistoryPageRequest, 'sessionId' | 'provider' | 'before' | 'throughEntryId' | 'replyLayout' | 'promptFiles' | 'turnItems'>,
): Promise<SessionHistoryPage> {
  try {
    return await api.loadSessionPage({ ...request, turnLimit: INITIAL_HISTORY_TURNS, deferArtifactHtml: true })
  } catch (error) {
    if (error instanceof Error && rpcErrorCode(error) === 'FORBIDDEN') return { messages: [], before: null }
    throw error
  }
}

/** A turn diff as a client shows it. */
export type SessionTurnDiffView =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'no-change' }
  | SessionTurnDiff

/** An older Solus API has no diff route. Keep that absence as a diff state. */
export async function readSessionTurnDiff(api: Pick<HostApi, 'sessionTurnDiff'>, sessionId: string, turnIndex: number): Promise<SessionTurnDiff> {
  try { return await api.sessionTurnDiff(sessionId, turnIndex) }
  catch (error) {
    if (error instanceof WorkspaceRequestError && error.status === 404) return { status: 'not-available' }
    throw error
  }
}
