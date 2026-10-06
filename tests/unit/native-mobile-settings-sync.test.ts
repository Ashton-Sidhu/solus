import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SendOutbox } from '@solus/client-core/send-outbox'
import { OrganizationSettingsClient, type SettingsSyncClock } from '@solus/client-core/settings-sync'
import type { SettingsCloudRequests } from '@solus/client-core/settings-requests'
import { DEFAULT_HOST_CONFIG } from '@solus/contracts/host-config'
import {
  EXECUTION_PREFERENCE_KEYS,
  executionPreferencesSchema,
  type AccountSettingsResponse,
  type OrganizationSettingsResponse,
  type PersonalSettingsDocument,
} from '@solus/contracts/settings'
import type { IpcContext, PromptOptions } from '@solus/contracts/types'
import { SolusApp } from '../../apps/mobile/src/app/solus-app'
import { ConversationController } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { DEFAULT_RUN_SETTINGS } from '../../apps/mobile/src/features/conversation/lib/ipc-context'
import { AppearancePreference, type AppearanceMode } from '../../apps/mobile/src/features/settings/appearance'
import { HostSettings } from '../../apps/mobile/src/features/settings/host-settings'
import { OrganizationSettingsStore } from '../../apps/mobile/src/features/settings/organization-settings'
import { PersonalSettingsStore } from '../../apps/mobile/src/features/settings/personal-settings'
import { alwaysOnlineEnvironment, PersonalSync } from '../../apps/mobile/src/features/settings/personal-sync'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, FakeTransport, flushPromises, healthFetch } from './helpers/native-mobile-fakes'

// plans/018 stage 5 on the phone. The rules pinned here are the ones a person
// would notice going wrong: their light or dark choice has one writer; signing in uploads nothing until they turn sync on; their
// agent defaults never land on a shared host; every prompt carries their own
// preferences; and an organization's Sync all Insights is edited only by
// owners, against the revision they read, with nothing queued offline.

const ACCOUNT = { origin: 'https://app.solus.sh', userId: 'user-1' }

/** One account's synced document in memory, with every request recorded. */
function fakeCloud(initial: PersonalSettingsDocument | null = null) {
  let document: AccountSettingsResponse = { schemaVersion: 1, generation: 0, revision: initial ? 1 : null, settings: initial ?? {}, updatedAt: initial ? 1 : null }
  const calls: string[] = []
  const requests: SettingsCloudRequests = {
    accountSettingsGet: async () => { calls.push('get'); return { kind: 'ok', settings: structuredClone(document) } },
    accountSettingsPatch: async (request) => {
      calls.push(`patch:${JSON.stringify(request.set)}`)
      if (request.expectedRevision !== document.revision) return { kind: 'conflict', reason: 'settings_conflict', current: structuredClone(document) }
      const settings = { ...document.settings, ...request.set }
      for (const key of request.reset ?? []) delete settings[key]
      document = { ...document, revision: (document.revision ?? 0) + 1, settings, updatedAt: 2 }
      return { kind: 'ok', settings: structuredClone(document) }
    },
    accountSettingsDelete: async () => { calls.push('delete'); return { kind: 'ok', settings: document } },
    organizationSettingsGet: async () => ({ kind: 'offline' }),
    organizationSettingsPatch: async () => ({ kind: 'offline' }),
  }
  return { requests, calls, document: () => document }
}

/** Timers that run only when the test says so. */
function manualClock(): SettingsSyncClock & { runAll(): void } {
  const timers = new Set<() => void>()
  return {
    now: () => 1_000,
    setTimer: (callback) => {
      timers.add(callback)
      return () => { timers.delete(callback) }
    },
    runAll: () => {
      const due = [...timers]
      timers.clear()
      for (const callback of due) callback()
    },
  }
}

