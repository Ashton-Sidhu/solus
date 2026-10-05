import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import type { Principal } from '@solus/server/admission/principal'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'
import type { Attribution } from '@solus/contracts/user'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/015-notifications-hub.md, stage 2: the personal feed on the record API
// and on RPC. The recipient is always the admitted person; a row whose work the
// caller may not open is left out before the page and the count are cut; a cursor
// or a state write cannot reach another person's rows; and losing access turns a
// row into a tombstone in the change feed. The same handlers boot on the Solus
// API with no execution runtime.

let operations: WorkspaceOperations
let store: typeof import('@solus/server/data/notifications/store')
let database: typeof import('@solus/server/db/database')
let shares: import('@solus/server/sharing/share-manager').ShareManager

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-notification-api-'))
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/notifications/store')
  database = await import('@solus/server/db/database')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  shares = new ShareManager({ db: database.getDatabase() })
  operations = (await import('@solus/server/data/workspace/service')).createWorkspaceOperations(shares)
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

const memberPrincipal = (userId: string, organizationId = 'org1'): Extract<Principal, { kind: 'org-member' }> => ({
  kind: 'org-member', userId, organizationId, organizationRole: 'member', teamIds: [], hostKind: 'personal',
  displayName: userId, deviceId: `${userId}-device`, deviceLabel: 'Browser', expiresAt: Date.now() + 300_000,
})
const member = (userId: string, organizationId = 'org1'): WorkspaceRequestContext => ({
  principal: memberPrincipal(userId, organizationId),
  home: { kind: 'organization', organizationId, serviceId: 'api' },
  scopes: ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read'],
})
const alice = member('alice')
const bob = member('bob')
const carol = member('carol')
const byAlice: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice' } }

async function requestReview(workId: string, eventId: string, recipients: string[], organizationId = 'org1', createdAt = Date.now()) {
  await database.getDatabase().transaction((tx) => store.recordNotification(tx, {
    organizationId, eventId, recipients, createdAt,
    facts: { kind: 'work.review_requested' }, resource: { kind: 'work', workId }, by: byAlice, summary: { title: 'Review' },
  }))
}

async function sharedWork(key: string) {
  const work = await operations.createWork(alice, { title: `Shared ${key}`, type: 'doc', content: 'body' }, `notif-api-${key}`.padEnd(16, '0'))
  await shares.shareWithOrganization({ kind: 'work', id: work.id }, { ...memberPrincipal('alice'), hostKind: 'cloud' })
  return work
}

