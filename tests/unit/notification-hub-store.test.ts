import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import type { HubNotification } from '@solus/contracts/notification-hub'
import type { Attribution } from '@solus/contracts/user'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/015-notifications-hub.md v2, stage 1: one table at each record home. A
// row commits with the change that caused it; an event is one row per recipient
// however often it is replayed; each recipient's read and archive facts are their
// own and independent; pages and counts are cut after access checks; a cursor is
// bound to its reader; and a committed change is announced to its recipient only.

let store: typeof import('@solus/server/data/notifications/store')
let database: typeof import('@solus/server/db/database')
let legacy: typeof import('@solus/server/db')
let principal: typeof import('@solus/server/admission/principal')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-notification-store-'))
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/notifications/store')
  database = await import('@solus/server/db/database')
  legacy = await import('@solus/server/db')
  principal = await import('@solus/server/admission/principal')
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

beforeEach(async () => {
  await database.getDatabase().run(sql`DELETE FROM notifications`)
})

const alice: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice' } }
const work = { kind: 'work' as const, workId: 'w1', revisionId: 3 }

function reviewRequest(eventId: string, recipients: string[], createdAt = 1_000) {
  return {
    organizationId: 'org1', eventId, recipients, createdAt,
    facts: { kind: 'work.review_requested' as const }, resource: work, by: alice,
    summary: { title: 'Review “Spec”' },
  }
}

const reader = (recipientKey: string, scope: import('@solus/server/admission/principal').RecordScope = 'org1') => ({ scope, recipientKey })

async function record(input: ReturnType<typeof reviewRequest>) {
  return database.getDatabase().transaction((tx) => store.recordNotification(tx, input))
}

describe('recording', () => {
  test('a row rolls back with the change that caused it, and nobody hears of it', async () => {
    const heard: string[] = []
    const stop = store.onNotificationsChanged((change) => heard.push(change.recipientKey))
    await expect(database.getDatabase().transaction(async (tx) => {
      await store.recordNotification(tx, reviewRequest('req-1', ['bob']))
      throw new Error('the grant failed')
    })).rejects.toThrow('the grant failed')
    expect((await store.listNotifications(reader('bob'), {})).items).toEqual([])
    expect(heard).toEqual([])
    // A committed row is announced to its recipient, after the commit.
    await record(reviewRequest('req-2', ['carol']))
    expect(heard).toEqual(['carol'])
    stop()
  })

  test('an event is one row per recipient, however often it is replayed or a recipient is repeated', async () => {
    expect(await record(reviewRequest('req-1', ['bob', 'bob', 'carol']))).toHaveLength(2)
    expect(await record(reviewRequest('req-1', ['bob', 'carol']))).toHaveLength(0)
    expect((await store.listNotifications(reader('bob'), {})).items).toHaveLength(1)
    expect((await store.listNotifications(reader('carol'), {})).items).toHaveLength(1)
    // A deliberate new request is a new occurrence.
    expect(await record(reviewRequest('req-2', ['bob'], 2_000))).toHaveLength(1)
    expect((await store.listNotifications(reader('bob'), {})).items.map((item) => item.eventId)).toEqual(['req-2', 'req-1'])
  })

  test('a person\'s own request does not alert them', async () => {
    expect(await record(reviewRequest('req-1', ['alice', 'bob']))).toHaveLength(1)
    expect((await store.listNotifications(reader('alice'), {})).items).toEqual([])
  })

  test('an event of one organization is invisible to a reader of another', async () => {
    await record(reviewRequest('req-1', ['bob']))
    expect((await store.listNotifications(reader('bob', 'org2'), {})).items).toEqual([])
    expect((await store.listNotifications(reader('bob', principal.ANY_ORGANIZATION), {})).items).toHaveLength(1)
  })

  // The synchronous path exists only where the hub's table shares the host's SQLite file.
  test.skipIf(Boolean(process.env.DATABASE_URL))('the synchronous write commits and rolls back with a legacy transaction, and shares the same rules', async () => {
    expect(() => legacy.withTx(() => {
      store.recordNotificationSync(legacy.getDb(), reviewRequest('sync-1', ['bob']))
      throw new Error('the run write failed')
    })).toThrow('the run write failed')
    expect((await store.listNotifications(reader('bob'), {})).items).toEqual([])
    expect(legacy.withTx(() => store.recordNotificationSync(legacy.getDb(), reviewRequest('sync-1', ['bob', 'alice'])))).toEqual(['bob'])
    expect(legacy.withTx(() => store.recordNotificationSync(legacy.getDb(), reviewRequest('sync-1', ['bob'])))).toEqual([])
    expect((await store.listNotifications(reader('bob'), {})).items.map((item) => item.eventId)).toEqual(['sync-1'])
  })
})

