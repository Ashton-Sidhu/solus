import type { SessionHistoryPage, SessionHistoryPageRequest } from '@solus/contracts/session-history'
import type { SessionTurnDiff } from '@solus/contracts/session-repositories'
import type { HostApi } from './host-api'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import type { SessionCloudHead, SessionHostTurn } from './session-heads'

/**
 * Read-only open of a session with no host that holds it online
 * (docs/plans/portable-sessions-cloud.md §6, Phase 5B). The Solus API reads the
 * rows and the turn diffs from the session repository at its recorded head.
 * Desktop, web, and mobile use these rules; each client draws them its own way.
 */

/** Where a started session's conversation comes from when no host shows it. */
export type SessionCloudReadSource =
  /** Read the rows from the Solus API. */
  | 'cloud'
  /** The run host is offline and no Solus API connection exists. */
  | 'not-signed-in'
  /** The cloud list answered, and it has no copy of the session. */
  | 'sync-off'
  /** The cloud list has no session, but the run host's sync setting is not known to be off. */
  | 'not-in-cloud'
  /** The cloud knows the session, but no turn commit is in it yet. */
  | 'empty'
  /** The cloud list has not answered yet. */
  | 'listing'

export interface SessionCloudReadSourceInput {
  hasStarted: boolean
  /** The tab shows rows a host gave, or a host reads them now. */
  hasHostRows: boolean
  isSignedIn: boolean
  /** A Solus API connection answered `listMySessions` (or failed to). */
  isCloudListed: boolean
  runServerId: string
  isRunHostAway: boolean
  /** A connected host failed to read its history or has no local copy. */
  isHostReadUnavailable?: boolean
  /** False only when the run host's setting is known to be off. */
  isCloudSyncOn?: boolean | null
  /** What the run host holds of the session, as this client read it. */
  runTurn: SessionHostTurn | undefined
  /** What the cloud knows; null when it has no facts here. */
  cloud: SessionCloudHead | null | undefined
}

/**
 * Whether the conversation comes from the cloud, and if not, why it cannot.
 * Null: a host that holds the session shows it. An online run host is taken
 * to hold the session unless the cloud has turns, the run host has none, and
 * it did not run the last one (the rule of `conversationAwaitsMachine`).
 */
export function sessionCloudReadSource(input: SessionCloudReadSourceInput): SessionCloudReadSource | null {
  if (!input.hasStarted || input.hasHostRows) return null
  const { cloud, runTurn } = input
  const hasCloudTurns = !!cloud?.head && cloud.syncedTurn > 0
  if (!input.isRunHostAway && !input.isHostReadUnavailable) {
    if (!hasCloudTurns || cloud.lastRunServerId === input.runServerId) return null
    return runTurn && runTurn.syncedTurn > 0 ? null : 'cloud'
  }
  if (!input.isSignedIn) return 'not-signed-in'
  if (!cloud) return !input.isCloudListed ? 'listing' : input.isCloudSyncOn === false || input.isCloudSyncOn === undefined ? 'sync-off' : 'not-in-cloud'
  return hasCloudTurns ? 'cloud' : 'empty'
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
  /** The cloud head when the newest page was read. */
  readHead: string | null
  /** Turns whose rows the repository does not have (an old or omitted row file). */
  unavailableTurnCount: number
}

/** The one state a read-only conversation shows. */
export type SessionCloudReadView =
  | { kind: 'not-signed-in' }
  | { kind: 'sync-off' }
  | { kind: 'not-in-cloud' }
  | { kind: 'empty'; reason: 'no-turns' | 'no-rows' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; unavailableTurnCount: number }
  /** `host-online`: a host that holds the session is online; its conversation
   *  replaces the copy. `head-changed`: a newer turn is in the cloud. */
  | { kind: 'stale'; reason: 'host-online' | 'head-changed' }

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
  cloud: SessionCloudHead | null | undefined
}

// The order keeps host rows, sign-in, read errors, and stale heads distinct.
// eslint-disable-next-line complexity
export function sessionCloudReadView(input: SessionCloudReadViewInput): SessionCloudReadView | null {
  const { source, read } = input
  if (source === null) {
    // A live turn appended to the copy: the run host holds the session, and the
    // older turns on screen are the same turns. Nothing to say.
    return read && input.messageCount > 0 && !input.isTurnLive ? { kind: 'stale', reason: 'host-online' } : null
  }
  if (source === 'not-signed-in' || source === 'sync-off' || source === 'not-in-cloud') return { kind: source }
  if (source === 'empty') return { kind: 'empty', reason: 'no-turns' }
  if (source === 'listing' || !read || read.status === 'loading') return { kind: 'loading' }
  if (read.status === 'error') return { kind: 'error', message: read.error ?? 'The conversation could not be read from Solus Cloud.' }
  if (input.messageCount === 0) return { kind: 'empty', reason: read.unavailableTurnCount > 0 ? 'no-rows' : 'no-turns' }
  if (input.liveServerId && !input.isTurnLive) return { kind: 'stale', reason: 'host-online' }
  if (!input.isTurnLive && read.readHead && input.cloud?.head && input.cloud.head !== read.readHead) return { kind: 'stale', reason: 'head-changed' }
  return { kind: 'ready', unavailableTurnCount: read.unavailableTurnCount }
}

/** One page of the cloud read: one whole turn, newest first. */
export interface SessionCloudPage extends SessionHistoryPage {
  /** When the page's turn started: its first user row, for the turn's diff. */
  turnStartedAt: number | null
}

/** Read one page of a session's cloud read from a Solus API connection. The
 *  API answers one turn for each call (Phase 5A), whatever `turnLimit` says. */
export async function readSessionCloudPage(
  api: Pick<HostApi, 'loadSessionPage'>,
  request: Pick<SessionHistoryPageRequest, 'sessionId' | 'provider' | 'before'>,
): Promise<SessionCloudPage> {
  const page = await api.loadSessionPage({ ...request, turnLimit: 1, deferArtifactHtml: true })
  const lead = page.messages.find((message) => message.role === 'user' && !message.parentToolUseId)
  return { ...page, turnStartedAt: lead?.timestamp ?? null }
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
