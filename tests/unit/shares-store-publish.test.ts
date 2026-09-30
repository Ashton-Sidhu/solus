import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Publication, PublicationStartRequest } from '@solus/contracts/organization-scope'
import type { ShareList, ShareResource } from '@solus/contracts/sharing'
import { configureUplinkAccountSource } from '@solus/client-core/uplink-account'
import { singleHostServerConnections } from './helpers/server-connections-mock'

// docs/plans/organization-scope.md §7: the Share action is the opt-in to publish.
// Opening Share on a Local resource starts its upload into the window's
// organization at once, with no second confirmation; once the machine reports
// `committed`, the dialog continues on that organization's share list.

const connections = singleHostServerConnections()
const offlineServerIds = new Set<string>()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    ...connections,
    statusFor: (serverId: string) => (offlineServerIds.has(serverId) ? 'disconnected' : 'connected'),
  },
}))

const toastCalls: string[] = []
mock.module('@solus/workspace-ui/lib/toasts', () => ({
  toasts: {
    error: (message: string) => { toastCalls.push(`error:${message}`) },
    info: (message: string) => { toastCalls.push(`info:${message}`) },
    success: (message: string) => { toastCalls.push(`success:${message}`) },
  },
}))

let directoryReads = 0
const window = { activeOrganizationId: 'org-1' as string | null, activeOrganizationName: 'Acme' as string | null }
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
  serversStore: {
    get activeOrganizationId() { return window.activeOrganizationId },
    get activeOrganizationName() { return window.activeOrganizationName },
    refreshDirectory: async () => { directoryReads++ },
    hostFor: () => null,
  },
}))
mock.module('@solus/workspace-ui/contexts/connections/uplink.store.svelte', () => ({
  uplinkStore: { statusFor: () => undefined, refresh: async () => {} },
}))
mock.module('@solus/workspace-ui/contexts/notifications/notifications.store.svelte', () => ({
  notificationsStore: { wants: () => false },
}))

const stateShim = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
type RuneHost = typeof globalThis & { $state?: typeof stateShim }
const runeHost: RuneHost = globalThis
const previousState = runeHost.$state

beforeEach(() => {
  connections.reset()
  offlineServerIds.clear()
  toastCalls.length = 0
  directoryReads = 0
  window.activeOrganizationId = 'org-1'
  window.activeOrganizationName = 'Acme'
  runeHost.$state = stateShim
})

afterEach(() => {
  connections.reset()
  if (previousState === undefined) delete runeHost.$state
  else runeHost.$state = previousState
})

const CLOUD = 'workspace:org-1'
const resource: ShareResource = { kind: 'work', id: 'w1' }
const target = { serverId: 'local', resource, title: 'Release plan' }

const cloudList: ShareList = { resource, ownerUserId: 'u1', grants: [], callerRole: 'owner', link: null }

function publication(state: Publication['state'], error?: string): Publication {
  const record: Publication = { id: 'p1', resource, organizationId: 'org-1', actorUserId: 'u1', state, createdAt: 1, updatedAt: 1 }
  if (error) record.error = error
  return record
}

/** The organization's workspace service, ready to list the resource's share. */
function registerCloud(): void {
  connections.registerHost(CLOUD, {
    shareGet: async () => cloudList,
    connectionsGetServerInfo: async () => ({ principal: 'org-member', userId: 'u1', organizationId: 'org-1' }),
  })
}

