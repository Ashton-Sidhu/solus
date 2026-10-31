import type { Session, SessionReference } from '@solus/contracts/types'
import type { ListedSession } from '../../../contexts/workspace/session-list.store.svelte'
import { checkoutPlace } from '../../../contexts/workspace/run-location'
import { sessionTitle } from '../../../lib/sessionUtils'

/** What a sidebar reads to name a session in a prompt. */
export interface SessionReferenceSources {
  sessionFor(tabId: string): Session | null | undefined
  serverIdFor(tabId: string): string
  listed(sessionId: string): ListedSession | null | undefined
}

/**
 * An open session as a prompt names it: the same reference the composer's
 * session picker inserts. Null before the first turn, when its host has no
 * record that read_session can find.
 */
export function referenceForTab(sources: SessionReferenceSources, tabId: string): SessionReference | null {
  const session = sources.sessionFor(tabId)
  if (!session?.agentSessionId || !session.run.provider) return null
  return {
    sessionId: session.id,
    provider: session.run.provider,
    title: sessionTitle(session),
    cwd: checkoutPlace(session.run)?.path ?? '',
    serverId: sources.serverIdFor(tabId),
  }
}

/** A session in its host's list with no conversation open on this client. */
export function referenceForListed(sources: SessionReferenceSources, sessionId: string): SessionReference | null {
  const listed = sources.listed(sessionId)
  if (!listed) return null
  return {
    sessionId: listed.sessionId,
    provider: listed.opensWith.provider,
    title: listed.title ?? 'Session',
    cwd: listed.opensWith.cwd ?? '',
    serverId: listed.serverId,
  }
}

/** A sidebar row or a session listed under one: its open tab, else its record. */
export function referenceForRow(
  sources: SessionReferenceSources,
  row: { tabId?: string | null; sessionId?: string | null },
): SessionReference | null {
  if (row.tabId) return referenceForTab(sources, row.tabId)
  return row.sessionId ? referenceForListed(sources, row.sessionId) : null
}

/** A sidebar row, or a session listed under one, as a drag reads it. */
export interface ReferencedRow {
  tabIds: readonly string[]
  sessionId?: string
}

/** What a drag of sidebar rows carries: one reference per row that has a
 *  session on its host. A row whose session has not started is left out. */
export function referencesForRows(
  sources: SessionReferenceSources,
  rows: readonly ReferencedRow[],
): SessionReference[] {
  return rows.flatMap((row) => referenceForRow(sources, { tabId: row.tabIds[0], sessionId: row.sessionId }) ?? [])
}
