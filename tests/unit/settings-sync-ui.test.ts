import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  CLIENT_DEVICE_LAYOUT_KEYS,
  type AccountSettingsPatchRequest,
  type AccountSettingsResponse,
  type OrganizationSettingsResponse,
  type PersonalSettingsDocument,
} from '@solus/contracts/settings'
import type { HostConfigSnapshot } from '@solus/contracts/host-config'
import { DEFAULT_HOST_CONFIG } from '@solus/contracts/host-config'
import type { SettingsCloudRequests } from '@solus/client-core/settings-requests'
import type { OrganizationSettingsClient } from '@solus/client-core/settings-sync'
import { singleHostServerConnections } from './helpers/server-connections-mock'

// plans/018 Stage 5, the shared desktop and web stores: sync is off until the
// person turns it on here; signing in alone sends nothing; client analytics
// consent is this device's own; choosing another host changes no personal value; and an owner's Sync all Insights draft saves against the
// revision read, keeping the draft on a conflict.

const hostConfigs = new Map<string, HostConfigSnapshot>()
const hostWrites: Array<{ serverId: string; patch: unknown }> = []
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    ...singleHostServerConnections(),
    connectedServerIds: () => [...hostConfigs.keys()],
    onStatusChange: () => () => {},
    apiFor: (serverId: string) => ({
      configGet: async () => hostConfigs.get(serverId),
      configUpdate: async (patch: unknown) => {
        hostWrites.push({ serverId, patch })
        return hostConfigs.get(serverId)
      },
    }),
  },
}))
mock.module('@solus/client-core/local-api', () => ({ localApi: {} }))
mock.module('@solus/client-core/host-events', () => ({ subscribeAllHosts: () => () => {} }))

type Globals = Record<'window' | 'document' | 'localStorage' | 'navigator' | '$state', unknown>
const previous: Partial<Globals> = {}
const GLOBAL_KEYS = ['window', 'document', 'localStorage', 'navigator', '$state'] as const
const globals = globalThis as unknown as Globals

type MemoryStorage = Storage & { items: Map<string, string> }

function memoryStorage(seed: Record<string, string> = {}): MemoryStorage {
  const items = new Map(Object.entries(seed))
  return {
    items,
    get length() { return items.size },
    key: (index: number) => [...items.keys()][index] ?? null,
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

function installDom(storage: Storage) {
  const style = { setProperty() {} }
  globals.window = { addEventListener() {}, removeEventListener() {} }
  globals.document = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
    documentElement: { classList: { toggle() {}, contains: () => false }, style },
    body: { style },
    querySelectorAll: () => [],
    querySelector: () => null,
  }
  globals.localStorage = storage
  globals.navigator = { userAgent: 'Macintosh', platform: 'MacIntel', onLine: true }
  globals.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => structuredClone(value) })
}

beforeEach(() => {
  for (const key of GLOBAL_KEYS) previous[key] = globals[key]
  hostConfigs.clear()
  hostWrites.length = 0
})

afterEach(() => {
  for (const key of GLOBAL_KEYS) {
    if (previous[key] === undefined) delete globals[key]
    else globals[key] = previous[key]
  }
})

async function settingsOn(storage: MemoryStorage = memoryStorage()) {
  installDom(storage)
  const { SettingsContext } = await import('@solus/workspace-ui/contexts/app/settings.context.svelte')
  return new SettingsContext(storage)
}

function profileOf(storage: MemoryStorage, accountKey = 'anonymous'): PersonalSettingsDocument {
  return JSON.parse(storage.getItem(`solus.personal-settings.v1:${accountKey}`) ?? '{}')
}

