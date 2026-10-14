import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

// bun has no node:sqlite; the indexer's import chain reaches it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// A client lists the sessions with the newest activity. With pages in activity
// order it reads only the first pages; in creation order it must read every page,
// because an old session that is active again can be on the last one.

let dataDir: string
let closeDb: () => void

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-activity-order-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ closeDb } = await import('@solus/server/db'))
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

test('activity order pages sessions by last activity and continues from its cursor', async () => {
  const { SessionApiOperations } = await import('@solus/server/data/sessions/api-operations')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  const { upsertOwnSessionRecord } = await import('@solus/server/data/sessions/session-records')

  // `old-but-active` started first and was used last.
  const sessions = [
    { sessionId: 'old-but-active', createdAt: 1_000, lastActivityAt: 9_000 },
    { sessionId: 'middle', createdAt: 2_000, lastActivityAt: 3_000 },
    { sessionId: 'newest-created', createdAt: 5_000, lastActivityAt: 6_000 },
    { sessionId: 'quiet', createdAt: 4_000, lastActivityAt: 4_500 },
  ]
  for (const session of sessions) await upsertOwnSessionRecord({ ...session, provider: 'codex', projectPath: '-p' })

  const operations = new SessionApiOperations(new ShareManager({ db: getDatabase() }))
  const context = {
    principal: { kind: 'local-owner' as const, deviceId: null, deviceLabel: 'Mac' },
    home: { kind: 'local' as const, hostId: 'this-mac' },
    scopes: ['sessions:read' as const],
  }

  const first = await operations.list(context, { limit: 2, order: 'activity' })
  expect(first.items.map((item) => item.id)).toEqual(['old-but-active', 'newest-created'])
  const second = await operations.list(context, { limit: 2, order: 'activity', cursor: first.nextCursor ?? undefined })
  expect(second.items.map((item) => item.id)).toEqual(['quiet', 'middle'])
  expect(second.nextCursor).toBeNull()

  // The default stays creation order, for callers that page by when a session started.
  const created = await operations.list(context, { limit: 2 })
  expect(created.items.map((item) => item.id)).toEqual(['newest-created', 'quiet'])
})