describe('the record API feed', () => {
  test('the recipient is the credential\'s person, and rows they may not open are left out of the page and the count', async () => {
    const shared = await sharedWork('a')
    const hidden = await operations.createWork(alice, { title: 'Private', type: 'doc', content: 'body' }, 'notif-api-private-01')
    // Three hidden rows newer than the visible one: a page of one must still find it.
    await requestReview(shared.id, 'visible', ['bob', 'carol'], 'org1', 1_000)
    for (let index = 0; index < 3; index++) await requestReview(hidden.id, `hidden-${index}`, ['bob'], 'org1', 2_000 + index)

    const page = await operations.listMyNotifications(bob, { limit: 1 })
    expect(page.items.map((item) => item.eventId)).toEqual(['visible'])
    expect(page.nextCursor).toBeNull()
    expect(await operations.countMyNotifications(bob)).toEqual({ unread: 1, isCapped: false })
    // Carol has her own row; Alice, who acted, has none.
    expect((await operations.listMyNotifications(carol, {})).items).toHaveLength(1)
    expect((await operations.listMyNotifications(alice, {})).items).toEqual([])
    // A credential that may not read works reads no work notifications.
    expect((await operations.listMyNotifications({ ...bob, scopes: ['tasks:read'] }, {})).items).toEqual([])
  })

  test('a member of another organization reads nothing of this one', async () => {
    const shared = await sharedWork('b')
    await requestReview(shared.id, 'org1-request', ['bob'])
    expect((await operations.listMyNotifications(member('bob', 'org2'), {})).items).toEqual([])
  })

  test('a cursor read for one person is refused for another; a garbled one is an invalid cursor', async () => {
    const shared = await sharedWork('c')
    for (let index = 0; index < 3; index++) await requestReview(shared.id, `r-${index}`, ['bob', 'carol'], 'org1', 1_000 + index)
    const page = await operations.listMyNotifications(bob, { limit: 1 })
    await expect(operations.listMyNotifications(carol, { limit: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' })
    await expect(operations.listMyNotifications(bob, { cursor: 'garbled' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  })

  test('receipt writes set a fact, answer the row, and reach only the caller\'s own rows', async () => {
    const shared = await sharedWork('d')
    await requestReview(shared.id, 'r', ['bob'])
    const [row] = (await operations.listMyNotifications(bob, {})).items
    expect((await operations.setMyNotificationRead(bob, row!.id, { read: true })).readAt).toBeNumber()
    expect((await operations.setMyNotificationRead(bob, row!.id, { read: false })).readAt).toBeNull()
    await expect(operations.setMyNotificationArchived(carol, row!.id, { archived: true })).rejects.toMatchObject({ status: 404 })
    const archived = await operations.setMyNotificationArchived(bob, row!.id, { archived: true })
    expect([archived.archivedAt !== null, archived.readAt]).toEqual([true, null])
  })

  test('losing access removes the row from the page and the count, and from the caller\'s reach', async () => {
    const shared = await sharedWork('e')
    await requestReview(shared.id, 'r', ['bob'])
    const snapshot = await operations.listMyNotifications(bob, {})
    expect(snapshot.items).toHaveLength(1)
    // Alice takes the work back from the organization.
    await shares.setGrants({ resource: { kind: 'work', id: shared.id }, grants: [] }, { ...memberPrincipal('alice'), hostKind: 'cloud' })
    expect((await operations.listMyNotifications(bob, {})).items).toEqual([])
    expect(await operations.countMyNotifications(bob)).toEqual({ unread: 0, isCapped: false })
    await expect(operations.setMyNotificationRead(bob, snapshot.items[0]!.id, { read: true })).rejects.toMatchObject({ status: 404 })
  })

  test('a guest has no hub', async () => {
    const guest: WorkspaceRequestContext = {
      ...bob,
      principal: { kind: 'guest', guestId: 'g1', organizationId: 'org1', displayName: 'Guest', deviceId: 'g1', expiresAt: Date.now() + 60_000, deviceLabel: 'Guest link', share: { resource: { kind: 'work', id: 'w' }, role: 'viewer', sharedByUserId: 'alice', linkSecretHash: 'x' } },
    }
    await expect(operations.listMyNotifications(guest, {})).rejects.toMatchObject({ status: 403 })
  })
})

describe('the RPC feed', () => {
  type Handler = (args: unknown[], ctx: { principal: Principal }) => unknown
  async function handlers(register: (server: import('@solus/server/transport/server').SolusServer) => void) {
    const registered = new Map<string, Handler>()
    // SAFETY: the handlers only call `register` at registration time.
    register({ register: (name: string, handler: Handler) => { registered.set(name, handler) } } as unknown as import('@solus/server/transport/server').SolusServer)
    return registered
  }

  test('the Solus API boots the hub with no execution runtime, answering its version and the caller\'s own rows', async () => {
    const { registerSolusApiHandlers } = await import('@solus/server/transport/solus-api/service-handlers')
    const { HostEventPublisher } = await import('@solus/server/transport/events/host-event-publisher')
    const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
    const { WorkLiveManager } = await import('@solus/server/work-live/work-live-manager')
    const rpc = await handlers((server) => registerSolusApiHandlers(server, {
      shares, events: new HostEventPublisher(new ClientEventRegistry(() => true)), workLive: new WorkLiveManager({ publish: () => {} }),
      serviceId: 'api', host: '127.0.0.1', port: () => 0, presence: { watch: () => {}, unwatch: () => {} },
    }))
    const { NOTIFICATION_HUB_VERSION } = await import('@solus/contracts/notification-hub')
    expect(await rpc.get('notificationsCapability')!([], { principal: memberPrincipal('bob') })).toEqual({ version: NOTIFICATION_HUB_VERSION })

    const shared = await sharedWork('f')
    await requestReview(shared.id, 'r', ['bob'])
    const page = await rpc.get('notificationsList')!([{}], { principal: memberPrincipal('bob') }) as { items: { id: string }[] }
    expect(page.items).toHaveLength(1)
    expect((await rpc.get('notificationsList')!([{}], { principal: memberPrincipal('carol') }) as { items: unknown[] }).items).toEqual([])
    const result = await rpc.get('notificationsSetRead')!([{ id: page.items[0]!.id, read: true }], { principal: memberPrincipal('carol') })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
    await expect(Promise.resolve().then(() => rpc.get('notificationsList')!([{}], { principal: { kind: 'runner', hostId: 'h', organizationId: 'org1', ownerUserId: 'bob', deviceId: 'h', expiresAt: 0, deviceLabel: 'Runner' } }))).rejects.toThrow('Only a person')
  })
})
