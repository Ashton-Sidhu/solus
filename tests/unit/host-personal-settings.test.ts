import { describe, expect, test } from 'bun:test'
import { PersonalSettingsHosts, personalSettingsHomeId, type PersonalSettingsHost } from '@solus/client-core/host-personal-settings'
import type { DocumentSyncStorage } from '@solus/client-core/document-sync'
import type { HostPersonalSettings, PersonalSettingsDocument, PersonalSettingsPatch } from '@solus/contracts/settings'

// ADR 0007, docs/plans/personal-settings-source.md: a client shows a signed-out
// person the settings of their home host and writes their changes there; signed
// in, it asks each host to pull the account's copy, and writes that copy to a
// host that holds no token for the person.

/** One host's copy of one person's settings, as its RPCs answer. */
function fakeHost(hostId: string, options: { followsAccount?: boolean; settings?: PersonalSettingsDocument } = {}) {
  const state: HostPersonalSettings = { settings: options.settings ?? {}, source: 'host', followsAccount: options.followsAccount ?? false, accountRevision: null, updatedAt: null }
  const calls: string[] = []
  const patches: PersonalSettingsPatch[] = []
  const host: PersonalSettingsHost & { state: HostPersonalSettings; calls: string[]; patches: PersonalSettingsPatch[] } = {
    hostId,
    state,
    calls,
    patches,
    api: {
      personalSettingsGet: async () => {
        calls.push('get')
        return structuredClone(state)
      },
      personalSettingsPatch: async (change) => {
        calls.push('patch')
        patches.push(structuredClone(change))
        for (const key of change.reset) delete state.settings[key]
        Object.assign(state.settings, structuredClone(change.set))
        return { settings: structuredClone(state), ignored: [] }
      },
      personalSettingsChanged: async () => {
        calls.push('changed')
        return structuredClone(state)
      },
    },
  }
  return host
}

function memoryStorage(): DocumentSyncStorage {
  const items = new Map<string, string>()
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value) }, removeItem: (key) => { items.delete(key) } }
}

/** A client: what it shows, who is signed in, and which hosts are ready. */
function client(world: { hosts: ReturnType<typeof fakeHost>[]; home: string | null; signedIn: boolean; storage?: DocumentSyncStorage; shown?: PersonalSettingsDocument }) {
  const view = { shown: world.shown ?? {}, ready: new Set(world.hosts.map((host) => host.hostId)) }
  const sync = new PersonalSettingsHosts({
    readyHosts: () => world.hosts.filter((host) => view.ready.has(host.hostId)),
    homeHostId: () => world.home,
    isSignedIn: () => world.signedIn,
    document: () => view.shown,
    adoptHostCopy: (settings) => { view.shown = settings },
    storage: world.storage ?? memoryStorage(),
  })
  return { sync, view }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('signed out: the home host is the source', () => {
  test("the client shows the home host's copy, and a change goes to that host only", async () => {
    // WHY: ADR 0007 decision 2. Each host keeps its own set; a change on one host stays on that host.
    const home = fakeHost('home', { settings: { themeMode: 'dark' } })
    const other = fakeHost('other', { settings: { themeMode: 'light' } })
    const { sync, view } = client({ hosts: [home, other], home: 'home', signedIn: false })
    sync.refresh()
    await settle()
    expect(view.shown).toEqual({ themeMode: 'dark' })

    sync.recordLocalChange({ set: { extraInstructions: 'Be brief.' }, reset: [] })
    await settle()
    expect(home.state.settings).toEqual({ themeMode: 'dark', extraInstructions: 'Be brief.' })
    expect(other.calls).toEqual([])
  })

  test('a change made while the home host is away waits, survives a client restart, and goes when the host is back', async () => {
    const storage = memoryStorage()
    const home = fakeHost('home', { settings: { themeMode: 'dark' } })
    const first = client({ hosts: [home], home: 'home', signedIn: false, storage })
    first.view.ready.clear()
    first.sync.recordLocalChange({ set: { fontSize: 18 }, reset: ['themeMode'] })
    await settle()
    expect(home.calls).toEqual([])

    // The client restarts; the host comes back.
    const second = client({ hosts: [home], home: 'home', signedIn: false, storage })
    second.sync.refresh()
    await settle()
    expect(home.patches).toEqual([{ set: { fontSize: 18 }, reset: ['themeMode'] }])
    expect(home.state.settings).toEqual({ fontSize: 18 })
    expect(second.view.shown).toEqual({ fontSize: 18 })
  })

  test("another client's change on the home host reaches this client when the host says so", async () => {
    const home = fakeHost('home', { settings: {} })
    const { sync, view } = client({ hosts: [home], home: 'home', signedIn: false })
    sync.refresh()
    await settle()
    home.state.settings = { sidebarView: 'project' }
    sync.hostChanged('other-host')
    await settle()
    expect(view.shown).toEqual({})
    sync.hostChanged('home')
    await settle()
    expect(view.shown).toEqual({ sidebarView: 'project' })
  })

  test('the home host is the device host, else the default host, and never a Solus API', () => {
    expect(personalSettingsHomeId({ deviceHostId: 'desk', defaultServerId: 'vm' })).toBe('desk')
    expect(personalSettingsHomeId({ deviceHostId: null, defaultServerId: 'vm' })).toBe('vm')
    expect(personalSettingsHomeId({ deviceHostId: null, defaultServerId: 'workspace:org-1' })).toBeNull()
  })
})

describe('signed in: the account is the source', () => {
  test('a host that follows the account is only asked to pull; a host with no token gets the copy from the client', async () => {
    // WHY: ADR 0007 decisions 4 and 5.
    const following = fakeHost('following', { followsAccount: true, settings: { themeMode: 'light' } })
    const tokenless = fakeHost('tokenless', { followsAccount: false, settings: { themeMode: 'light', fontSize: 20 } })
    const { sync } = client({ hosts: [following, tokenless], home: 'following', signedIn: true, shown: { themeMode: 'dark', extraInstructions: 'Mine.' } })
    sync.refresh()
    await settle()
    expect(following.calls).toEqual(['changed'])
    expect(tokenless.calls).toEqual(['changed', 'patch'])
    expect(tokenless.state.settings).toEqual({ themeMode: 'dark', extraInstructions: 'Mine.' })

    // Nothing new: a reconnect of another host does not ask again.
    sync.refresh()
    await settle()
    expect(tokenless.calls).toEqual(['changed', 'patch'])
  })

  test('a change of the account copy reaches each host again', async () => {
    const tokenless = fakeHost('tokenless')
    const world = { hosts: [tokenless], home: null, signedIn: true, shown: { themeMode: 'dark' } as PersonalSettingsDocument }
    const { sync, view } = client(world)
    sync.refresh()
    await settle()
    view.shown = { themeMode: 'light' }
    sync.accountChanged()
    await settle()
    expect(tokenless.state.settings).toEqual({ themeMode: 'light' })
  })

  test('a Solus API is never asked: it runs no work', async () => {
    const api = fakeHost('workspace:org-1')
    const { sync } = client({ hosts: [api], home: null, signedIn: true, shown: { themeMode: 'dark' } })
    sync.refresh()
    await settle()
    expect(api.calls).toEqual([])
  })
})
