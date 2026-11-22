import { describe, expect, test } from 'bun:test'
import { hostListSourceFor, deviceHostListSource, DEVICE_HOST_LIST_KEY } from '@solus/client-core/host-list-source'
import { HOST_CREDENTIALS_KEY, localStorageCredentials } from '@solus/client-core/host-credentials'
import { HostCatalog } from '@solus/client-core/host-catalog'
import type { KnownHost } from '@solus/client-core/known-host'
import type { AccountDocumentCall } from '@solus/client-core/account-documents'
import { DEFAULT_HOST_RULES } from '@solus/contracts/uplink'
import { hostListingSchema } from '@solus/contracts/host-list'
import { catalogOf, credentialFor, directoryHostFor, fakeDirectory, fakeList, listingFor, memoryCredentials, type Journal } from './helpers/host-catalog-world'

// plans/033: a client keeps only its credentials. The hosts it shows are joined
// in memory from the person's list, the account directory, and those credentials.

const pairedHost = (id: string, overrides: Partial<KnownHost> = {}): KnownHost => ({
  id, label: `Host ${id}`, sessionToken: `token-${id}`, installationId: id, lastConnected: 5, os: 'macos',
  routes: [{ kind: 'lan', url: `http://${id}.lan:3000`, source: 'pairing', seenAt: 5 }], ...overrides,
})

const ids = (catalog: HostCatalog) => catalog.hosts().map((host) => host.id)

describe('the join', () => {
  test('a listed host takes its facts from the list, its token and own routes from this device, and its tunnel and owner from the directory', async () => {
    // WHY: §4.1. Each answer owns its facts; no answer is copied into another.
    const journal: Journal = []
    const directory = fakeDirectory()
    directory.answer([directoryHostFor('a', { organizationIds: ['org-1'] })])
    const catalog = catalogOf({ credentials: memoryCredentials(journal, { a: credentialFor('a', { routeOrder: ['http://a.lan:3000'] }) }), directory })
    const list = fakeList(journal, 'account', [
      listingFor('a', { label: 'Studio', os: 'macos', routes: [{ kind: 'lan', url: 'http://other-device-pairing:3000', source: 'pairing' }, { kind: 'vpn', url: 'http://100.64.0.1:3000', source: 'host' }] }),
      listingFor('b'),
    ])
    await catalog.useListSource(list.source)
    await catalog.refreshDirectory()

    const a = catalog.find('a')!
    expect(a).toMatchObject({ label: 'Studio', os: 'macos', sessionToken: 'token-a', routeOrder: ['http://a.lan:3000'] })
    // This device's pairing route, the host's own route from the list, and the directory's tunnel.
    // Another device's pairing address is that device's to know.
    expect(a.routes.map((route) => `${route.source} ${route.url}`)).toEqual([
      'directory https://a.tunnel.test',
      'pairing http://a.lan:3000',
      'host http://100.64.0.1:3000',
    ])
    expect(a.uplink).toMatchObject({ hostId: 'cloud-a', organizationIds: ['org-1'] })
    // A host another device paired shows with no token: a grant dials it.
    expect(catalog.find('b')!.sessionToken).toBe('')
  })

  test('a host this device paired waits for the list while it loads, and shows when the list cannot be read', async () => {
    // WHY: §4.1 boot order — the listed hosts are dialed after the list read. A
    // client with no network still reaches the hosts it holds a token for.
    const journal: Journal = []
    const catalog = catalogOf({ credentials: memoryCredentials(journal, { a: credentialFor('a') }) })
    await catalog.load()
    expect(catalog.listState()).toBe('loading')
    expect(ids(catalog)).toEqual([])

    const list = fakeList(journal, 'host:local')
    list.state.failing = true
    await catalog.useListSource(list.source)
    expect(catalog.listState()).toBe('failed')
    expect(catalog.find('a')).toMatchObject({ sessionToken: 'token-a', label: 'a.lan:3000' })
  })

  test('a host this device paired is known by its credential before the list loads, so a page can dial the host that keeps its list', async () => {
    // WHY: §4.5. A web page served by a host reads the person's list on that host,
    // so it must dial the host with its token before any list names it.
    const catalog = catalogOf({ credentials: memoryCredentials([], { a: credentialFor('a'), granted: credentialFor('granted', { token: '' }) }) })
    await catalog.load()
    expect(ids(catalog)).toEqual([])
    expect(catalog.pairedHost('a')).toMatchObject({ id: 'a', sessionToken: 'token-a', routes: [{ url: 'http://a.lan:3000', source: 'pairing' }] })
    // A credential with no token is routes only: the host is dialed with a grant, never as paired.
    expect(catalog.pairedHost('granted')).toBeNull()
    expect(catalog.pairedHost('unknown')).toBeNull()
  })

  test('the directory is loading, then failed with no copy, then ready; signed out it is ready with no hosts', async () => {
    // WHY: §3 Q2. There is no cached copy of the cloud machines.
    const directory = fakeDirectory()
    const catalog = catalogOf({ credentials: memoryCredentials([]), directory })
    expect(catalog.directoryState()).toBe('loading')
    await catalog.refreshDirectory()
    expect(catalog.directoryState()).toBe('failed')
    expect(catalog.workspaces()).toEqual([])

    directory.answer([directoryHostFor('m', { kind: 'managed', category: 'managed', managedState: 'ready' })])
    await catalog.refreshDirectory()
    expect(catalog.directoryState()).toBe('ready')
    expect([...catalog.managedHostIds()]).toEqual(['m'])

    directory.state.answer = null
    directory.state.signedOut = true
    await catalog.refreshDirectory()
    expect(catalog.directoryState()).toBe('ready')
    expect(ids(catalog)).toEqual([])
  })
})