describe('appearance becomes the personal theme', () => {
  test('Show me is available by default and stays deleted after reload', () => {
    const storage = memoryKeyValueStore()
    const personal = new PersonalSettingsStore(storage)
    expect(personal.current().savedLenses.map((lens) => lens.name)).toEqual(['Show me'])
    personal.set({ savedLenses: [] })
    expect(new PersonalSettingsStore(storage).current().savedLenses).toEqual([])
  })

  test('the Appearance screen writes the personal store only, and a synced change is applied the same way', () => {
    const storage = memoryKeyValueStore()
    const personal = new PersonalSettingsStore(storage)
    const applied: AppearanceMode[] = []
    const appearance = new AppearancePreference(personal, (mode) => applied.push(mode))
    appearance.applySaved()
    appearance.set('light')
    expect(personal.current().themeMode).toBe('light')
    personal.applyRemote({ set: { themeMode: 'dark' }, reset: [] })
    expect(appearance.current()).toBe('dark')
    expect(applied).toEqual(['system', 'light', 'dark'])
  })

  test('a damaged stored value costs only its own key, and a host or secret key never loads', () => {
    const storage = memoryKeyValueStore()
    storage.setItem('solus.mobile.personal.v1:anonymous', JSON.stringify({ settings: { themeMode: 'sepia', rateLimitBehavior: 'queue', otel: { headers: 'secret' } } }))
    const personal = new PersonalSettingsStore(storage)
    expect(personal.current()).toMatchObject({ themeMode: 'system', rateLimitBehavior: 'queue' })
    expect(personal.document()).toEqual({ rateLimitBehavior: 'queue' })
  })

  test('a first account profile starts from this device\'s choices; sign-out returns the anonymous profile', () => {
    const storage = memoryKeyValueStore()
    const personal = new PersonalSettingsStore(storage)
    personal.set({ themeMode: 'dark' })
    personal.setAccount(ACCOUNT)
    expect(personal.current().themeMode).toBe('dark')
    personal.set({ extraInstructions: 'Account only.' })
    personal.setAccount(null)
    expect(personal.current().extraInstructions).toBe('')
  })
})

describe('personal sync is opt-in', () => {
  test('signing in does not turn sync on or send anything', async () => {
    const fetched: string[] = []
    const secrets = memorySecretStore()
    await secrets.set('solus.mobile.account', JSON.stringify({ sessionToken: 'tok', origin: ACCOUNT.origin, profile: { id: ACCOUNT.userId, email: 'a@b.c', name: null, avatarUrl: null } }))
    const app = new SolusApp({
      storage: memoryKeyValueStore(),
      secrets,
      fetch: (async (input: string | URL | Request) => {
        fetched.push(String(input))
        return new Response('{}', { status: 404 })
      }) as typeof fetch,
      createTransport: (options) => new FakeTransport(options, new FakeApi()),
      openBrowser: async () => {},
      deviceLabel: 'Solus for iPhone',
      uuid: () => 'u',
    })
    await app.load()
    app.personal.set({ defaultPermissionMode: 'plan' })
    await app.personalSync.engine.idle()
    expect(app.account.isSignedIn).toBe(true)
    expect(app.personalSync.current().state).toBe('off')
    expect(fetched.filter((url) => url.includes('/v1/account/settings'))).toEqual([])
  })

  test('turning it on with this device as the seed sends the profile, then edits follow after a pause', async () => {
    const cloud = fakeCloud()
    const clock = manualClock()
    const personal = new PersonalSettingsStore(memoryKeyValueStore())
    personal.set({ themeMode: 'light' })
    const sync = new PersonalSync(personal, { requests: cloud.requests, storage: memoryKeyValueStore(), environment: alwaysOnlineEnvironment, clock })
    sync.followAccount(ACCOUNT)
    personal.set({ extraInstructions: 'Before sync.' })
    expect(cloud.calls).toEqual([])

    const prepared = await sync.engine.prepareEnable()
    expect(prepared).toEqual({ kind: 'offer', offer: { kind: 'absent', generation: 0 } })
    expect(await sync.enable('seed')).toEqual({ kind: 'enabled' })
    expect(cloud.document().settings).toEqual({ themeMode: 'light', extraInstructions: 'Before sync.' })

    personal.set({ rateLimitBehavior: 'queue' })
    expect(sync.current().state).toBe('pending')
    clock.runAll()
    await sync.engine.idle()
    expect(cloud.calls.at(-1)).toBe('patch:{"rateLimitBehavior":"queue"}')
    expect(sync.current().state).toBe('synced')
  })

  test('using synced settings brings the account\'s theme to this device', async () => {
    const cloud = fakeCloud({ themeMode: 'dark' })
    const personal = new PersonalSettingsStore(memoryKeyValueStore())
    const applied: AppearanceMode[] = []
    const appearance = new AppearancePreference(personal, (mode) => applied.push(mode))
    appearance.applySaved()
    const sync = new PersonalSync(personal, { requests: cloud.requests, storage: memoryKeyValueStore(), environment: alwaysOnlineEnvironment, clock: manualClock() })
    sync.followAccount(ACCOUNT)
    await sync.engine.prepareEnable()
    expect(await sync.enable('use-synced')).toEqual({ kind: 'enabled' })
    expect(personal.current().themeMode).toBe('dark')
    expect(applied.at(-1)).toBe('dark')
  })

  test('sign-out ends sync for that account on this device', async () => {
    const cloud = fakeCloud()
    const storage = memoryKeyValueStore()
    const personal = new PersonalSettingsStore(storage)
    const sync = new PersonalSync(personal, { requests: cloud.requests, storage, environment: alwaysOnlineEnvironment, clock: manualClock() })
    sync.followAccount(ACCOUNT)
    await sync.engine.prepareEnable()
    await sync.enable('seed')
    sync.followAccount(null)
    expect(sync.current().state).toBe('signed-out')
    sync.followAccount(ACCOUNT)
    expect(sync.current().state).toBe('off')
  })
})

