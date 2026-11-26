import { z } from 'zod'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import { sessionRecord } from '@solus/contracts/solus-api/records'
import type { SessionShellRow } from '@solus/contracts/session-shell'
import type { SessionRecord } from '@solus/contracts/types'
import { sessionRecordsIndexing } from '../../data/sessions/session-records'
import type { SessionShell, SessionShellReads } from '../events/session-shell'
import type { SolusServer } from '../server'
import { readPinnedOutOfList, readSessionRowFacts, sessionApiClient } from './session-directory-handler'

type RowFacts = Awaited<ReturnType<typeof readSessionRowFacts>>

/** One row as the caller sees it, from the same facts `sessionDirectoryOpen` answers. The shell adds the agent's activity. */
function shellRow(record: SessionRecord, facts: RowFacts): SessionShellRow {
  const starter = record.startedBy
  return {
    record,
    pinnedAt: facts.pins.find(pin => pin.sessionId === record.sessionId)?.pinnedAt ?? null,
    attention: facts.attention.find(entry => entry.sessionId === record.sessionId) ?? null,
    automationName: starter?.kind === 'automation' ? facts.automations.find(automation => automation.id === starter.automationId)?.name ?? null : null,
    agentActivity: null,
  }
}

/**
 * The rows of one caller (docs/plans/mobile-session-shell.md §5.1): the reads
 * of `sessionDirectoryOpen`, through the Solus API client and the handlers
 * with the caller's own context, but every page.
 */
export function sessionShellReads(server: SolusServer): SessionShellReads {
  return {
    async snapshot(caller) {
      const client = sessionApiClient(server, caller)
      const listing = (async () => {
        const records: SessionRecord[] = []
        const seen = new Set<string>()
        let cursor: string | undefined
        let indexing = false
        do {
          const page = await client.request('listSessions', { query: { includeWorktrees: 'true', order: 'activity', limit: 200, cursor } })
          indexing = page.indexing
          for (const item of page.items) {
            // A session whose activity moved while the pages were read comes once; its change is in the log after this cursor.
            if (seen.has(item.id)) continue
            seen.add(item.id)
            records.push(sessionRecord(item))
          }
          cursor = page.nextCursor ?? undefined
        } while (cursor)
        return { records, seen, indexing }
      })()
      const [listed, projects, codebases, facts] = await Promise.all([
        listing,
        server.handle('listProjects', [], caller),
        server.handle('codebaseList', [{ includeDeleted: true }], caller).catch(() => null),
        readSessionRowFacts(server, caller),
      ])
      const pinnedRecords = await readPinnedOutOfList(client, facts.pins.map(pin => pin.sessionId), listed.seen)
      return {
        rows: [...listed.records, ...pinnedRecords].map(record => shellRow(record, facts)),
        projects, codebases, indexing: listed.indexing,
      }
    },

    async sessions(caller, sessionIds) {
      const client = sessionApiClient(server, caller)
      const facts = await readSessionRowFacts(server, caller)
      const pinned = new Set(facts.pins.map(pin => pin.sessionId))
      const rows = new Map<string, SessionShellRow>()
      await Promise.all(sessionIds.map(async (sessionId) => {
        let record: SessionRecord
        try {
          record = sessionRecord(await client.request('getSession', { id: sessionId }))
        } catch (error) {
          // The caller cannot read it, or it is gone.
          if (error instanceof WorkspaceRequestError && (error.status === 403 || error.status === 404)) return
          throw error
        }
        // The snapshot's rule: a top-level session in the caller's list, or one they pinned.
        if (record.parentSessionId === null && (record.listed !== false || pinned.has(sessionId))) rows.set(sessionId, shellRow(record, facts))
      }))
      return rows
    },

    projects: caller => server.handle('listProjects', [], caller),
    codebases: caller => server.handle('codebaseList', [{ includeDeleted: true }], caller).catch(() => null),
    indexing: sessionRecordsIndexing,
  }
}

/** A cursor as the wire gave it. Anything else is no cursor, and the caller gets a snapshot. */
const cursorSchema = z.object({ epoch: z.string(), scopeKey: z.string(), sequence: z.number().int().min(0) })

export function registerSessionShellHandler(server: SolusServer, shell: Pick<SessionShell, 'open'>): void {
  server.register('sessionShellOpen', ([request], caller) => {
    const after = cursorSchema.safeParse(request?.after)
    return shell.open(caller, after.success ? after.data : undefined)
  })
}
