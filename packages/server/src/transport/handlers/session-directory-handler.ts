import { SolusApiClient, WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import { sessionRecord } from '@solus/contracts/solus-api/records'
import type { SessionRecord } from '@solus/contracts/types'
import type { CallerCtx, SolusServer } from '../server'
import type { HistoryPrewarm } from '../../execution/sessions/history-prewarm'

/** The Solus API as this caller reads it: their records, their view, their scope. */
export function sessionApiClient(server: SolusServer, caller: CallerCtx): SolusApiClient {
  return new SolusApiClient({
    contextKey: () => caller.clientId,
    send: request => server.handle('solusApiRequest', [request], caller),
  })
}

/** The facts beside a record that the caller's list shows: their pins, what waits for them, and the automation names. */
export async function readSessionRowFacts(server: SolusServer, caller: CallerCtx) {
  const [pins, attention, automations] = await Promise.all([
    server.handle('pinnedSessionsList', [], caller),
    server.handle('listAttention', [], caller).catch(() => []),
    server.handle('automationList', [], caller).then(rows => rows.map(({ id, name }) => ({ id, name }))).catch(() => []),
  ])
  return { pins, attention, automations }
}

/** The caller's pinned sessions that are not in `listed`, in the order of the pinned scope. */
export async function readPinnedOutOfList(client: SolusApiClient, pinnedIds: readonly string[], listed: ReadonlySet<string>): Promise<SessionRecord[]> {
  const missing = new Set(pinnedIds.filter(id => !listed.has(id)))
  const pinnedRecords: SessionRecord[] = []
  let cursor: string | undefined
  while (missing.size) {
    const pinned = await client.request('listSessions', { query: { scope: 'pinned', order: 'activity', limit: 200, cursor } })
    for (const item of pinned.items) {
      if (missing.delete(item.id)) pinnedRecords.push(sessionRecord(item))
    }
    if (!pinned.nextCursor) break
    cursor = pinned.nextCursor
  }
  return pinnedRecords
}

export function registerSessionDirectoryHandler(server: SolusServer, prewarm: Pick<HistoryPrewarm, 'warm'>): void {
  server.register('sessionDirectoryOpen', async (_args, caller) => {
    const client = sessionApiClient(server, caller)
    try {
      let revision: string | undefined
      const [page, projects, codebases, { pins, attention, automations }] = await Promise.all([
        client.request('listSessions', { query: { includeWorktrees: 'true', order: 'activity', limit: 32 }, onEntityTag: tag => { revision = tag } }),
        server.handle('listProjects', [], caller),
        server.handle('codebaseList', [{ includeDeleted: true }], caller).catch(() => null),
        readSessionRowFacts(server, caller),
      ])
      const records = page.items.map(sessionRecord)
      // The person is about to open one of these: parse their newest pages now, after this answer.
      void prewarm.warm(records.map(row => row.sessionId))
      const pinnedRecords = await readPinnedOutOfList(client, pins.map(pin => pin.sessionId), new Set(records.map(row => row.sessionId)))
      return {
        records, pinnedRecords, nextCursor: page.nextCursor, indexing: page.indexing,
        revision: page.nextCursor === null ? revision : undefined,
        projects, codebases, pins, attention, automations,
      }
    } catch (error) {
      if (!(error instanceof WorkspaceRequestError)) throw error
      const { status, code, message, retryAfter } = error
      return { error: { status, code, message, retryAfter } }
    }
  })
}