async function hostWorld(api: FakeApi) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
  return world
}

describe('a host holds only host settings', () => {
  test('a change goes to the host as sent, and the host\'s answer is what shows', async () => {
    const api = new FakeApi()
      .on('configGet', () => ({ typeSafe: { source: null }, config: DEFAULT_HOST_CONFIG }))
      // The host may hold a different value than the one sent; its answer wins.
      .on('configUpdate', () => ({ typeSafe: { source: null }, config: { ...DEFAULT_HOST_CONFIG, continueSessionsAfterHostRestart: true } }))
    const world = await hostWorld(api)
    const settings = new HostSettings((hostId) => world.connections.connection(hostId))
    await settings.load('inst-a')
    await settings.update('inst-a', { continueSessionsAfterHostRestart: false })
    expect(api.callsOf('configUpdate')).toEqual([[{ continueSessionsAfterHostRestart: false }]])
    const state = settings.stateOf('inst-a')
    expect(state.kind === 'loaded' && state.settings.continueSessionsAfterHostRestart).toBe(true)
  })
})

describe('prompts carry the person\'s execution preferences', () => {
  test('built from the personal store: every execution key, nothing else', () => {
    const personal = new PersonalSettingsStore(memoryKeyValueStore())
    personal.set({ defaultPermissionMode: 'plan', extraInstructions: 'Be brief.', themeMode: 'dark' })
    const preferences = personal.executionPreferences()
    expect(Object.keys(preferences).sort()).toEqual([...EXECUTION_PREFERENCE_KEYS].sort())
    expect(preferences).toMatchObject({ defaultPermissionMode: 'plan', extraInstructions: 'Be brief.' })
    expect(preferences).not.toHaveProperty('themeMode')
    // The host parses them strictly: a key or value it refuses fails the prompt.
    expect(executionPreferencesSchema.safeParse(preferences).success).toBe(true)
  })

  async function conversation(prompt: () => unknown) {
    const api = new FakeApi()
      .on('loadSessionPage', () => ({ messages: [], before: null }))
      .on('watchSession', () => ({}))
      .on('prompt', prompt)
    const world = await hostWorld(api)
    const connection = world.connections.connection('inst-a')!
    await world.transports[0]!.accept()
    const personal = new PersonalSettingsStore(memoryKeyValueStore())
    const storage = memoryKeyValueStore()
    const controller = new ConversationController({ hostId: 'inst-a', newSession: { sessionId: 'n', provider: 'codex', workingDirectory: '/w' } }, {
      connection,
      outbox: new SendOutbox(() => storage),
      runSettings: async () => personal.runSettings(),
      executionPreferences: () => personal.executionPreferences(),
      organizationId: () => 'org-acme',
      uuid: () => 'p1',
      onChange: () => {},
    })
    return { api, personal, controller }
  }

  test('the prompt context sends them, read when the prompt goes', async () => {
    const { api, personal, controller } = await conversation(() => ({ disposition: 'started' }))
    personal.set({ defaultPermissionMode: 'auto' })
    await controller.load()
    personal.set({ extraInstructions: 'Changed after opening.' })
    await controller.send('go')
    const [ctx] = api.callsOf('prompt')[0] as [IpcContext, PromptOptions]
    expect(ctx.session.permissionMode).toBe('auto')
    expect(ctx.settings.executionPreferences).toMatchObject({ defaultPermissionMode: 'auto', extraInstructions: 'Changed after opening.' })
  })
})

function organizationSettings(overrides: Partial<OrganizationSettingsResponse> = {}): OrganizationSettingsResponse {
  return {
    organizationId: 'org-acme',
    name: 'Acme',
    canManageSettings: true,
    revision: 3,
    settings: { syncAllInsights: false },
    ...overrides,
  }
}

function organizationStore(read: OrganizationSettingsResponse, patch: (revision: number) => Awaited<ReturnType<SettingsCloudRequests['organizationSettingsPatch']>>) {
  const patches: Array<{ expectedRevision: number; settings: object }> = []
  const client = new OrganizationSettingsClient({
    organizationSettingsGet: async () => ({ kind: 'ok', settings: read }),
    organizationSettingsPatch: async (_id, request) => {
      patches.push(request)
      return patch(request.expectedRevision)
    },
  })
  return { store: new OrganizationSettingsStore(client), patches }
}

