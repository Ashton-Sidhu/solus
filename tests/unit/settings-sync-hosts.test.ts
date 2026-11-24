import { describe, expect, test } from 'bun:test'
import { SettingsSyncHosts, type SettingsSyncHost } from '@solus/client-core/settings-sync-hosts'
import type { DocumentSyncStorage } from '@solus/client-core/document-sync'
import { HostRpcError } from '@solus/client-core/rpc-error'
import {
  DEFAULT_HOST_CONFIG,
  HOST_CONFIG_KEYS,
  MACHINE_HOST_CONFIG_KEYS,
  SHARED_HOST_CONFIG_KEYS,
  mergeHostConfig,
  type HostConfigPatch,
} from '@solus/contracts/host-config'
import { CONFIGURABLE_SOLUS_TOOL_NAMES } from '@solus/contracts/agent-tools'
import { CLIENT_DEVICE_LAYOUT_KEYS, type HostPersonalSettings, type PersonalSettingsDocument } from '@solus/contracts/settings'

// docs/plans/settings-sync-hosts.md: signed out, a person's server settings (their
// personal settings on a host and the shared host settings) are the same on each of
// their hosts whose Sync settings switch is on. The client copies them to a host the
// person adds with Sync settings on, and sends each later change to the other synced
// hosts, now or when a host is back. Machine-bound host keys and device settings never
// move, and signed in nothing moves host to host: the account keeps them the same.

/** One host: the person's copy and switch there, and the host's config. */
function fakeHost(hostId: string, options: { settings?: PersonalSettingsDocument; config?: HostConfigPatch; syncSettings?: boolean; isAdmin?: boolean } = {}) {
  const personal: HostPersonalSettings = { settings: options.settings ?? {}, source: 'host', followsAccount: false, accountRevision: null, updatedAt: null, syncSettings: options.syncSettings ?? true }
  const host = {
    hostId,
    personal,
    config: mergeHostConfig(DEFAULT_HOST_CONFIG, options.config ?? {}),
    isAdmin: options.isAdmin ?? true,
    configPatches: [] as HostConfigPatch[],
    refuseConfig: false,
    sync: null as unknown as SettingsSyncHost,
  }
  host.sync = {
    mayWriteHostConfig: () => host.isAdmin,
    api: {
      personalSettingsGet: async () => structuredClone(personal),
      personalSettingsPatch: async (change) => {
        for (const key of change.reset) delete personal.settings[key]
        Object.assign(personal.settings, structuredClone(change.set))
        return { settings: structuredClone(personal), ignored: [] }
      },
      personalSettingsSyncSet: async (syncSettings) => {
        personal.syncSettings = syncSettings
        return structuredClone(personal)
      },
      configGet: async () => ({ config: structuredClone(host.config) }),
      configUpdate: async (patch) => {
        if (host.refuseConfig) throw new HostRpcError('Setting managed', 'SETTING_MANAGED')
        host.configPatches.push(structuredClone(patch))
        host.config = mergeHostConfig(host.config, patch)
        return { config: structuredClone(host.config) }
      },
    },
  }
  return host
}

type FakeHost = ReturnType<typeof fakeHost>

function memoryStorage(): DocumentSyncStorage {
  const items = new Map<string, string>()
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value) }, removeItem: (key) => { items.delete(key) } }
}