/** The account settings endpoint for one signed-in user: a compare-and-swap document, and a log of what was sent. */
function fakeAccount() {
  const sent: AccountSettingsPatchRequest[] = []
  const document: AccountSettingsResponse = { schemaVersion: 1, generation: 0, revision: null, settings: {}, updatedAt: null }
  const requests: Pick<SettingsCloudRequests, 'accountSettingsGet' | 'accountSettingsPatch' | 'accountSettingsDelete'> = {
    accountSettingsGet: async () => ({ kind: 'ok', settings: structuredClone(document) }),
    accountSettingsPatch: async (request) => {
      sent.push(structuredClone(request))
      if (request.expectedRevision !== document.revision) return { kind: 'conflict', reason: 'settings_conflict', current: structuredClone(document) }
      document.settings = { ...document.settings, ...request.set }
      for (const key of request.reset ?? []) delete document.settings[key]
      document.revision = (document.revision ?? 0) + 1
      return { kind: 'ok', settings: structuredClone(document) }
    },
    accountSettingsDelete: async () => {
      document.generation += 1
      document.revision = null
      document.settings = {}
      return { kind: 'ok', settings: structuredClone(document) }
    },
  }
  return { sent, document, requests }
}

const quietPorts = {
  environment: { isOnline: () => true, isForeground: () => false, subscribe: () => () => {} },
  clock: { now: () => 1_000, setTimer: (callback: () => void) => { queueMicrotask(callback); return () => {} } },
  broadcast: undefined,
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('consent and sign-in', () => {
  test('sync is off by default and signing in sends nothing, even after an edit', async () => {
    const storage = memoryStorage()
    const settings = await settingsOn(storage)
    const { SettingsSyncStore } = await import('@solus/workspace-ui/contexts/app/settings-sync.store.svelte')
    const sync = new SettingsSyncStore()
    const cloud = fakeAccount()
    sync.start(settings.personal, { ...quietPorts, requests: cloud.requests, storage })
    expect(sync.status.state).toBe('signed-out')

    sync.setAccount({ origin: 'https://solus.test', userId: 'user-a' })
    expect(sync.status.state).toBe('off')
    settings.setPersonal('themeMode', 'dark')
    await flush()
    expect(cloud.sent).toEqual([])
    expect(sync.status.pendingKeys).toEqual([])
  })

  test('client analytics stays undecided, and so off, on a fresh install', async () => {
    const settings = await settingsOn()
    expect(settings.clientAnalyticsEnabled).toBeNull()
  })

  test('turning sync on reads first, then seeds only what the person chose', async () => {
    const storage = memoryStorage()
    const settings = await settingsOn(storage)
    const { SettingsSyncStore } = await import('@solus/workspace-ui/contexts/app/settings-sync.store.svelte')
    const sync = new SettingsSyncStore()
    const cloud = fakeAccount()
    sync.start(settings.personal, { ...quietPorts, requests: cloud.requests, storage })
    sync.setAccount({ origin: 'https://solus.test', userId: 'user-a' })
    settings.setPersonal('extraInstructions', 'Keep answers short.')

    await sync.beginEnable()
    expect(sync.offer?.kind).toBe('absent')
    expect(cloud.sent).toEqual([])
    await sync.choose('seed')
    expect(sync.offer).toBeNull()
    expect(cloud.sent).toHaveLength(1)
    expect(cloud.sent[0].expectedRevision).toBeNull()
    expect(cloud.document.settings.extraInstructions).toBe('Keep answers short.')
    expect(sync.status.state).toBe('synced')
  })
})

describe('account isolation', () => {
  test('a first sign-in starts from the anonymous profile; sign-out restores it and removes the account profile', async () => {
    const storage = memoryStorage()
    const settings = await settingsOn(storage)
    const { SettingsSyncStore } = await import('@solus/workspace-ui/contexts/app/settings-sync.store.svelte')
    const sync = new SettingsSyncStore()
    sync.start(settings.personal, { ...quietPorts, requests: fakeAccount().requests, storage })
    settings.setPersonal('themeMode', 'dark')

    sync.setAccount({ origin: 'https://solus.test', userId: 'user-a' })
    expect(settings.themeMode).toBe('dark')
    settings.setPersonal('leadInstructions', 'Account only.')
    expect(profileOf(storage, 'https://solus.test|user-a').leadInstructions).toBe('Account only.')

    sync.setAccount(null)
    expect(settings.leadInstructions).toBe('')
    expect(profileOf(storage).leadInstructions).toBeUndefined()
    expect(storage.getItem('solus.personal-settings.v1:https://solus.test|user-a')).toBeNull()
  })
})

describe('client analytics', () => {
  test('the client analytics switch changes this device only', async () => {
    hostConfigs.set('host-a', { typeSafe: { source: null }, config: DEFAULT_HOST_CONFIG })
    const settings = await settingsOn()
    settings.setClientAnalyticsEnabled(false)
    await flush()
    expect(settings.clientAnalyticsEnabled).toBe(false)
    expect(hostWrites).toEqual([])
  })
})

describe('hosts', () => {
  test('reading another host changes no personal value, and review warming is that host’s', async () => {
    const settings = await settingsOn()
    settings.setPersonal('themeMode', 'dark')
    settings.setPersonal('defaultPermissionMode', 'supervised')
    hostConfigs.set('host-a', { typeSafe: { source: null }, config: { ...DEFAULT_HOST_CONFIG, reviewWarmingByProject: { '/repo': true } } })
    hostConfigs.set('host-b', { typeSafe: { source: null }, config: { ...DEFAULT_HOST_CONFIG, reviewWarmingByProject: {} } })
    const { hostSettingsStore } = await import('@solus/workspace-ui/contexts/app/host-settings.store.svelte')
    await hostSettingsStore.load('host-a')
    await hostSettingsStore.load('host-b')

    expect(settings.themeMode).toBe('dark')
    expect(settings.defaultPermissionMode).toBe('supervised')
    expect(settings.ctxForProject('host-a', '/repo').reviewWarmingEnabled).toBe(true)
    expect(settings.ctxForProject('host-b', '/repo').reviewWarmingEnabled).toBe(false)
    expect(hostWrites).toEqual([])
  })

  test('the host analytics switch reads and writes only the host emitter’s consent', async () => {
    hostConfigs.set('host-a', { typeSafe: { source: null }, config: { ...DEFAULT_HOST_CONFIG, analyticsEnabled: true } })
    const settings = await settingsOn()
    const { hostSettingsStore } = await import('@solus/workspace-ui/contexts/app/host-settings.store.svelte')
    await hostSettingsStore.load('host-a')
    expect(hostSettingsStore.states.get('host-a')?.analyticsEnabled).toBe(true)
    await hostSettingsStore.setHostAnalyticsEnabled('host-a', false)
    expect(hostWrites).toEqual([{ serverId: 'host-a', patch: { analyticsEnabled: false } }])
    expect(settings.clientAnalyticsEnabled).toBeNull()
  })
})

describe('organization settings', () => {
  function response(overrides: Partial<OrganizationSettingsResponse> = {}): OrganizationSettingsResponse {
    return {
      organizationId: 'org-a',
      name: 'Acme',
      canManageSettings: true,
      revision: 4,
      settings: { syncAllInsights: false },
      ...overrides,
    }
  }

  async function storeWith(client: Partial<OrganizationSettingsClient>) {
    installDom(memoryStorage())
    const { OrganizationSettingsStore } = await import('@solus/workspace-ui/components/settings/organization-settings.store.svelte')
    return new OrganizationSettingsStore(() => client as OrganizationSettingsClient)
  }

  test('a member reads Sync all Insights and cannot edit it', async () => {
    const store = await storeWith({ read: async () => ({ kind: 'ok', settings: response({ canManageSettings: false, settings: { syncAllInsights: true } }) }) })
    await store.load('https://solus.test', 'org-a')
    store.edit('https://solus.test', 'org-a', { syncAllInsights: false })
    const view = store.viewFor('https://solus.test', 'org-a')
    expect(view?.status === 'ready' && view.draft.syncAllInsights).toBe(true)
  })

  test('an owner saves the changed setting against the revision read', async () => {
    const saved: Array<{ revision: number; settings: unknown }> = []
    const store = await storeWith({
      read: async () => ({ kind: 'ok', settings: response() }),
      save: async (_organizationId, revision, settings) => {
        saved.push({ revision, settings })
        return { kind: 'ok', settings: response({ revision: 5, settings: { syncAllInsights: true } }) }
      },
    })
    await store.load('https://solus.test', 'org-a')
    store.edit('https://solus.test', 'org-a', { syncAllInsights: true })
    await store.save('https://solus.test', 'org-a')
    expect(saved).toEqual([{ revision: 4, settings: { syncAllInsights: true } }])
    const view = store.viewFor('https://solus.test', 'org-a')
    expect(view?.status === 'ready' && view.settings.revision).toBe(5)
    expect(view?.status === 'ready' && view.draft.syncAllInsights).toBe(true)
  })

  test('an unchanged draft sends nothing', async () => {
    let saves = 0
    const store = await storeWith({
      read: async () => ({ kind: 'ok', settings: response() }),
      save: async () => { saves += 1; return { kind: 'offline' } },
    })
    await store.load('https://solus.test', 'org-a')
    store.edit('https://solus.test', 'org-a', { syncAllInsights: true })
    store.edit('https://solus.test', 'org-a', { syncAllInsights: false })
    await store.save('https://solus.test', 'org-a')
    expect(saves).toBe(0)
  })

  test('a conflict keeps the draft beside what the other owner saved; nothing is retried offline', async () => {
    let saves = 0
    const theirs = response({ revision: 5, settings: { syncAllInsights: true } })
    let next: 'conflict' | 'offline' = 'conflict'
    const store = await storeWith({
      read: async () => ({ kind: 'ok', settings: response({ settings: { syncAllInsights: true } }) }),
      save: async () => {
        saves += 1
        return next === 'conflict' ? { kind: 'conflict', current: theirs } : { kind: 'offline' }
      },
    })
    await store.load('https://solus.test', 'org-a')
    store.edit('https://solus.test', 'org-a', { syncAllInsights: false })
    await store.save('https://solus.test', 'org-a')
    let view = store.viewFor('https://solus.test', 'org-a')
    expect(view?.status === 'ready' && view.conflict?.revision).toBe(5)
    expect(view?.status === 'ready' && view.draft.syncAllInsights).toBe(false)

    store.resolveConflict('https://solus.test', 'org-a', 'keep-mine')
    next = 'offline'
    await store.save('https://solus.test', 'org-a')
    view = store.viewFor('https://solus.test', 'org-a')
    expect(view?.status === 'ready' && view.error).toContain('Nothing was saved')
    expect(view?.status === 'ready' && view.draft.syncAllInsights).toBe(false)
    await flush()
    expect(saves).toBe(2)

    store.resolveConflict('https://solus.test', 'org-a', 'use-theirs')
    store.cancel('https://solus.test', 'org-a')
    view = store.viewFor('https://solus.test', 'org-a')
    expect(view?.status === 'ready' && view.draft.syncAllInsights).toBe(true)
  })

  test('permission lost during a save ends the edit and says so', async () => {
    const store = await storeWith({
      read: async () => ({ kind: 'ok', settings: response() }),
      save: async () => ({ kind: 'forbidden' }),
    })
    await store.load('https://solus.test', 'org-a')
    store.edit('https://solus.test', 'org-a', { syncAllInsights: true })
    await store.save('https://solus.test', 'org-a')
    expect(store.viewFor('https://solus.test', 'org-a')).toEqual({ status: 'forbidden' })
  })
})

describe('device layout', () => {
  test('the client layout keys are exactly the contract’s device layout keys', async () => {
    installDom(memoryStorage())
    const { DEVICE_LAYOUT_KEYS } = await import('@solus/workspace-ui/contexts/app/device-settings.store.svelte')
    expect([...DEVICE_LAYOUT_KEYS].sort()).toEqual([...CLIENT_DEVICE_LAYOUT_KEYS].sort())
  })
})