describe('where the list is read', () => {
  const hostApi = { hostListRead: async () => [], hostListPut: async () => {}, hostListRemove: async () => {} }
  const documents = (async () => ({ kind: 'ok', document: { schemaVersion: 1, generation: 0, revision: null, hosts: {}, updatedAt: null } })) as unknown as AccountDocumentCall
  const memory = () => {
    const values = new Map<string, string>()
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) }
  }

  test('signed in, the account; signed out, the device host; with no device host, device storage', () => {
    // WHY: 031 D7 and the plan 033 §2 exception: one source at a time, never a second list.
    expect(hostListSourceFor({ accountDocuments: documents, deviceHost: { id: 'local', api: hostApi }, deviceStorage: memory() })?.key).toBe('account')
    expect(hostListSourceFor({ accountDocuments: null, deviceHost: { id: 'local', api: hostApi }, deviceStorage: memory() })?.key).toBe('host:local')
    expect(hostListSourceFor({ accountDocuments: null, deviceHost: null, deviceStorage: memory() })?.key).toBe('device')
    expect(hostListSourceFor({ accountDocuments: null, deviceHost: null, deviceStorage: null })).toBeNull()
  })

  test('the device source keeps the listings in device storage and reads them back', async () => {
    const storage = memory()
    const source = deviceHostListSource(storage)
    await source.put(listingFor('a'))
    await source.put(listingFor('b'))
    await source.remove('a')
    expect((await source.read())!.map((listing) => listing.id)).toEqual(['b'])
    storage.values.set(DEVICE_HOST_LIST_KEY, '{not json')
    expect(await source.read()).toEqual([])
  })

  test('signing in reads the account, and the hosts this device paired while signed out go to it; the credentials stay', async () => {
    // WHY: §4.1 "Sign in and sign out change the source. The credentials stay." With
    // §3 Q1 a host the new list does not name would otherwise be forgotten at sign-in.
    const journal: Journal = []
    const credentials = memoryCredentials(journal, { a: credentialFor('a') })
    const directory = fakeDirectory()
    directory.answer([])
    const catalog = catalogOf({ credentials, directory })
    await catalog.refreshDirectory()
    const local = fakeList(journal, 'host:local', [listingFor('a'), listingFor('other')])
    await catalog.useListSource(local.source)
    expect(ids(catalog)).toEqual(['a', 'other'])

    const account = fakeList(journal, 'account')
    await catalog.useListSource(account.source)
    expect(catalog.listSourceKey()).toBe('account')
    expect([...account.state.listings.keys()]).toEqual(['a'])
    expect(ids(catalog)).toEqual(['a'])
    expect(credentials.stored.has('a')).toBe(true)
    expect(journal).not.toContain('credential.remove a')
  })

  test('signing out after the account list failed to read keeps the hosts this device paired, and they go to the device list', async () => {
    // WHY: §3 Q1 deletes a credential only after a successful read of the source that
    // is active now. With no read of the account list it is not known which hosts it
    // names, so a sign-out must carry every pairing of this device, or the empty
    // device list and the signed-out directory would let Q1 delete them.
    const journal: Journal = []
    const credentials = memoryCredentials(journal, { a: credentialFor('a'), b: credentialFor('b') })
    const directory = fakeDirectory()
    directory.answer([])
    const catalog = catalogOf({ credentials, directory })
    await catalog.refreshDirectory()
    const account = fakeList(journal, 'account')
    account.state.failing = true
    await catalog.useListSource(account.source)
    expect(catalog.listState()).toBe('failed')

    directory.state.answer = null
    directory.state.signedOut = true
    const device = fakeList(journal, 'device')
    await catalog.useListSource(device.source)
    await catalog.refreshDirectory()
    expect(catalog.listState()).toBe('ready')
    expect(catalog.directoryState()).toBe('ready')
    expect([...credentials.stored.keys()].sort()).toEqual(['a', 'b'])
    expect([...device.state.listings.keys()].sort()).toEqual(['a', 'b'])
    expect(ids(catalog).sort()).toEqual(['a', 'b'])
    expect(journal.filter((entry) => entry.startsWith('credential.remove'))).toEqual([])
  })

  test('the first source gets no copy of the credentials: Q1 still forgets a host no answer names', async () => {
    // WHY: only a change of source carries pairings. At boot a credential the list does
    // not name was forgotten on another device, and Q1 deletes it.
    const journal: Journal = []
    const credentials = memoryCredentials(journal, { a: credentialFor('a'), gone: credentialFor('gone') })
    const directory = fakeDirectory()
    directory.answer([])
    const catalog = catalogOf({ credentials, directory })
    await catalog.refreshDirectory()
    await catalog.useListSource(fakeList(journal, 'account', [listingFor('a')]).source)
    expect([...credentials.stored.keys()]).toEqual(['a'])
  })

  test('another client of the device host changed the list: it is read again', async () => {
    const journal: Journal = []
    const catalog = catalogOf({ credentials: memoryCredentials(journal) })
    const list = fakeList(journal, 'host:local')
    await catalog.useListSource(list.source)
    list.state.listings.set('b', listingFor('b'))
    list.state.onChange?.()
    await catalog.refreshList()
    expect(ids(catalog)).toEqual(['b'])
  })
})

