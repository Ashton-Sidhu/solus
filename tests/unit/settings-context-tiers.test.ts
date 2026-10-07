import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { singleHostServerConnections } from './helpers/server-connections-mock'

// The settings context reads each key from the store that owns it (plans/018
// §3.5): a personal key from the personal profile, a device key and a layout
// key from the device store. These tests pin what that buys — a personal key
// reads, heals, and persists in the personal profile with no host write; a
// device key stays out of it; and the legacy single blob migrates once.

const hostWrites: unknown[] = []
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    ...singleHostServerConnections(),
    apiFor: () => ({ configUpdate: async (patch: unknown) => { hostWrites.push(patch) }, configGet: async () => ({}) }),
  },
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
  return { setProperty: (name: string, value: string) => void properties.set(name, value), properties }
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
  hostWrites.length = 0
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
  return { settings: new SettingsContext(storage as unknown as Storage), storage }
}

function profile(storage: ReturnType<typeof memoryStorage>, accountKey = 'anonymous'): Record<string, unknown> {
  return JSON.parse(storage.getItem(`solus.personal-settings.v1:${accountKey}`) ?? '{}')
}

function deviceLayout(storage: ReturnType<typeof memoryStorage>): Record<string, unknown> {
  return JSON.parse(storage.getItem('solus.device-layout.v1') ?? '{}')
}

function deviceSettings(storage: ReturnType<typeof memoryStorage>): Record<string, unknown> {
  return JSON.parse(storage.getItem('solus.device-settings.v1') ?? '{}')
}

describe('a personal key', () => {
  test('reads the contract default on a fresh install', async () => {
    const { settings } = await load()
    expect(settings.showToolCalls).toBe(true)
  })

  test('Show me is available by default and stays deleted after reload', async () => {
    const { settings, storage } = await load()
    expect(settings.savedLenses.map((lens) => lens.name)).toEqual(['Show me'])
    settings.setPersonal('savedLenses', [])
    expect((await load(storage)).settings.savedLenses).toEqual([])
  })

  test('an existing saved list gains Show me once, keeping its prompts and order', async () => {
    const original = [
      { id: 'architecture', name: 'Architecture delta', prompt: 'My architecture prompt.' },
      { id: 'risk', name: 'Risk by file', prompt: 'My risk prompt.' },
      { id: 'flow', name: 'Data flow', prompt: 'My flow prompt.' },
    ]
    const storage = memoryStorage({ 'solus.personal-settings.v1:anonymous': JSON.stringify({ savedLenses: original }) })
    const { settings } = await load(storage)
    expect(settings.savedLenses.slice(0, 3)).toEqual(original)
    expect(settings.savedLenses[3].name).toBe('Show me')
    expect((await load(storage)).settings.savedLenses).toHaveLength(4)
    settings.setPersonal('savedLenses', original)
    expect((await load(storage)).settings.savedLenses).toEqual(original)
  })

  test('an existing Show me prompt is kept without a duplicate', async () => {
    const original = [{ id: 'user-show-me', name: 'Show me', prompt: 'My edited prompt.' }]
    const storage = memoryStorage({ 'solus.personal-settings.v1:anonymous': JSON.stringify({ savedLenses: original }) })
    expect((await load(storage)).settings.savedLenses).toEqual(original)
  })

  test('a change reads back and persists in the personal profile, never on a host', async () => {
    const { settings, storage } = await load()
    expect(settings.setPersonal('showToolCalls', false)).toBe(true)
    expect(settings.showToolCalls).toBe(false)
    expect(profile(storage).showToolCalls).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(hostWrites).toEqual([])
    const restored = await load(storage)
    expect(restored.settings.showToolCalls).toBe(false)
  })

  test('model options survive reload', async () => {
    const { settings, storage } = await load()
    const modelOptionsByProvider = {
      codex: { 'gpt-5.4': { reasoningEffort: 'low' as const, contextWindow: null, fastMode: false } },
    }
    settings.setPersonal('modelOptionsByProvider', modelOptionsByProvider)
    const restored = await load(storage)
    expect(restored.settings.modelOptionsByProvider).toEqual(modelOptionsByProvider)
  })

  test('a value its strict schema refuses is not stored', async () => {
    const { settings, storage } = await load()
    expect(settings.setPersonal('themeMode', 'sepia' as 'dark')).toBe(false)
    expect(settings.themeMode).toBe('system')
    expect(profile(storage).themeMode).toBeUndefined()
  })

  test('a bad stored value heals to the default on its own', async () => {
    const storage = memoryStorage({
      'solus.personal-settings.v1:anonymous': JSON.stringify({ showToolCalls: 'no', themeMode: 'dark' }),
    })
    const { settings } = await load(storage)
    expect(settings.showToolCalls).toBe(true)
    expect(settings.themeMode).toBe('dark')
  })

  test('execution preferences carry the personal values a host reads', async () => {
    const { settings } = await load()
    settings.setPersonal('rateLimitBehavior', 'queue')
    settings.setPersonal('extraInstructions', 'Be brief.')
    expect(settings.ctx.executionPreferences).toMatchObject({ rateLimitBehavior: 'queue', extraInstructions: 'Be brief.' })
    expect(settings.executionPreferences).not.toHaveProperty('themeMode')
  })
})

describe('a device key', () => {
  test('stays out of the personal profile', async () => {
    const { settings, storage } = await load()
    settings.setLayout('projectPanelOpen', true)
    settings.setDevice('defaultEditor', 'vscode')
    expect(settings.projectPanelOpen).toBe(true)
    expect(settings.defaultEditor).toBe('vscode')
    expect(profile(storage)).not.toHaveProperty('projectPanelOpen')
    expect(profile(storage)).not.toHaveProperty('defaultEditor')
    expect(deviceLayout(storage).projectPanelOpen).toBe(true)
    expect(deviceSettings(storage).defaultEditor).toBe('vscode')
    const restored = await load(storage)
    expect(restored.settings.projectPanelOpen).toBe(true)
    expect(restored.settings.defaultEditor).toBe('vscode')
  })

  test('a bad stored layout value heals to its default on its own', async () => {
    const storage = memoryStorage({ 'solus.device-layout.v1': JSON.stringify({ projectPanelOpen: 'yes', splitProjectPanelOpen: true }) })
    const { settings } = await load(storage)
    expect(settings.projectPanelOpen).toBe(false)
    expect(settings.splitProjectPanelOpen).toBe(true)
  })

  test('onboarding shows on a fresh install until it is completed', async () => {
    const fresh = await load()
    expect(fresh.settings.onboardingCompleted).toBe(false)
    fresh.settings.setLayout('onboardingCompleted', true)
    const later = await load(fresh.storage)
    expect(later.settings.onboardingCompleted).toBe(true)
  })

  test('an installed font is a device override; a preset is the synced choice', async () => {
    const { settings, storage } = await load()
    settings.setFont('fontFamily', 'Comic Code')
    expect(settings.fontFamily).toBe('Comic Code')
    expect(settings.fontOverrideOf('fontFamily')).toBe('Comic Code')
    expect(profile(storage).fontFamily).toBeUndefined()
    settings.useSyncedFont('fontFamily')
    expect(settings.fontFamily).toBe(settings.syncedFontOf('fontFamily'))
    settings.setFont('fontFamily', 'inter')
    expect(profile(storage).fontFamily).toBe('inter')
    expect(settings.fontOverrideOf('fontFamily')).toBeNull()
  })
})
