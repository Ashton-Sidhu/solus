import { describe, expect, test } from 'bun:test'
import { NotificationHubClient, type HubSourceState } from '@solus/client-core/notifications/hub-client'
import type { NotificationSource } from '@solus/client-core/notifications/sources'
import { FakeNotificationSource } from './helpers/fake-notification-source'

// plans/015-notifications-hub.md v2 §6, stage 3: one hub over many sources, read by
// refresh. A source that fails or is slow never holds the others; a standalone
// host needs no cloud source; a change during a read costs exactly one more read;
// a refresh replaces the source's older pages; the merged list never skips a row
// of a source with more to report; a choice goes to its own source only while it
// is connected, is sent once, and is followed by a fresh read; and removing a
// source or signing out leaves nothing behind.

const host = (id: string): NotificationSource => ({ sourceId: `host:${id}`, serverId: id, kind: 'host', label: id })
const organization = (id: string): NotificationSource => ({ sourceId: `workspace:${id}`, serverId: `workspace:${id}`, kind: 'organization', label: id, organizationId: id })

function hub(fakes: Record<string, FakeNotificationSource>, options: { pageSize?: number; concurrency?: number } = {}) {
  return new NotificationHubClient({ identity: 'person-a', connect: (source) => fakes[source.sourceId]!.link(), ...options })
}

const titles = (client: NotificationHubClient) => client.entries().map((row) => row.notification.summary.title)
const status = (client: NotificationHubClient, sourceId: string): HubSourceState['status'] | undefined => client.sources.get(sourceId)?.status
const lists = (source: FakeNotificationSource) => source.calls.filter((call) => call === 'notificationsList').length

describe('reading sources', () => {
  test('two standalone hosts and two organizations merge into one hub; a failing one holds no other', async () => {
    const vmOne = new FakeNotificationSource()
    const vmTwo = new FakeNotificationSource()
    const orgA = new FakeNotificationSource()
    const orgB = new FakeNotificationSource()
    vmOne.add({ id: 'v1', createdAt: 100 })
    vmTwo.add({ id: 'v2', createdAt: 300 })
    orgA.add({ id: 'a', createdAt: 200, organizationId: 'org-a' })
    orgB.add({ id: 'b', createdAt: 400, organizationId: 'org-b' })
    orgB.failure = new Error('ECONNREFUSED')
    const client = hub({ 'host:vm1': vmOne, 'host:vm2': vmTwo, 'workspace:org-a': orgA, 'workspace:org-b': orgB })
    client.setSources([host('vm1'), host('vm2'), organization('org-a'), organization('org-b')])
    await client.idle()
    expect(titles(client)).toEqual(['v2', 'a', 'v1'])
    expect(status(client, 'workspace:org-b')).toBe('offline')
    expect(client.unreadCount()).toEqual({ unread: 3, isCapped: false, isComplete: false })

    orgB.failure = null
    orgB.emitReconnected()
    await client.idle()
    expect(titles(client)).toEqual(['b', 'v2', 'a', 'v1'])
    expect(client.unreadCount().isComplete).toBe(true)
  })

  test('a standalone host alone is a whole hub', async () => {
    const vm = new FakeNotificationSource()
    vm.add({ id: 'only', createdAt: 1 })
    const client = hub({ 'host:vm': vm })
    client.setSources([host('vm')])
    await client.idle()
    expect(titles(client)).toEqual(['only'])
    expect(client.unreadCount()).toEqual({ unread: 1, isCapped: false, isComplete: true })
  })

  test('an older host is unsupported, not an empty inbox', async () => {
    const old = new FakeNotificationSource()
    old.isUnsupported = true
    const client = hub({ 'host:old': old })
    client.setSources([host('old')])
    await client.idle()
    expect(status(client, 'host:old')).toBe('unsupported')
  })

  test('a change during a read costs exactly one more read, and shows the change', async () => {
    const source = new FakeNotificationSource()
    source.add({ id: 'first', createdAt: 100 })
    let release!: () => void
    source.hold = new Promise((resolve) => { release = resolve })
    const client = hub({ 'host:x': source })
    client.setSources([host('x')])
    await Promise.resolve()
    await Promise.resolve()
    source.add({ id: 'during', createdAt: 150 })
    source.emitChanged()
    source.emitChanged()
    source.emitChanged()
    source.hold = null
    release()
    await client.idle()
    expect(titles(client)).toEqual(['during', 'first'])
    expect(lists(source)).toBe(2)
  })

  test('the merged list waits for a source with more to report; equal times order stably', async () => {
    const a = new FakeNotificationSource()
    const b = new FakeNotificationSource()
    for (const createdAt of [100, 90, 80, 70]) a.add({ id: `a${createdAt}`, createdAt })
    for (const createdAt of [95, 85, 10]) b.add({ id: `b${createdAt}`, createdAt })
    a.add({ id: 'same', createdAt: 50 })
    b.add({ id: 'same', createdAt: 50 })
    const client = hub({ 'host:a': a, 'host:b': b }, { pageSize: 2 })
    client.setSources([host('a'), host('b')])
    await client.idle()
    expect(titles(client)).toEqual(['a100', 'b95', 'a90'])
    for (let index = 0; index < 4; index++) await client.loadMore()
    await client.idle()
    expect(client.entries().map((row) => `${row.sourceId}/${row.notification.id}`)).toEqual([
      'host:a/a100', 'host:b/b95', 'host:a/a90', 'host:b/b85', 'host:a/a80', 'host:a/a70', 'host:a/same', 'host:b/same', 'host:b/b10',
    ])
  })

  test('a refresh replaces the source\'s older pages: a row archived elsewhere does not linger', async () => {
    const source = new FakeNotificationSource()
    for (let index = 0; index < 5; index++) source.add({ id: `n${index}`, createdAt: 100 - index })
    const client = hub({ 'host:x': source }, { pageSize: 2 })
    client.setSources([host('x')])
    await client.idle()
    await client.loadMore()
    await client.loadMore()
    expect(titles(client)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4'])
    source.update('n3', { archivedAt: 5 })
    source.emitChanged()
    await client.idle()
    expect(titles(client)).toEqual(['n0', 'n1'])
    await client.loadMore()
    await client.loadMore()
    expect(titles(client)).toEqual(['n0', 'n1', 'n2', 'n4'])
  })

  test('the filter is the source\'s: archived and kind views read their own pages', async () => {
    const source = new FakeNotificationSource()
    source.add({ id: 'open', createdAt: 2 })
    source.add({ id: 'kept', createdAt: 1, archivedAt: 9 })
    source.add({ id: 'pr', createdAt: 3, facts: { kind: 'pr.review_requested' }, resource: { kind: 'pr', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 1 } } })
    const client = hub({ 'host:x': source })
    client.setSources([host('x')])
    await client.idle()
    client.setFilter({ view: 'archived' })
    await client.idle()
    expect(titles(client)).toEqual(['kept'])
    client.setFilter({ view: 'all', kinds: ['pr.review_requested'] })
    await client.idle()
    expect(titles(client)).toEqual(['pr'])
  })
})