describe('§3 Q1: a credential no answer names', () => {
  test('is deleted after a successful read of the list and the directory', async () => {
    // WHY: a wipe, or a forget on another device, also forgets the host here.
    const journal: Journal = []
    const credentials = memoryCredentials(journal, { a: credentialFor('a'), gone: credentialFor('gone'), cloud: credentialFor('cloud') })
    const directory = fakeDirectory()
    directory.answer([directoryHostFor('cloud')])
    const catalog = catalogOf({ credentials, directory })
    const forgotten: string[] = []
    catalog.onForgotten((host) => forgotten.push(host.id))
    await catalog.useListSource(fakeList(journal, 'account', [listingFor('a')]).source)
    // The directory has not answered: nothing is deleted yet.
    expect([...credentials.stored.keys()].sort()).toEqual(['a', 'cloud', 'gone'])

    await catalog.refreshDirectory()
    expect([...credentials.stored.keys()].sort()).toEqual(['a', 'cloud'])
    expect(forgotten).toEqual(['gone'])
  })

  test('the host that served the page is never on its own list, and Q1 keeps its credential', async () => {
    // WHY: a host's list holds the hosts the person connected to from it, not the host
    // itself. The page's credential for its own host must survive a list that does not
    // name it, or each boot would delete it and the page could not dial its host.
    const journal: Journal = []
    const credentials = memoryCredentials(journal, { page: credentialFor('page'), gone: credentialFor('gone') })
    const directory = fakeDirectory()
    directory.state.signedOut = true
    const catalog = catalogOf({ credentials, directory })
    catalog.setDeviceHost('page')
    const own = fakeList(journal, 'host:page')
    await catalog.useListSource(own.source)
    await catalog.refreshDirectory()
    expect([...credentials.stored.keys()]).toEqual(['page'])
    expect(ids(catalog)).toEqual(['page'])
    expect(catalog.find('page')?.sessionToken).toBe('token-page')

    // Paired again at the page's address: the credential changes, the list does not.
    const { listError } = await catalog.pair(pairedHost('page', { sessionToken: 'token-page-2' }))
    expect(listError).toBeNull()
    expect(credentials.stored.get('page')?.token).toBe('token-page-2')
    expect(own.state.listings.size).toBe(0)

    // Signing in does not carry it to the account list either.
    const account = fakeList(journal, 'account')
    await catalog.useListSource(account.source)
    expect(account.state.listings.size).toBe(0)
    expect(journal.filter((entry) => entry.endsWith('.put page'))).toEqual([])
    expect(credentials.stored.has('page')).toBe(true)
  })

  test('a failed read deletes nothing', async () => {
    const journal: Journal = []
    const credentials = memoryCredentials(journal, { a: credentialFor('a') })
    const directory = fakeDirectory()
    const catalog = catalogOf({ credentials, directory })
    const list = fakeList(journal, 'account')
    list.state.failing = true
    await catalog.useListSource(list.source)
    await catalog.refreshDirectory()
    expect(catalog.listState()).toBe('failed')
    expect(catalog.directoryState()).toBe('failed')
    expect([...credentials.stored.keys()]).toEqual(['a'])

    // The list answers, but the directory still has not: still nothing.
    list.state.failing = false
    await catalog.refreshList()
    expect([...credentials.stored.keys()]).toEqual(['a'])
    expect(journal).toEqual([])
  })
})