describe('organization settings', () => {
  test('an owner edits a draft, cancels it, and saves Sync all Insights against the revision read', async () => {
    const saved = organizationSettings({ revision: 4, settings: { syncAllInsights: true } })
    const { store, patches } = organizationStore(organizationSettings(), () => ({ kind: 'ok', settings: saved }))
    await store.load('org-acme')
    store.edit('org-acme', { syncAllInsights: true })
    store.cancel('org-acme')
    const cancelled = store.viewOf('org-acme')
    expect(cancelled.kind === 'loaded' && cancelled.draft).toBeNull()

    store.edit('org-acme', { syncAllInsights: true })
    await store.save('org-acme')
    expect(patches).toEqual([{ expectedRevision: 3, settings: { syncAllInsights: true } }])
    const view = store.viewOf('org-acme')
    expect(view.kind === 'loaded' && { draft: view.draft, revision: view.settings.revision, on: view.settings.settings.syncAllInsights }).toEqual({ draft: null, revision: 4, on: true })
  })

  test('turning a setting back to its saved value leaves no draft', async () => {
    const { store } = organizationStore(organizationSettings(), () => ({ kind: 'offline' }))
    await store.load('org-acme')
    store.edit('org-acme', { syncAllInsights: true })
    store.edit('org-acme', { syncAllInsights: false })
    const view = store.viewOf('org-acme')
    expect(view.kind === 'loaded' && view.draft).toBeNull()
  })

  test('a conflict shows the other owner\'s save and keeps the draft; a second save is against their revision', async () => {
    const theirs = organizationSettings({ revision: 7, settings: { syncAllInsights: false } })
    const { store, patches } = organizationStore(organizationSettings(), (revision) => revision === 7
      ? { kind: 'ok', settings: organizationSettings({ revision: 8, settings: { syncAllInsights: true } }) }
      : { kind: 'conflict', current: theirs })
    await store.load('org-acme')
    store.edit('org-acme', { syncAllInsights: true })
    await store.save('org-acme')
    const conflicted = store.viewOf('org-acme')
    expect(conflicted.kind === 'loaded' && { conflict: conflicted.conflict, revision: conflicted.settings.revision, draft: conflicted.draft?.syncAllInsights }).toEqual({ conflict: true, revision: 7, draft: true })
    await store.save('org-acme')
    expect(patches.map((request) => request.expectedRevision)).toEqual([3, 7])
  })

  test('a member reads Sync all Insights and cannot make a draft or a save', async () => {
    const { store, patches } = organizationStore(organizationSettings({ canManageSettings: false, settings: { syncAllInsights: true } }), () => ({ kind: 'offline' }))
    await store.load('org-acme')
    store.edit('org-acme', { syncAllInsights: false })
    await store.save('org-acme')
    const view = store.viewOf('org-acme')
    expect(view.kind === 'loaded' && view.draft).toBeNull()
    expect(patches).toEqual([])
  })

  test('an offline save is not queued, and lost permission ends editing', async () => {
    let answer: 'offline' | 'forbidden' = 'offline'
    const { store, patches } = organizationStore(organizationSettings(), () => ({ kind: answer }))
    await store.load('org-acme')
    store.edit('org-acme', { syncAllInsights: true })
    await store.save('org-acme')
    const offline = store.viewOf('org-acme')
    expect(offline.kind === 'loaded' && { saveError: offline.saveError, kept: offline.draft !== null }).toEqual({ saveError: 'Solus Cloud did not answer. Nothing was saved.', kept: true })
    await flushPromises()
    expect(patches).toHaveLength(1)
    answer = 'forbidden'
    await store.save('org-acme')
    expect(store.viewOf('org-acme').kind).toBe('forbidden')
  })
})

describe('settings navigation', () => {
  const mobile = resolve(import.meta.dir, '../../apps/mobile/src')
  const navigator = readFileSync(join(mobile, 'navigation/RootNavigator.tsx'), 'utf8')
  const routes = readFileSync(join(mobile, 'navigation/routes.ts'), 'utf8')

  test('every route a settings screen opens is registered', () => {
    const settingsDir = join(mobile, 'features/settings')
    const targets = new Set<string>()
    for (const file of readdirSync(settingsDir).filter((name) => name.endsWith('.tsx'))) {
      for (const match of readFileSync(join(settingsDir, file), 'utf8').matchAll(/navigate\(\s*["']([A-Za-z]+)["']/g)) targets.add(match[1]!)
    }
    expect([...targets]).toContain('PersonalSettings')
    expect([...targets]).toContain('OrganizationSettings')
    for (const target of targets) expect(navigator).toContain(`name="${target}"`)
  })

  test('personal screens open without a host', () => {
    for (const route of ['PersonalSettings', 'AgentDefaults', 'NotificationSettings', 'AppearanceSettings']) {
      expect(routes).toMatch(new RegExp(`\\n\\s*${route}: undefined\\n`))
    }
  })
})