describe('read and archive', () => {
  test('both facts belong to the recipient and are independent of each other', async () => {
    await record(reviewRequest('req-1', ['bob', 'carol']))
    const [bobs] = (await store.listNotifications(reader('bob'), {})).items
    const read = await store.setNotificationRead(reader('bob'), { id: bobs!.id, read: true })
    expect(read.ok && read.notification.readAt).toBeNumber()
    expect((await store.listNotifications(reader('carol'), { filter: { view: 'unread' } })).items).toHaveLength(1)
    expect((await store.listNotifications(reader('bob'), { filter: { view: 'unread' } })).items).toEqual([])

    const archived = await store.setNotificationArchived(reader('bob'), { id: bobs!.id, archived: true })
    expect(archived.ok && archived.notification.readAt).toBeNumber()
    expect((await store.listNotifications(reader('bob'), { filter: { view: 'archived' } })).items).toHaveLength(1)
    expect((await store.listNotifications(reader('bob'), {})).items).toEqual([])

    // Marking unread does not restore, and restoring does not mark read or unread.
    await store.setNotificationRead(reader('bob'), { id: bobs!.id, read: false })
    const restored = await store.setNotificationArchived(reader('bob'), { id: bobs!.id, archived: false })
    expect(restored.ok && [restored.notification.readAt, restored.notification.archivedAt]).toEqual([null, null])
  })

  test('setting a fact again keeps it; the count follows unread and unarchived rows', async () => {
    await record(reviewRequest('req-1', ['bob']))
    await record(reviewRequest('req-2', ['bob'], 2_000))
    expect(await store.countNotifications(reader('bob'))).toEqual({ unread: 2, isCapped: false })
    const [newest] = (await store.listNotifications(reader('bob'), {})).items
    const first = await store.setNotificationRead(reader('bob'), { id: newest!.id, read: true })
    const again = await store.setNotificationRead(reader('bob'), { id: newest!.id, read: true })
    expect(first.ok && again.ok && first.notification.readAt === again.notification.readAt).toBe(true)
    expect(await store.countNotifications(reader('bob'))).toEqual({ unread: 1, isCapped: false })
  })

  test('another person cannot read or write a recipient\'s row', async () => {
    await record(reviewRequest('req-1', ['bob']))
    const [row] = (await store.listNotifications(reader('bob'), {})).items
    expect(await store.setNotificationRead(reader('carol'), { id: row!.id, read: true })).toEqual({ ok: false, reason: 'not_found' })
    expect(await store.getNotification(reader('carol'), row!.id)).toBeNull()
  })

  test('a row the reader can no longer open cannot be changed', async () => {
    await record(reviewRequest('req-1', ['bob']))
    const [row] = (await store.listNotifications(reader('bob'), {})).items
    const revoked = { ...reader('bob'), mayOpen: async () => false }
    expect(await store.setNotificationArchived(revoked, { id: row!.id, archived: true })).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('pages', () => {
  test('equal timestamps page in a stable order with no row twice', async () => {
    for (let index = 0; index < 7; index++) await record(reviewRequest(`req-${index}`, ['bob'], 5_000))
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.listNotifications(reader('bob'), { limit: 3, cursor })
      seen.push(...page.items.map((item) => item.id))
      cursor = page.cursor ?? undefined
    } while (cursor)
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    expect(seen).toEqual([...seen].sort().reverse())
  })

  test('rows the reader may not open are dropped before the page is cut, never ending the list early', async () => {
    for (let index = 0; index < 9; index++) await record(reviewRequest(`req-${index}`, ['bob'], 1_000 + index))
    const hidden = new Set(['req-8', 'req-7', 'req-6', 'req-5'])
    const filtered = { ...reader('bob'), mayOpen: async (item: HubNotification) => !hidden.has(item.eventId) }
    const first = await store.listNotifications(filtered, { limit: 2 })
    expect(first.items.map((item) => item.eventId)).toEqual(['req-4', 'req-3'])
    const second = await store.listNotifications(filtered, { limit: 2, cursor: first.cursor! })
    expect(second.items.map((item) => item.eventId)).toEqual(['req-2', 'req-1'])
    const third = await store.listNotifications(filtered, { limit: 2, cursor: second.cursor! })
    expect(third.items.map((item) => item.eventId)).toEqual(['req-0'])
    expect(third.cursor).toBeNull()
    expect(await store.countNotifications(filtered)).toEqual({ unread: 5, isCapped: false })
  })

  test('a cursor read for one reader or filter is refused for another', async () => {
    for (let index = 0; index < 3; index++) await record(reviewRequest(`req-${index}`, ['bob', 'carol'], 1_000 + index))
    const page = await store.listNotifications(reader('bob'), { limit: 1 })
    await expect(store.listNotifications(reader('carol'), { limit: 1, cursor: page.cursor! })).rejects.toBeInstanceOf(store.NotificationCursorError)
    await expect(store.listNotifications(reader('bob'), { limit: 1, cursor: page.cursor!, filter: { view: 'unread' } })).rejects.toBeInstanceOf(store.NotificationCursorError)
    await expect(store.listNotifications(reader('bob'), { cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(store.NotificationCursorError)
  })
})

describe('removal and identity', () => {
  test('a deleted resource takes its rows, and their recipients hear of it', async () => {
    await record(reviewRequest('req-1', ['bob', 'carol']))
    const heard: string[] = []
    const stop = store.onNotificationsChanged((change) => heard.push(change.recipientKey))
    await database.getDatabase().transaction((tx) => store.removeNotificationsFor(tx, 'org1', work))
    expect((await store.listNotifications(reader('bob'), {})).items).toEqual([])
    expect(heard.sort()).toEqual(['bob', 'carol'])
    stop()
  })
})