describe('pair and forget', () => {
  test('pair writes the credential, then puts the listing; the listing never carries the token', async () => {
    const journal: Journal = []
    const catalog = catalogOf({ credentials: memoryCredentials(journal), directory: null })
    const list = fakeList(journal, 'host:local')
    await catalog.useListSource(list.source)
    const { host, listError } = await catalog.pair(pairedHost('a'))
    expect(listError).toBeNull()
    expect(journal).toEqual(['credential.write a', 'host:local.put a'])
    expect(host).toMatchObject({ id: 'a', sessionToken: 'token-a', label: 'Host a', os: 'macos' })
    expect(JSON.stringify(list.state.listings.get('a'))).not.toContain('token-a')
  })

  test('a listing the list refused stays shown, and goes to the list at the next read instead of being forgotten', async () => {
    const journal: Journal = []
    const credentials = memoryCredentials(journal)
    const catalog = catalogOf({ credentials, directory: null })
    const list = fakeList(journal, 'account')
    await catalog.useListSource(list.source)
    list.state.failing = true
    const { listError } = await catalog.pair(pairedHost('a'))
    expect(listError?.message).toBe('offline')
    expect(ids(catalog)).toEqual(['a'])

    list.state.failing = false
    await catalog.refresh()
    expect(journal).toEqual(['credential.write a', 'account.put a'])
    expect(credentials.stored.has('a')).toBe(true)
  })

  test('a host paired again at the same address after a reinstall replaces the old one', async () => {
    const journal: Journal = []
    const catalog = catalogOf({ credentials: memoryCredentials(journal), directory: null })
    await catalog.useListSource(fakeList(journal, 'host:local').source)
    await catalog.pair(pairedHost('old', { routes: [{ kind: 'lan', url: 'http://studio.lan:3000', source: 'pairing', seenAt: 1 }] }))
    await catalog.pair(pairedHost('new', { routes: [{ kind: 'lan', url: 'http://studio.lan:3000', source: 'pairing', seenAt: 2 }] }))
    expect(ids(catalog)).toEqual(['new'])
  })

  test('a listing is named by its installation id and no other', () => {
    // WHY: one host with two ids showed as two rows, and a pairing reached only one of them.
    expect(hostListingSchema.safeParse(listingFor('a')).success).toBe(true)
    expect(hostListingSchema.safeParse(listingFor('directory-a', { installationId: 'a' })).success).toBe(false)
  })

  test('a token refresh that ends after a new pairing keeps the new pairing', async () => {
    // WHY: the transport reads the token here at each dial; an old renewal must not replace the pairing that came after it.
    const catalog = catalogOf({ credentials: memoryCredentials([]), directory: null })
    await catalog.useListSource(fakeList([], 'host:local').source)
    await catalog.pair(pairedHost('a'))
    await catalog.pair(pairedHost('a', { sessionToken: 'token-new' }))

    await catalog.renewToken('a', 'token-a', 'token-a-renewed')
    expect(catalog.sessionTokenOf('a')).toBe('token-new')

    await catalog.renewToken('a', 'token-new', 'token-new-renewed')
    expect(catalog.sessionTokenOf('a')).toBe('token-new-renewed')
  })

  test('forget removes the listing, then deletes the credential; a list that does not answer deletes nothing', async () => {
    const journal: Journal = []
    const credentials = memoryCredentials(journal)
    const catalog = catalogOf({ credentials, directory: null })
    const list = fakeList(journal, 'host:local')
    await catalog.useListSource(list.source)
    await catalog.pair(pairedHost('a'))
    journal.length = 0

    list.state.failing = true
    await expect(catalog.forget('a')).rejects.toThrow('offline')
    expect(credentials.stored.has('a')).toBe(true)
    expect(ids(catalog)).toEqual(['a'])

    list.state.failing = false
    await catalog.forget('a')
    expect(journal).toEqual(['host:local.remove a', 'credential.remove a'])
    expect(ids(catalog)).toEqual([])
  })
})