async function newStore() {
  const { SharesStore } = await import('@solus/workspace-ui/contexts/sharing/shares.store.svelte')
  const store = new SharesStore({ pollMs: 5 })
  const published: [string, string, string][] = []
  store.works = { markPublished: (workId: string, organizationId: string, cloudServerId: string) => { published.push([workId, organizationId, cloudServerId]) } } as never
  return { store, published }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('sharing a Local resource', () => {
  test('opening Share publishes on the source machine, waits for committed, then loads the organization\'s share list', async () => {
    const starts: PublicationStartRequest[] = []
    connections.registerPrimary('local', {
      publicationList: async () => [],
      publicationStart: async (request: PublicationStartRequest) => { starts.push(request); return publication('pending') },
    })
    registerCloud()
    const { store, published } = await newStore()

    await store.open(target)
    await settle()

    // WHY: Share is the opt-in (§7). The upload starts without a second
    // confirmation, into the window's organization, and the dialog says so.
    expect(starts).toEqual([{ resource, organizationId: 'org-1' }])
    expect(store.dialog).toMatchObject({
      serverId: 'local',
      publication: { sourceServerId: 'local', organizationId: 'org-1', organizationName: 'Acme', status: { kind: 'pending' } },
    })
    // The list is not read from the cloud before the receipt: no working-looking link early.
    expect(store.listFor(CLOUD, resource)).toBeUndefined()

    connections.emit('local', 'publication.changed', publication('committed'))
    await settle()

    // WHY: the receipt is what makes the workspace service the record's home. Only
    // then does the store follow the work there and read the cloud share list.
    expect(published).toEqual([['w1', 'org-1', CLOUD]])
    expect(store.dialog).toEqual({ serverId: CLOUD, resource, title: 'Release plan' })
    expect(store.listFor(CLOUD, resource)).toEqual(cloudList)
    expect(directoryReads).toBe(1)
  })

  test('without the event, the machine is re-read until it reports the receipt', async () => {
    let reads = 0
    connections.registerPrimary('local', {
      publicationList: async () => (reads++ < 2 ? [publication('pending')] : [publication('committed')]),
      publicationStart: async () => publication('pending'),
    })
    registerCloud()
    const { store } = await newStore()

    await store.open(target)
    await store.publishResource({ serverId: 'local', resource, organizationId: 'org-1' })
    await settle()

    expect(reads).toBeGreaterThanOrEqual(3)
    expect(store.dialog?.serverId).toBe(CLOUD)
  })

  test('a publication the machine holds until the publisher reconnects shows the reason, offers Retry, and stops asking', async () => {
    // WHY: the machine could not send as the publisher and said so on a `sent`
    // row. The dialog waited only for committed or failed, so it showed
    // "Uploading…" forever and asked the machine twice a second.
    let reads = 0
    connections.registerPrimary('local', {
      publicationList: async () => { reads++; return [publication('sent')] },
      publicationStart: async () => publication('pending'),
    })
    const { store } = await newStore()

    await store.open(target)
    await settle()
    connections.emit('local', 'publication.changed', publication('sent', 'Your sign-in for this machine expired. Reconnect and send again.'))
    await settle()

    expect(store.dialog?.publication?.status).toEqual({ kind: 'waiting', error: 'Your sign-in for this machine expired. Reconnect and send again.' })
    const readsWhenAnswered = reads
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(reads).toBe(readsWhenAnswered)
  })

  test('without the event, re-reads back off instead of asking at a fixed rate', async () => {
    let reads = 0
    connections.registerPrimary('local', {
      publicationList: async () => { reads++; return [publication('sent')] },
      publicationStart: async () => publication('pending'),
    })
    const { store } = await newStore()

    await store.open(target)
    // A fixed 5 ms rate would read about 30 times here; doubling from 5 ms reads 4 or 5 times.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(reads).toBeLessThanOrEqual(6)
    store.close()
  })

  test('a failed publication keeps the dialog in the publish state with the error, and Retry publishes again', async () => {
    let attempt = 0
    connections.registerPrimary('local', {
      publicationList: async () => [],
      publicationStart: async () => (++attempt === 1 ? publication('pending') : publication('committed')),
    })
    registerCloud()
    const { store, published } = await newStore()

    await store.open(target)
    await settle()
    connections.emit('local', 'publication.changed', publication('failed', 'The organization refused the upload.'))
    await settle()

    // WHY: the source is preserved and the state is retryable; the reservation
    // keeps the same destination, so a retry cannot pick another organization.
    expect(published).toEqual([])
    expect(store.dialog?.publication?.status).toEqual({ kind: 'failed', error: 'The organization refused the upload.' })

    await store.publish()
    expect(attempt).toBe(2)
    expect(published).toEqual([['w1', 'org-1', CLOUD]])
    expect(store.dialog?.serverId).toBe(CLOUD)
  })

  test('closing the dialog while the upload runs leaves it closed', async () => {
    connections.registerPrimary('local', {
      publicationList: async () => [],
      publicationStart: async () => publication('pending'),
    })
    registerCloud()
    const { store } = await newStore()

    await store.open(target)
    store.close()
    connections.emit('local', 'publication.changed', publication('committed'))
    await settle()

    // WHY: Done is the way out at every step; a late receipt must not raise the dialog again.
    expect(store.dialog).toBeNull()
  })

test('a resource the machine already published opens directly on its organization\'s list', async () => {
    let starts = 0
    connections.registerPrimary('local', {
      publicationList: async () => [publication('committed')],
      publicationStart: async () => { starts++; throw new Error('already published') },
    })
    registerCloud()
    const { store, published } = await newStore()

    await store.open(target)

    expect(starts).toBe(0)
    expect(published).toEqual([['w1', 'org-1', CLOUD]])
    expect(store.dialog).toEqual({ serverId: CLOUD, resource, title: 'Release plan' })
  })

  test('a machine that is not connected cannot publish, and the dialog says so', async () => {
    connections.registerPrimary('local', {
      publicationList: async () => { throw new Error('offline') },
      publicationStart: async () => { throw new Error('must not be asked') },
    })
    offlineServerIds.add('local')
    const { store } = await newStore()

    await store.open(target)
    await settle()
    expect(store.dialog?.publication?.status).toEqual({ kind: 'offline' })

    await store.publish()
    expect(store.dialog?.publication?.status).toEqual({ kind: 'offline' })
  })

  test('with no organization selected, Share explains instead of opening', async () => {
    window.activeOrganizationId = null
    window.activeOrganizationName = null
    connections.registerPrimary('local', { publicationList: async () => [] })
    const { store } = await newStore()

    await store.open(target)

    expect(store.dialog).toBeNull()
    expect(toastCalls).toEqual(['error:Select an organization before sharing.'])
  })
})


test('publish entry points share one request and report the captured organization after a switch', async () => {
  const starts: PublicationStartRequest[] = []
  let announceStart: () => void = () => {}
  const started = new Promise<void>((resolve) => { announceStart = resolve })
  connections.registerPrimary('local', {
    publicationList: async () => [],
    publicationStart: async (request: PublicationStartRequest) => { starts.push(request); announceStart(); return publication('pending') },
  })
  const { store } = await newStore()
  const first = store.publishWork('local', 'w1')
  await started
  const second = store.publishWork('local', 'w1')
  const followed = store.publishResource({ serverId: 'local', resource, organizationId: 'org-1' })
  expect(store.isPublishing('local', resource)).toBe(true)
  window.activeOrganizationId = 'org-2'
  window.activeOrganizationName = 'Beta'
  expect(await store.publishResource({ serverId: 'local', resource, organizationId: 'org-2' })).toMatchObject({ kind: 'failed' })
  connections.emit('local', 'publication.changed', publication('committed'))
  await Promise.all([first, second, followed])
  expect(starts).toEqual([{ resource, organizationId: 'org-1' }])
  expect(toastCalls).toEqual(['success:Published to Acme'])
  expect(store.isPublishing('local', resource)).toBe(false)
})

describe('the organization directory', () => {
  afterEach(() => configureUplinkAccountSource(null))

  test('answers the members as users, converted once, and reads the account plane once per host', async () => {
    // WHY (plans/012 §6): the mention picker, the share dialog and every other people
    // choice read one member list of `User`s; none of them converts the directory again.
    let loads = 0
    const unavailable = async (): Promise<never> => { throw new Error('not in this test') }
    configureUplinkAccountSource({
      listDirectory: unavailable,
      acquireHostAccessToken: unavailable,
      issueEnrollmentTicket: unavailable,
      startManagedHost: unavailable,
      loadOrganizationDirectory: async (organizationId) => {
        loads++
        return {
          organizationId,
          name: 'Acme',
          members: [{ userId: 'u_ann', name: 'Ann Lee', email: 'ann@acme.dev', image: 'https://img/ann.png', role: 'owner' }],
          teams: [],
        }
      },
    })
    registerCloud()
    const { store } = await newStore()

    const people = await store.directoryFor(CLOUD)

    expect(people?.members).toEqual([
      { id: { kind: 'account', accountId: 'u_ann' }, displayName: 'Ann Lee', email: 'ann@acme.dev', avatarUrl: 'https://img/ann.png' },
    ])
    expect(await store.directoryFor(CLOUD)).toBe(people)
    expect(store.directories.get(CLOUD)).toBe(people)
    expect(loads).toBe(1)
  })
})
