import { SolusApiClient, WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import { sessionRecord } from '@solus/contracts/solus-api/records'
import type { SolusServer } from '../server'
import type { HistoryPrewarm } from '../../execution/sessions/history-prewarm'

export function registerSessionDirectoryHandler(server: SolusServer, prewarm: Pick<HistoryPrewarm, 'warm'>): void {
  server.register('sessionDirectoryOpen', async (_args, caller) => {
    const client = new SolusApiClient({
      contextKey: () => caller.clientId,
      send: request => server.handle('solusApiRequest', [request], caller),
    })
    try {
      let revision: string | undefined
      const [page, projects, codebases, pins, attention, automations] = await Promise.all([
        client.request('listSessions', { query: { includeWorktrees: 'true', order: 'activity', limit: 32 }, onEntityTag: tag => { revision = tag } }),
        server.handle('listProjects', [], caller),
        server.handle('codebaseList', [{ includeDeleted: true }], caller).catch(() => null),
        server.handle('pinnedSessionsList', [], caller),
        server.handle('listAttention', [], caller).catch(() => []),
        server.handle('automationList', [], caller).then(rows => rows.map(({ id, name }) => ({ id, name }))).catch(() => []),
      ])
      const records = page.items.map(sessionRecord)
      // The person is about to open one of these: parse their newest pages now, after this answer.
      void prewarm.warm(records.map(row => row.sessionId))
      const listed = new Set(records.map(row => row.sessionId))
      const missing = new Set(pins.map(pin => pin.sessionId).filter(id => !listed.has(id)))
      const pinnedRecords = []
      let cursor: string | undefined
      while (missing.size) {
        const pinned = await client.request('listSessions', { query: { scope: 'pinned', order: 'activity', limit: 200, cursor } })
        for (const item of pinned.items) {
          if (missing.delete(item.id)) pinnedRecords.push(sessionRecord(item))
        }
        if (!pinned.nextCursor) break
        cursor = pinned.nextCursor
      }
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