describe('device storage', () => {
  test('holds the credentials and nothing else about a host', async () => {
    // WHY: §2 rule 2. A wiped database must not leave hosts shown from the device.
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) }
    const directory = fakeDirectory()
    directory.answer([directoryHostFor('a', { organizationIds: ['org-1'] }), directoryHostFor('m', { kind: 'managed', category: 'managed', managedState: 'ready' })], [
      { organizationId: 'org-1', label: 'Acme', routes: [{ kind: 'tunnel', url: 'https://workspace.solus.test' }], isActive: true, hostRules: DEFAULT_HOST_RULES },
    ])
    const catalog = new HostCatalog({ credentials: localStorageCredentials(() => storage), directory: () => directory.reader, now: () => 10, clientOrigin: () => '' })
    await catalog.useListSource(fakeList([], 'account').source)
    await catalog.refreshDirectory()
    await catalog.pair(pairedHost('a', { label: 'Studio Mac', os: 'linux' }))
    catalog.touchLastConnected('a')
    catalog.stampOperatingSystem('a', 'windows')
    catalog.applyDiscovered([{ host: '192.168.1.9', port: 3000, name: 'Studio', installationId: 'a', source: 'lan' }])
    await Promise.resolve()

    expect([...values.keys()]).toEqual([HOST_CREDENTIALS_KEY])
    const stored = values.get(HOST_CREDENTIALS_KEY)!
    for (const hostFact of ['Studio Mac', 'linux', 'windows', 'org-1', 'Acme', 'cloud-a', 'directory', 'lastConnected', '"m"']) {
      expect(stored).not.toContain(hostFact)
    }
    expect(stored).toContain('token-a')
    expect(stored).toContain('http://192.168.1.9:3000')
  })
})
