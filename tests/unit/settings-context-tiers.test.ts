import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { singleHostServerConnections } from './helpers/server-connections-mock'

// The settings context is one table per tier: a host-config key is mirrored by
// naming it in `MIRRORED_HOST_KEYS`, a device key by a row in `DEVICE_FIELDS`.
// These tests pin what that buys — a key added to the contract reads, heals,
// stores, and pushes with no further wiring — using `tasksEnabled`, the newest
// mirrored key, and the device keys whose absence means something.

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: singleHostServerConnections(),
}))
mock.module('@solus/client-core/local-api', () => ({ localApi: {} }))
mock.module('@solus/client-core/host-events', () => ({ subscribeAllHosts: () => () => {} }))

type Globals = Record<'window' | 'document' | 'localStorage' | 'navigator' | '$state', unknown>
const previous: Partial<Globals> = {}
const GLOBAL_KEYS = ['window', 'document', 'localStorage', 'navigator', '$state'] as const
const globals = globalThis as unknown as Globals

function memoryStorage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

function styleStub() {
  const properties = new Map<string, string>()
  return { setProperty: (name: string, value: string) => void properties.set(name, value) }
}

function installDom(storage: ReturnType<typeof memoryStorage>) {
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const classes = new Set<string>()
  globals.window = { addEventListener() {}, matchMedia, innerWidth: 1440 }
  globals.document = {
    addEventListener() {},
    visibilityState: 'visible',
    hasFocus: () => true,
    documentElement: {
      classList: { toggle: (name: string, on: boolean) => void (on ? classes.add(name) : classes.delete(name)), contains: (name: string) => classes.has(name) },
      style: styleStub(),
    },
    body: { style: styleStub() },
    querySelectorAll: () => [],
    querySelector: () => null,
  }
  globals.localStorage = storage
  globals.navigator = { userAgent: 'Macintosh', platform: 'MacIntel' }
  globals.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => structuredClone(value) })
}

beforeEach(() => {
  for (const key of GLOBAL_KEYS) previous[key] = globals[key]
})

afterEach(() => {
  for (const key of GLOBAL_KEYS) {
    if (previous[key] === undefined) delete globals[key]
    else globals[key] = previous[key]
  }
})

async function load(storage = memoryStorage()) {
  installDom(storage)
  const { SettingsContext } = await import('@solus/workspace-ui/contexts/app/settings.context.svelte')
  return { settings: new SettingsContext(), storage }
}

function stored(storage: ReturnType<typeof memoryStorage>): Record<string, unknown> {
  return JSON.parse(storage.getItem('solus-settings') ?? '{}')
}

describe('a mirrored host key', () => {
  test('reads the contract default on a fresh install and is written straight back', async () => {
    const { settings, storage } = await load()
    expect(settings.tasksEnabled).toBe(true)
    expect(stored(storage).tasksEnabled).toBe(true)
  })

  test('reads its default from a blob saved before the key existed', async () => {
    const { settings } = await load(memoryStorage({ 'solus-settings': JSON.stringify({ themeMode: 'dark' }) }))
    expect(settings.tasksEnabled).toBe(true)
    expect(settings.themeMode).toBe('dark')
  })

  test('heals a bad stored value to the contract default', async () => {
    const { settings } = await load(memoryStorage({ 'solus-settings': JSON.stringify({ tasksEnabled: 'no' }) }))
    expect(settings.tasksEnabled).toBe(true)
  })

  test('a change reads back, persists, and is part of the host mirror', async () => {
    const { settings, storage } = await load()
    settings.update({ tasksEnabled: false })
    expect(settings.tasksEnabled).toBe(false)
    expect(stored(storage).tasksEnabled).toBe(false)
    expect(settings.hostConfig.tasksEnabled).toBe(false)
  })
})

describe('a device key', () => {
  test('stays out of the host mirror', async () => {
    const { settings } = await load()
    settings.update({ projectPanelOpen: true })
    expect(settings.projectPanelOpen).toBe(true)
    expect('projectPanelOpen' in settings.hostConfig).toBe(false)
  })

  test('onboarding shows on a fresh install but not to someone with an older blob', async () => {
    const fresh = await load()
    expect(fresh.settings.onboardingCompleted).toBe(false)
    const older = await load(memoryStorage({ 'solus-settings': JSON.stringify({ themeMode: 'light' }) }))
    expect(older.settings.onboardingCompleted).toBe(true)
  })
})

describe('legacy blobs', () => {
  test('the old terminal choice carries over when the new key was never written', async () => {
    const { settings } = await load(memoryStorage({ 'solus-settings': JSON.stringify({ defaultTerminal: 'iterm2' }) }))
    expect(settings.fallbackTerminal).toBe('iterm2')
  })

  test('the old notification flags decide the channels when the new key is absent', async () => {
    const { settings } = await load(memoryStorage({ 'solus-settings': JSON.stringify({ soundEnabled: false }) }))
    expect(settings.notifications.channels.sound).toBe(false)
    expect(settings.notifications.channels.system).toBe(false)
  })
})