/** A client: the hosts it knows, which are ready, its home host, and whether the person is signed in. */
function client(world: { hosts: FakeHost[]; home: string | null; signedIn?: boolean; storage?: DocumentSyncStorage }) {
  const view = { ready: new Set(world.hosts.map((host) => host.hostId)), signedIn: world.signedIn ?? false }
  const sync = new SettingsSyncHosts({
    knownHostIds: () => world.hosts.map((host) => host.hostId),
    readyHost: (hostId) => view.ready.has(hostId) ? world.hosts.find((host) => host.hostId === hostId)?.sync ?? null : null,
    isSignedIn: () => view.signedIn,
    copySourceId: () => world.home,
    storage: world.storage ?? memoryStorage(),
  })
  return { sync, view }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('the host setting keys', () => {
  test('each host config key is either shared or bound to one machine', () => {
    // WHY: a new host config key must be put in one list on purpose; one that names a path, a port, or a binary must never spread.
    expect([...SHARED_HOST_CONFIG_KEYS, ...MACHINE_HOST_CONFIG_KEYS].sort()).toEqual([...HOST_CONFIG_KEYS].sort())
    expect(SHARED_HOST_CONFIG_KEYS.filter((key) => (MACHINE_HOST_CONFIG_KEYS as readonly string[]).includes(key))).toEqual([])
  })
})

describe('pairing a host', () => {
  test('with Sync settings on, the new host takes the server settings of the home host, and never a machine-bound key', async () => {
    const home = fakeHost('home', {
      settings: { themeMode: 'dark', extraInstructions: 'Be brief.' },
      config: { solusTools: { [CONFIGURABLE_SOLUS_TOOL_NAMES[0]!]: false }, archivedAutomationRetentionDays: 7, otel: { enabled: true, endpoint: 'https://collector.example' }, previewTunnelEnabled: false, agentAutoUpdates: false, reviewWarmingByProject: { '/home/me/project': true } },
    })
    const added = fakeHost('added', { settings: { fontSize: 18 }, syncSettings: false })
    const { sync } = client({ hosts: [home, added], home: 'home' })
    sync.hostAdded('added', { syncSettings: true })
    await settle()

    expect(added.personal.syncSettings).toBe(true)
    // The personal copy is equal to the home host's: a key set only on the new host returns to its default.
    expect(added.personal.settings).toEqual({ themeMode: 'dark', extraInstructions: 'Be brief.' })
    expect(added.config.archivedAutomationRetentionDays).toBe(7)
    expect(added.config.solusTools).toEqual({ [CONFIGURABLE_SOLUS_TOOL_NAMES[0]!]: false })
    expect(added.config.otel.endpoint).toBe('https://collector.example')
    const sentKeys = new Set(added.configPatches.flatMap((patch) => Object.keys(patch)))
    for (const key of MACHINE_HOST_CONFIG_KEYS) expect(sentKeys.has(key)).toBe(false)
    expect(added.config.previewTunnelEnabled).toBe(DEFAULT_HOST_CONFIG.previewTunnelEnabled)
    expect(added.config.reviewWarmingByProject).toEqual({})
    // A device setting is not a server setting: the host's copy never holds one.
    for (const key of CLIENT_DEVICE_LAYOUT_KEYS) expect(Object.hasOwn(added.personal.settings, key)).toBe(false)
  })

  test('with Sync settings off, nothing is copied and the switch is off', async () => {
    const home = fakeHost('home', { settings: { themeMode: 'dark' }, config: { archivedAutomationRetentionDays: 7 } })
    const added = fakeHost('added')
    const { sync } = client({ hosts: [home, added], home: 'home' })
    sync.hostAdded('added', { syncSettings: false })
    await settle()

    expect(added.personal.syncSettings).toBe(false)
    expect(added.personal.settings).toEqual({})
    expect(added.configPatches).toEqual([])
    expect(sync.switchOf('added')).toBe(false)
  })

  test('a new host that is not ready yet takes the copy when it is', async () => {
    const home = fakeHost('home', { settings: { themeMode: 'dark' } })
    const added = fakeHost('added')
    const storage = memoryStorage()
    const first = client({ hosts: [home, added], home: 'home', storage })
    first.view.ready.delete('added')
    first.sync.hostAdded('added', { syncSettings: true })
    await settle()
    expect(added.personal.settings).toEqual({})

    // The client restarts; the copy waited in its storage.
    const second = client({ hosts: [home, added], home: 'home', storage })
    second.sync.refresh()
    await settle()
    expect(added.personal.settings).toEqual({ themeMode: 'dark' })
  })

  test('host settings go only to a host where the person is host administrator', async () => {
    const home = fakeHost('home', { settings: { themeMode: 'dark' }, config: { archivedAutomationRetentionDays: 7 } })
    const added = fakeHost('added', { isAdmin: false })
    const { sync } = client({ hosts: [home, added], home: 'home' })
    sync.hostAdded('added', { syncSettings: true })
    await settle()
    expect(added.personal.settings).toEqual({ themeMode: 'dark' })
    expect(added.configPatches).toEqual([])
  })
})

describe('later changes', () => {
  test('a change on a synced host goes to the hosts with the switch on, not to a host with it off', async () => {
    const home = fakeHost('home')
    const synced = fakeHost('synced')
    const own = fakeHost('own', { settings: { themeMode: 'light' }, syncSettings: false })
    const { sync } = client({ hosts: [home, synced, own], home: 'home' })
    sync.refresh()
    await settle()

    sync.personalChanged('home', { set: { themeMode: 'dark' }, reset: [] })
    sync.hostConfigChanged('home', { analyticsEnabled: false, previewTunnelEnabled: false })
    await settle()

    expect(synced.personal.settings).toEqual({ themeMode: 'dark' })
    expect(synced.configPatches).toEqual([{ analyticsEnabled: false }])
    expect(own.personal.settings).toEqual({ themeMode: 'light' })
    expect(own.configPatches).toEqual([])
  })

  test('a change on a host whose switch is off stays on that host', async () => {
    const home = fakeHost('home')
    const own = fakeHost('own', { syncSettings: false })
    const { sync } = client({ hosts: [home, own], home: 'home' })
    sync.refresh()
    await settle()
    sync.personalChanged('own', { set: { themeMode: 'dark' }, reset: [] })
    await settle()
    expect(home.personal.settings).toEqual({})
  })

  test('a host that is away during a change gets it when it is back, after a client restart too', async () => {
    const home = fakeHost('home')
    const away = fakeHost('away', { settings: { themeMode: 'light', fontSize: 18 } })
    const storage = memoryStorage()
    const first = client({ hosts: [home, away], home: 'home', storage })
    first.view.ready.delete('away')
    first.sync.personalChanged('home', { set: { themeMode: 'dark' }, reset: ['fontSize'] })
    first.sync.hostConfigChanged('home', { unfiledRecordingRetentionDays: 9 })
    first.sync.personalChanged('home', { set: { extraInstructions: 'Later.' }, reset: [] })
    await settle()
    expect(away.personal.settings).toEqual({ themeMode: 'light', fontSize: 18 })

    const second = client({ hosts: [home, away], home: 'home', storage })
    second.sync.refresh()
    await settle()
    expect(away.personal.settings).toEqual({ themeMode: 'dark', extraInstructions: 'Later.' })
    expect(away.config.unfiledRecordingRetentionDays).toBe(9)

    // Sent once: a later refresh sends nothing again.
    const patches = away.configPatches.length
    second.sync.refresh()
    await settle()
    expect(away.configPatches.length).toBe(patches)
  })

  test('two changes of one field each of a nested host setting both reach a host that was away', async () => {
    // WHY: the Telemetry panel sends one field of otel at a time; a later change must not drop an earlier one.
    const home = fakeHost('home')
    const away = fakeHost('away')
    const { sync, view } = client({ hosts: [home, away], home: 'home' })
    view.ready.delete('away')
    sync.hostConfigChanged('home', { otel: { endpoint: 'https://collector.example' } })
    sync.hostConfigChanged('home', { otel: { exportTraces: false } })
    view.ready.add('away')
    sync.refresh()
    await settle()
    expect(away.config.otel).toMatchObject({ endpoint: 'https://collector.example', exportTraces: false })
  })

  test('a host whose switch was turned off while it was away keeps its own settings', async () => {
    const home = fakeHost('home')
    const away = fakeHost('away')
    const { sync, view } = client({ hosts: [home, away], home: 'home' })
    view.ready.delete('away')
    sync.personalChanged('home', { set: { themeMode: 'dark' }, reset: [] })
    away.personal.syncSettings = false
    view.ready.add('away')
    sync.refresh()
    await settle()
    expect(away.personal.settings).toEqual({})
    expect(sync.switchOf('away')).toBe(false)
  })

  test('a host config change that a host refuses is not tried again', async () => {
    const home = fakeHost('home')
    const locked = fakeHost('locked')
    locked.refuseConfig = true
    const { sync } = client({ hosts: [home, locked], home: 'home' })
    sync.hostConfigChanged('home', { analyticsEnabled: false })
    await settle()
    locked.refuseConfig = false
    sync.refresh()
    await settle()
    expect(locked.configPatches).toEqual([])
  })
})

describe('signed in', () => {
  test('nothing is copied or spread host to host: the account keeps them the same', async () => {
    const home = fakeHost('home', { settings: { themeMode: 'dark' } })
    const added = fakeHost('added')
    const { sync } = client({ hosts: [home, added], home: 'home', signedIn: true })
    sync.hostAdded('added', { syncSettings: true })
    sync.personalChanged('home', { set: { extraInstructions: 'Hi.' }, reset: [] })
    sync.hostConfigChanged('home', { analyticsEnabled: false })
    sync.refresh()
    await settle()
    expect(added.personal.settings).toEqual({})
    expect(added.configPatches).toEqual([])
  })
})

describe('the switch', () => {
  test("turning it off drops what waits for the host, and the host's own settings stay", async () => {
    const home = fakeHost('home')
    const other = fakeHost('other', { settings: { themeMode: 'light' } })
    const { sync, view } = client({ hosts: [home, other], home: 'home' })
    view.ready.delete('other')
    sync.personalChanged('home', { set: { themeMode: 'dark' }, reset: [] })
    view.ready.add('other')
    await sync.setSwitch('other', false)
    sync.refresh()
    await settle()
    expect(other.personal.settings).toEqual({ themeMode: 'light' })
    expect(other.personal.syncSettings).toBe(false)
  })
})
