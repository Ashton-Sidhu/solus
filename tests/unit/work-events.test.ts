import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostEvent } from '@solus/contracts/host-events'
import type { Attribution } from '@solus/contracts/user'
import type { Principal } from '@solus/server/admission/principal'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import { resetTestDatabase } from './helpers/test-db'

/**
 * `works.changed` (docs/plans/work-editing-foundation.md §2): one small signal
 * per committed work write, whoever made it, after the outermost transaction
 * commits and never on rollback; heard only by principals that can open the work.
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const PERSON: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice' } }
const alice = { kind: 'org-member', userId: 'alice', organizationId: 'A', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Alice', deviceId: 'alice-device', deviceLabel: 'Browser', expiresAt: Date.now() + 300000 } as const
const bob = { ...alice, userId: 'bob', displayName: 'Bob', deviceId: 'bob-device' } as const
const context: WorkspaceRequestContext = { principal: alice, home: { kind: 'organization', organizationId: 'A', serviceId: 'api' }, scopes: ['works:read', 'works:write'] }

let dataDir: string
let database: typeof import('@solus/server/db/database')
let works: typeof import('@solus/server/data/works/works')
let workModule: typeof import('@solus/server/data/works/work')
let workEvents: typeof import('@solus/server/data/works/work-events')
let audience: typeof import('@solus/server/sharing/event-audience')
let shares: import('@solus/server/sharing/share-manager').ShareManager
let operations: import('@solus/server/data/workspace/operations').WorkspaceOperations
let heard: import('@solus/server/data/works/work-events').WorkChange[]
let stopListening: () => void
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-work-events-'))
  process.env.SOLUS_DATA_DIR = dataDir
  database = await import('@solus/server/db/database')
  works = await import('@solus/server/data/works/works')
  workModule = await import('@solus/server/data/works/work')
  workEvents = await import('@solus/server/data/works/work-events')
  audience = await import('@solus/server/sharing/event-audience')
})

beforeEach(async () => {
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  shares = new ShareManager({ db: database.getDatabase() })
  operations = (await import('@solus/server/data/workspace/service')).createWorkspaceOperations(shares)
  heard = []
  stopListening = workEvents.onWorksChanged(change => heard.push(change))
})

afterEach(async () => {
  stopListening()
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function newDoc(organizationId = 'local') {
  const created = await works.createWork(organizationId, 'Doc', 'doc', 'v1', '', undefined, 'claude-code')
  heard = []
  return workModule.Work.byId(organizationId, created.id)
}

describe('commit', () => {
  test('a write announces its record and content versions, and no body', async () => {
    const work = await newDoc()
    await work.updateContent({ content: 'v2', expectedContentVersion: 1, author: PERSON, reason: 'edit' })
    expect(heard).toEqual([{ workId: work.id, version: work.updatedAt, contentVersion: 2 }])
    await work.updateTitle({ title: 'Renamed' })
    expect(heard.at(-1)).toEqual({ workId: work.id, version: work.updatedAt, contentVersion: 2 })
  })

  test('creation is announced; a write that changes nothing is not', async () => {
    const created = await works.createWork('local', 'New', 'doc', 'body', '', undefined, 'claude-code')
    expect(heard).toEqual([{ workId: created.id, version: created.updatedAt, contentVersion: 1 }])
    const work = await workModule.Work.byId('local', created.id)
    await work.updateContent({ content: 'body', expectedContentVersion: 1, author: PERSON, reason: 'edit' })
    expect(heard).toHaveLength(1)
  })

  test('a write inside an outer transaction is announced only once the outer one commits', async () => {
    const work = await newDoc()
    await database.getDatabase().transaction(async () => {
      await (await workModule.Work.byId('local', work.id)).updateContent({ content: 'nested', expectedContentVersion: 1, author: PERSON, reason: 'edit' })
      await (await workModule.Work.byId('local', work.id)).setPinned(true)
      expect(heard).toEqual([])
    })
    expect(heard.map(change => change.contentVersion)).toEqual([2, 2])
  })

  test('a rolled-back write is never announced', async () => {
    const work = await newDoc()
    await expect(database.getDatabase().transaction(async () => {
      await (await workModule.Work.byId('local', work.id)).updateContent({ content: 'rolled back', expectedContentVersion: 1, author: PERSON, reason: 'edit' })
      throw new Error('abort')
    })).rejects.toThrow('abort')
    expect(heard).toEqual([])
  })

  test('an API write, whose transaction wraps the work\'s own, is announced once with the answer\'s versions', async () => {
    const created = await operations.createWork(context, { title: 'Notes', type: 'doc', content: 'one' }, 'work-events-create-01')
    heard = []
    const saved = await operations.updateWork(context, created.id, { content: 'two', expectedContentVersion: 1 }, created.version)
    expect(heard).toEqual([{ workId: saved.id, version: saved.version, contentVersion: saved.contentVersion }])
  })

  test('a person\'s delete is announced after commit with the last versions; a refused one is not', async () => {
    const created = await operations.createWork(context, { title: 'Doomed', type: 'doc', content: 'one' }, 'work-events-create-05')
    heard = []
    const deleted: import('@solus/server/data/works/work-events').WorkChange[] = []
    const stop = workEvents.onWorkDeleted(async change => async () => deleted.push(change))
    try {
      // WHY: an open reader cannot learn of a delete from a read it never makes;
      // the signal stops its subscription and shows the work as unavailable.
      await expect(operations.deleteWork(context, created.id, '2020-01-01T00:00:00.000Z')).rejects.toThrow()
      expect(deleted).toEqual([])
      await operations.deleteWork(context, created.id, created.version)
      expect(deleted).toEqual([{ workId: created.id, version: created.version, contentVersion: 1, deleted: true }])
      expect(heard).toEqual([])
    } finally {
      stop()
    }
  })

  test('a refused write is not announced', async () => {
    const work = await newDoc()
    await expect(work.updateContent({ content: 'stale', expectedContentVersion: 7, author: PERSON, reason: 'edit' })).rejects.toBeInstanceOf(workModule.WorkVersionConflictError)
    expect(heard).toEqual([])
  })
})

describe('audience', () => {
  const changed = (workId: string): HostEvent => ({ type: 'works.changed', payload: { workId, version: '2026-09-29T00:00:00.000Z', contentVersion: 2 }, occurredAt: 0 })

  test('a guest hears only its shared work; a member only the works it can open; the owner everything; a runner nothing', async () => {
    const shared = await operations.createWork(context, { title: 'Shared', type: 'doc', content: 'x' }, 'work-events-create-02')
    const other = await operations.createWork(context, { title: 'Private', type: 'doc', content: 'y' }, 'work-events-create-03')
    const link = await shares.setLink({ resource: { kind: 'work', id: shared.id }, role: 'viewer' }, alice)
    const share = await shares.resolveLinkSecret(link!.secret)
    const guest: Principal = { kind: 'guest', guestId: 'g1', organizationId: 'A', displayName: 'Maya', deviceId: 'g1', share: share!, expiresAt: Date.now() + 300000, deviceLabel: 'Guest link' }
    const owner: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Test' }
    const runner: Principal = { kind: 'runner', hostId: 'h1', organizationId: 'A', ownerUserId: 'bob', deviceId: 'h1', expiresAt: Date.now() + 300000, deviceLabel: 'Runner' }

    expect(await audience.eventVisibleTo(guest, changed(shared.id), shares)).toBe(true)
    expect(await audience.eventVisibleTo(guest, changed(other.id), shares)).toBe(false)
    expect(await audience.eventVisibleTo(alice, changed(other.id), shares)).toBe(true)
    // No host-wide default: a member who cannot open a work does not hear it.
    expect(await audience.eventVisibleTo(bob, changed(other.id), shares)).toBe(false)
    await shares.setGrants({ resource: { kind: 'work', id: other.id }, grants: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, alice)
    expect(await audience.eventVisibleTo(bob, changed(other.id), shares)).toBe(true)
    expect(await audience.eventVisibleTo(owner, changed(other.id), shares)).toBe(true)
    expect(await audience.eventVisibleTo(runner, changed(shared.id), shares)).toBe(false)
  })

  test('the host publisher delivers a committed write to the clients that can open it', async () => {
    const [{ ClientEventRegistry }, { HostEventPublisher }] = await Promise.all([
      import('@solus/server/transport/events/client-event-registry'), import('@solus/server/transport/events/host-event-publisher'),
    ])
    const principals = new Map<string, Principal>([['alice', alice], ['bob', bob]])
    const registry = new ClientEventRegistry((clientId, event) => audience.eventVisibleTo(principals.get(clientId)!, event, shares))
    const delivered = new Map<string, HostEvent[]>([['alice', []], ['bob', []]])
    for (const [clientId, events] of delivered) registry.register(clientId, event => events.push(event))
    const publisher = new HostEventPublisher(registry)
    const broadcasts: Promise<number>[] = []
    const stop = workEvents.onWorksChanged(change => broadcasts.push(publisher.broadcast('works.changed', change)))
    try {
      const created = await operations.createWork(context, { title: 'Notes', type: 'doc', content: 'one' }, 'work-events-create-04')
      await operations.updateWork(context, created.id, { content: 'two', expectedContentVersion: 1 }, created.version)
      await Promise.all(broadcasts)
      expect(delivered.get('alice')!.map(event => event.type === 'works.changed' && event.payload.contentVersion)).toEqual([1, 2])
      expect(delivered.get('bob')).toEqual([])
    } finally {
      stop()
    }
  })

  test('a delete reaches every reader the work was shared with, though its grants go with it', async () => {
    // WHY: the delete signal replaced the cloud's 30-second poll. Its readers
    // are decided before the grants are removed, or only the host owner hears.
    const [{ ClientEventRegistry }, { HostEventPublisher }] = await Promise.all([
      import('@solus/server/transport/events/client-event-registry'), import('@solus/server/transport/events/host-event-publisher'),
    ])
    const created = await operations.createWork(context, { title: 'Shared', type: 'doc', content: 'one' }, 'work-events-create-06')
    const link = await shares.setLink({ resource: { kind: 'work', id: created.id }, role: 'viewer' }, alice)
    const share = await shares.resolveLinkSecret(link!.secret)
    const guest: Principal = { kind: 'guest', guestId: 'g2', organizationId: 'A', displayName: 'Maya', deviceId: 'g2', share: share!, expiresAt: Date.now() + 300000, deviceLabel: 'Guest link' }
    const cara = { ...alice, userId: 'cara', displayName: 'Cara', deviceId: 'cara-device' } as const
    await shares.setGrants({ resource: { kind: 'work', id: created.id }, grants: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, alice)
    const principals = new Map<string, Principal>([['alice', alice], ['bob', bob], ['guest', guest], ['cara', cara]])
    const registry = new ClientEventRegistry((clientId, event) => audience.eventVisibleTo(principals.get(clientId)!, event, shares))
    const delivered = new Map<string, HostEvent[]>([...principals.keys()].map(clientId => [clientId, []]))
    for (const [clientId, events] of delivered) registry.register(clientId, event => events.push(event))
    const publisher = new HostEventPublisher(registry)
    const stop = workEvents.onWorkDeleted(change => publisher.prepareBroadcast('works.changed', change))
    try {
      await expect(database.getDatabase().transaction(async () => {
        await operations.deleteWork(context, created.id, created.version)
        throw new Error('abort')
      })).rejects.toThrow('abort')
      expect([...delivered.values()].flat()).toEqual([])

      await operations.deleteWork(context, created.id, created.version)
      const heardDelete = (clientId: string) => delivered.get(clientId)!.map(event => event.type === 'works.changed' && event.payload.deleted)
      expect(heardDelete('alice')).toEqual([true])
      expect(heardDelete('bob')).toEqual([true])
      expect(heardDelete('guest')).toEqual([true])
      expect(heardDelete('cara')).toEqual([])
      expect(await shares.roleFor(bob, { kind: 'work', id: created.id })).toBe('none')
    } finally {
      stop()
    }
  })
})