describe('choices', () => {
  test('a choice goes to its own source, even when another source has the same id', async () => {
    const a = new FakeNotificationSource()
    const b = new FakeNotificationSource()
    a.add({ id: 'same-id', createdAt: 100 })
    b.add({ id: 'same-id', createdAt: 90 })
    const client = hub({ 'host:a': a, 'host:b': b })
    client.setSources([host('a'), host('b')])
    await client.idle()
    expect(await client.setRead('host:a\u0000same-id', true)).toBe(true)
    await client.idle()
    expect(a.items.get('same-id')!.readAt).not.toBeNull()
    expect(b.items.get('same-id')!.readAt).toBeNull()
    expect(b.calls).not.toContain('notificationsSetRead')
  })

  test('archiving in the inbox view takes the row out at once; read and archive are separate', async () => {
    const source = new FakeNotificationSource()
    source.add({ id: 'n', createdAt: 1 })
    const client = hub({ 'host:x': source })
    client.setSources([host('x')])
    await client.idle()
    await client.setArchived('host:x\u0000n', true)
    expect(titles(client)).toEqual([])
    await client.idle()
    expect(source.items.get('n')).toMatchObject({ readAt: null })
  })

  test('an offline source takes no choices; a lost answer is not sent again, and the next read shows the truth', async () => {
    const source = new FakeNotificationSource()
    source.add({ id: 'n', createdAt: 1 })
    const client = hub({ 'host:x': source })
    client.setSources([host('x')])
    await client.idle()
    const key = 'host:x\u0000n'

    source.failure = new Error('offline')
    source.emitChanged()
    await client.idle()
    expect(status(client, 'host:x')).toBe('offline')
    expect(client.canChange(key)).toBe(false)
    expect(await client.setRead(key, true)).toBe(false)
    expect(source.calls).not.toContain('notificationsSetRead')
    // The loaded row stays visible, as stale.
    expect(titles(client)).toEqual(['n'])

    source.failure = null
    source.emitReconnected()
    await client.idle()
    source.lostAnswer = new Error('socket closed')
    expect(await client.setRead(key, true)).toBe(false)
    source.lostAnswer = null
    await client.idle()
    expect(source.calls.filter((call) => call === 'notificationsSetRead')).toHaveLength(1)
    expect(client.rows.get(key)!.notification.readAt).not.toBeNull()
    expect(client.pending.size).toBe(0)
  })

  test('a second choice waits until the first is answered', async () => {
    const source = new FakeNotificationSource()
    source.add({ id: 'n', createdAt: 1 })
    const client = hub({ 'host:x': source })
    client.setSources([host('x')])
    await client.idle()
    const first = client.setRead('host:x\u0000n', true)
    expect(client.canChange('host:x\u0000n')).toBe(false)
    expect(await client.setRead('host:x\u0000n', false)).toBe(false)
    expect(await first).toBe(true)
  })
})

describe('removal and identity', () => {
  test('a removed source leaves no rows and gives back its connection', async () => {
    const vm = new FakeNotificationSource()
    vm.add({ id: 'v', createdAt: 1 })
    const client = hub({ 'host:vm': vm })
    client.setSources([host('vm')])
    await client.idle()
    client.setSources([])
    expect(client.rows.size + client.sources.size).toBe(0)
    expect(vm.releases).toBe(1)
  })

  test('a late answer after sign-out is dropped', async () => {
    const source = new FakeNotificationSource()
    source.add({ id: 'private', createdAt: 1 })
    let release!: () => void
    source.hold = new Promise((resolve) => { release = resolve })
    const client = hub({ 'host:x': source })
    client.setSources([host('x')])
    await Promise.resolve()
    await Promise.resolve()
    client.signOut()
    source.hold = null
    release()
    await client.idle()
    expect(client.rows.size + client.sources.size + client.pending.size).toBe(0)
    // A stopped engine reads nothing new.
    client.setSources([host('x')])
    expect(client.sources.size).toBe(0)
  })
})
