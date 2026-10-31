import type { SessionReference } from '@solus/contracts/types'
import { SearchQuery } from '@solus/contracts/search-query'
import { sessionNameScore } from '@solus/contracts/session-search'
import { sessionReferenceMarkdown } from '@solus/contracts/session-link'
import type { SolusThreadShell } from './thread-directory'

/** The name a session row and its reference show. */
export function sessionReferenceTitle(thread: SolusThreadShell): string {
  const { record } = thread
  return record.customTitle || record.title || record.slug || 'Unnamed session'
}

/** The reference desktop's input bar writes for the same session, so the agent reads it with read_session. */
export function sessionReferenceOf(thread: SolusThreadShell): SessionReference {
  const { record } = thread
  return { sessionId: record.sessionId, provider: record.provider, title: sessionReferenceTitle(thread), cwd: record.cwd ?? '', serverId: thread.hostId }
}

/** This host's sessions the composer can reference, best name match first.
 *  An agent cannot reference its own conversation. */
export function sessionReferenceCandidates(input: {
  threads: readonly SolusThreadShell[]
  hostId: string
  currentSessionId: string
  query: string
}): SolusThreadShell[] {
  const seen = new Set<string>()
  const own = input.threads.filter(thread => {
    if (thread.hostId !== input.hostId || thread.record.sessionId === input.currentSessionId || seen.has(thread.key)) return false
    seen.add(thread.key)
    return true
  })
  const search = new SearchQuery(input.query)
  if (search.isEmpty) return own
  return own.flatMap(thread => {
    const match = sessionNameScore({ id: thread.record.sessionId, title: sessionReferenceTitle(thread), branch: thread.record.branch }, search)
    return match ? [{ thread, score: match.score }] : []
  }).sort((a, b) => b.score - a.score).map(hit => hit.thread)
}

/** The draft after an insertion, and the caret after the inserted text. */
export interface DraftInsertion {
  text: string
  caret: number
}

/** The draft with the reference token and one space at the caret, and the caret after them.
 *  An unknown caret puts the token at the end. */
export function insertSessionReference(
  text: string,
  caret: { start: number; end: number } | null,
  reference: SessionReference,
): DraftInsertion {
  const start = Math.min(caret?.start ?? text.length, text.length)
  const end = Math.min(Math.max(caret?.end ?? start, start), text.length)
  const before = text.slice(0, start)
  const separator = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const inserted = `${separator}${sessionReferenceMarkdown(reference)} `
  return { text: before + inserted + text.slice(end), caret: start + inserted.length }
}
