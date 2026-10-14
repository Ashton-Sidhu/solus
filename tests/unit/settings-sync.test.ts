import { describe, expect, test } from 'bun:test'
import {
  ACCOUNT_SETTINGS_PATH,
  accountSettingsPatchRequestSchema,
  organizationSettingsPath,
  type AccountSettingsResponse,
  type OrganizationSettingsResponse,
  type PersonalSettingsDocument,
} from '@solus/contracts/settings'
import { desktopSettingsRequests } from '../../apps/desktop/src/main/account/settings-client'
import { CloudAccountClient } from '../../apps/mobile/src/features/account/account-client'
import {
  webSettingsRequests,
  settingsCloudRequests,
  type SettingsCloudRequests,
} from '@solus/client-core/settings-requests'
import {
  OrganizationSettingsClient,
  SettingsSync,
  type PersonalSettingsChange,
  type SettingsSyncStatus,
  type SyncAccount,
} from '@solus/client-core/settings-sync'
import {
  DOCUMENT_SYNC_DEBOUNCE_MS,
  DOCUMENT_SYNC_POLL_MS,
  type DocumentSyncBroadcast,
  type DocumentSyncEnvironment,
  type DocumentSyncMessage,
  type DocumentSyncSignal,
  type DocumentSyncStorage,
} from '@solus/client-core/document-sync'

// Personal settings sync (plans/018 §5, decision 9): signed in is synced. A sign-in
// reads the account and adopts its copy, or seeds it from this device; a durable
// pending patch is merged three ways against a compare-and-swap revision; and a
// generation that a clear advances makes every old client start again, so none
// can restore what was cleared.

// ─── Fakes ───

/** The web page's sign-in, reduced to the access token the adapter asks for. */
const ACCOUNT_SIGN_IN = { accessToken: async () => 'account-token' }

interface AccountDocument {
  generation: number
  revision: number | null
  settings: PersonalSettingsDocument
  updatedAt: number | null
}

/**
 * The account settings endpoint, honestly: a patch applies only when its
 * generation and expected revision both match, as one compare-and-swap. Each
 * signed-in user (the cookie) has their own document.
 */
class FakeCloud {
  readonly documents = new Map<string, AccountDocument>()
  readonly log: Array<{ userId: string; method: string }> = []
  isDown = false
  failNext: number | null = null
  private gate: Promise<void> | null = null
  private openGate: (() => void) | null = null
  private tick = 0

  constructor(readonly origin: string) {}

  document(userId: string): AccountDocument {
    let document = this.documents.get(userId)
    if (!document) {
      document = { generation: 0, revision: null, settings: {}, updatedAt: null }
      this.documents.set(userId, document)
    }
    return document
  }

  /** Holds every request until `release`. */
  hold(): void {
    this.gate = new Promise((resolve) => { this.openGate = resolve })
  }

  release(): void {
    this.openGate?.()
    this.gate = null
  }

  writes(userId?: string): number {
    return this.log.filter((entry) => entry.method !== 'GET' && (!userId || entry.userId === userId)).length
  }

  /** The browser's fetch with this user's cookie. */
  fetchFor(userId: string): typeof fetch {
    return (async (input: string | URL | Request, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      this.log.push({ userId, method })
      if (this.gate) await this.gate
      if (this.isDown) throw new TypeError('network down')
      if (this.failNext) {
        const status = this.failNext
        this.failNext = null
        return Response.json({ error: 'internal_error' }, { status })
      }
      if (new URL(String(input)).pathname !== ACCOUNT_SETTINGS_PATH) return new Response(null, { status: 404 })
      const document = this.document(userId)
      if (method === 'GET') return Response.json(this.view(document))
      if (method === 'DELETE') {
        Object.assign(document, { generation: document.generation + 1, revision: null, settings: {}, updatedAt: ++this.tick })
        return Response.json(this.view(document))
      }
      const request = accountSettingsPatchRequestSchema.safeParse(JSON.parse(String(init.body)))
      if (!request.success) return Response.json({ error: 'invalid_request' }, { status: 400 })
      const { generation, expectedRevision, set, reset } = request.data
      if (generation !== document.generation) return Response.json({ error: 'settings_generation_changed', current: this.view(document) }, { status: 409 })
      if (expectedRevision !== document.revision) return Response.json({ error: 'settings_conflict', current: this.view(document) }, { status: 409 })
      const settings: PersonalSettingsDocument = { ...document.settings, ...set }
      for (const key of reset) delete settings[key]
      Object.assign(document, { revision: (document.revision ?? 0) + 1, settings, updatedAt: ++this.tick })
      return Response.json(this.view(document))
    }) as typeof fetch
  }

  private view(document: AccountDocument): AccountSettingsResponse {
    return { schemaVersion: 1, ...structuredClone(document) }
  }
}

class FakeClock {
  private time = 1_000
  private timers: Array<{ at: number; callback: () => void; id: number }> = []
  private nextId = 0

  now = (): number => this.time

  setTimer = (callback: () => void, ms: number): (() => void) => {
    const id = ++this.nextId
    this.timers.push({ at: this.time + ms, callback, id })
    return () => { this.timers = this.timers.filter((timer) => timer.id !== id) }
  }

  get pending(): number {
    return this.timers.length
  }

  advance(ms: number): void {
    const until = this.time + ms
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((timer) => timer !== due)
      this.time = due.at
      due.callback()
    }
    this.time = until
  }
}

class FakeEnvironment implements DocumentSyncEnvironment {
  online = true
  foreground = true
  private listeners = new Set<(signal: DocumentSyncSignal) => void>()
  isOnline = () => this.online
  isForeground = () => this.foreground
  subscribe(listener: (signal: DocumentSyncSignal) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  signal(signal: DocumentSyncSignal): void {
    if (signal === 'online' || signal === 'offline') this.online = signal === 'online'
    if (signal === 'foreground' || signal === 'background') this.foreground = signal === 'foreground'
    for (const listener of this.listeners) listener(signal)
  }
}

function memoryStorage(): DocumentSyncStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }
}

/** Browser tabs of one profile: a message reaches every other tab, later. */
class BroadcastHub {
  private ports = new Set<(message: DocumentSyncMessage) => void>()
  port(): DocumentSyncBroadcast {
    let own: ((message: DocumentSyncMessage) => void) | null = null
    return {
      post: (message) => {
        for (const listener of this.ports) if (listener !== own) queueMicrotask(() => listener(message))
      },
      subscribe: (listener) => {
        own = listener
        this.ports.add(listener)
        return () => { this.ports.delete(listener) }
      },
    }
  }
}

/** A requests port that follows whichever credential the client holds now. */
function switchableRequests(initial: SettingsCloudRequests) {
  let current = initial
  const requests: SettingsCloudRequests = {
    accountSettingsGet: () => current.accountSettingsGet(),
    accountSettingsPatch: (request) => current.accountSettingsPatch(request),
    accountSettingsDelete: () => current.accountSettingsDelete(),
    organizationSettingsGet: (id) => current.organizationSettingsGet(id),
    organizationSettingsPatch: (id, request) => current.organizationSettingsPatch(id, request),
  }
  return { requests, use: (next: SettingsCloudRequests) => { current = next } }
}

/**
 * One client: an engine plus the personal profile it feeds, standing in for the
 * personal store. Every status it ever showed is kept.
 */
function client(cloud: FakeCloud, userId: string, shared: { clock: FakeClock; storage?: ReturnType<typeof memoryStorage>; hub?: BroadcastHub; environment?: FakeEnvironment } ) {
  const storage = shared.storage ?? memoryStorage()
  const environment = shared.environment ?? new FakeEnvironment()
  const transport = switchableRequests(webSettingsRequests(cloud.origin, ACCOUNT_SIGN_IN, cloud.fetchFor(userId)))
  const profile: PersonalSettingsDocument = {}
  const engine = new SettingsSync({
    requests: transport.requests,
    storage,
    environment,
    clock: { now: shared.clock.now, setTimer: shared.clock.setTimer },
    broadcast: shared.hub?.port(),
    localCopy: () => structuredClone(profile),
  })
  const applied: PersonalSettingsChange[] = []
  const statuses: SettingsSyncStatus[] = []
  engine.subscribe((status) => statuses.push(status))
  engine.onRemoteChange((change) => {
    applied.push(change)
    Object.assign(profile, change.set)
    for (const key of change.reset) delete profile[key]
  })
  const account: SyncAccount = { origin: cloud.origin, userId }
  return {
    engine,
    storage,
    environment,
    transport,
    profile,
    applied,
    statuses,
    account,
    signIn: () => engine.setAccount(account),
    edit(set: PersonalSettingsDocument) {
      Object.assign(profile, set)
      return engine.recordLocalChange({ set })
    },
    /** Signs in with `local` as this device's copy, and waits for the start: the account's copy taken, or this one sent. */
    async start(local: PersonalSettingsDocument = {}) {
      Object.assign(profile, local)
      engine.setAccount(account)
      await settle(engine)
    },
  }
}

async function settle(...engines: SettingsSync[]): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    for (const engine of engines) await engine.idle()
    await Promise.resolve()
  }
}

const ORIGIN_A = 'https://app.solus.sh'
const ORIGIN_B = 'https://staging.solus.sh'

// ─── Signed in is synced ───

describe('signed in is synced', () => {
  test('signed out, nothing is sent; signing in reads the account and writes this device’s copy once', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const device = client(cloud, 'ada', { clock })

    expect(device.engine.current.state).toBe('signed-out')
    expect(device.edit({ themeMode: 'dark' })).toBe('ignored')
    await device.engine.refresh()
    expect(cloud.log).toEqual([])

    await device.start()
    expect(cloud.log.map((entry) => entry.method)).toEqual(['GET', 'PATCH'])
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'dark' })
    expect(device.engine.current.state).toBe('synced')
    // The confirmed seed is applied whole: on the desktop the profile's seed is this computer's, not the local copy's.
    expect(device.applied).toEqual([{ set: { themeMode: 'dark' }, reset: [] }])
  })

  test('with a copy in the account, this device takes it, key by key, and sends nothing', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    Object.assign(cloud.document('ada'), { revision: 3, settings: { themeMode: 'dark', showToolCalls: false } })
    const device = client(cloud, 'ada', { clock })
    // An edit made before sign-in: the account wins, so it goes.
    await device.start({ themeMode: 'light', fontSize: 12 })

    expect(cloud.writes()).toBe(0)
    expect(device.profile).toEqual({ themeMode: 'dark', showToolCalls: false })
    expect(device.applied).toEqual([{ set: { themeMode: 'dark', showToolCalls: false }, reset: ['fontSize'] }])
    expect(device.engine.current.state).toBe('synced')
  })

  test('an empty account and an empty device write nothing; the first edit creates the document', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const device = client(cloud, 'ada', { clock })
    await device.start()
    expect(cloud.writes()).toBe(0)
    expect(device.engine.current.state).toBe('synced')

    device.edit({ fontSize: 13 })
    clock.advance(DOCUMENT_SYNC_DEBOUNCE_MS)
    await settle(device.engine)
    expect(cloud.document('ada')).toMatchObject({ revision: 1, settings: { fontSize: 13 } })
  })

  test('two devices signing in at once: one writes the first copy, the other takes it instead of overwriting', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const first = client(cloud, 'ada', { clock })
    const second = client(cloud, 'ada', { clock })
    Object.assign(first.profile, { themeMode: 'dark' })
    Object.assign(second.profile, { themeMode: 'light' })
    cloud.hold()
    first.signIn()
    second.signIn()
    await Promise.resolve()
    expect(first.engine.current.state).toBe('loading')
    cloud.release()
    await settle(first.engine, second.engine)

    // One seed went through; the other was refused and took it.
    expect(cloud.document('ada').revision).toBe(1)
    expect(first.profile).toEqual(cloud.document('ada').settings)
    expect(second.profile).toEqual(cloud.document('ada').settings)
    expect(first.engine.current.state).toBe('synced')
    expect(second.engine.current.state).toBe('synced')
  })

  test('a start that fails offline shows offline, sends nothing, and starts when back online', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const device = client(cloud, 'ada', { clock })
    device.environment.online = false
    await device.start({ themeMode: 'dark' })
    expect(device.engine.current.state).toBe('offline')
    expect(cloud.log).toEqual([])
    expect(device.edit({ fontSize: 11 })).toBe('ignored')

    device.environment.signal('online')
    await settle(device.engine)
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'dark', fontSize: 11 })
    expect(device.engine.current.state).toBe('synced')
  })
})

// ─── Isolation ───

describe('settings sync isolation', () => {
  test('late answers for account A at origin A never reach account B at origin B, and A’s queue is never sent for B', async () => {
    const cloudA = new FakeCloud(ORIGIN_A)
    const cloudB = new FakeCloud(ORIGIN_B)
    const clock = new FakeClock()
    const storage = memoryStorage()
    const device = client(cloudB, 'bob', { clock, storage })
    const asAda = () => {
      device.transport.use(webSettingsRequests(ORIGIN_A, ACCOUNT_SIGN_IN, cloudA.fetchFor('ada')))
      device.engine.setAccount({ origin: ORIGIN_A, userId: 'ada' })
    }
    const asBob = () => {
      device.transport.use(webSettingsRequests(ORIGIN_B, ACCOUNT_SIGN_IN, cloudB.fetchFor('bob')))
      device.engine.setAccount({ origin: ORIGIN_B, userId: 'bob' })
    }
    // Both accounts are synced, at the same generation and revision.
    await device.start({ themeMode: 'system' })
    asAda()
    await settle(device.engine)
    expect(cloudA.document('ada').settings).toEqual({ themeMode: 'system' })

    // Another device of A changes the theme; this device has an unsent edit for A.
    Object.assign(cloudA.document('ada'), { revision: 2, settings: { themeMode: 'dark' } })
    device.environment.online = false
    device.edit({ extraInstructions: 'A only' })
    device.environment.online = true

    // A's refresh is in flight when the person switches to B.
    cloudA.hold()
    const lateRefresh = device.engine.refresh()
    await Promise.resolve()
    device.applied.length = 0
    asBob()
    expect(device.engine.current.account).toEqual({ origin: ORIGIN_B, userId: 'bob' })
    cloudA.release()
    await lateRefresh
    clock.advance(DOCUMENT_SYNC_DEBOUNCE_MS * 2)
    await settle(device.engine)

    // Nothing of A's reached B: B's own kept copy is applied, A's theme and A's edit never are; no conflict.
    expect(device.applied).toEqual([{ set: { themeMode: 'system' }, reset: [] }])
    expect(device.engine.current).toMatchObject({ state: 'synced', pendingKeys: [], conflicts: [] })
    // A's queue never travelled to B's account.
    expect(cloudB.document('bob').settings).toEqual({ themeMode: 'system' })
    expect(cloudB.writes('bob')).toBe(1)

    // A's queue is still A's, waiting for A, and merges with A's newer theme.
    asAda()
    expect(device.engine.current.pendingKeys).toEqual(['extraInstructions'])
    await settle(device.engine)
    expect(cloudA.document('ada').settings).toEqual({ themeMode: 'dark', extraInstructions: 'A only' })
  })
})

// ─── Sync ───

describe('settings sync', () => {
  test('two clients converge, and edits to different keys merge across a stale revision', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const laptop = client(cloud, 'ada', { clock })
    const phone = client(cloud, 'ada', { clock })
    await laptop.start({ themeMode: 'dark', fontSize: 14 })
    await phone.start()
    expect(phone.profile).toEqual({ themeMode: 'dark', fontSize: 14 })

    // Both edit from revision 1, different keys.
    laptop.edit({ showToolCalls: false })
    phone.edit({ fontSize: 16 })
    clock.advance(DOCUMENT_SYNC_DEBOUNCE_MS)
    await settle(laptop.engine, phone.engine)

    // One of them got a 409, merged, and retried against the new revision.
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'dark', fontSize: 16, showToolCalls: false })
    expect(cloud.document('ada').revision).toBe(3)

    await laptop.engine.refresh()
    await phone.engine.refresh()
    expect(laptop.profile).toEqual(cloud.document('ada').settings)
    expect(phone.profile).toEqual(cloud.document('ada').settings)
    expect(laptop.engine.current.state).toBe('synced')
    expect(phone.engine.current.state).toBe('synced')
    // A client's own edit is never echoed back to it.
    expect(laptop.applied.some((change) => 'showToolCalls' in change.set)).toBe(false)
  })

  test('the same key changed on both sides is a visible conflict until the person picks', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const laptop = client(cloud, 'ada', { clock })
    const phone = client(cloud, 'ada', { clock })
    await laptop.start({ themeMode: 'system' })
    await phone.start()

    laptop.edit({ themeMode: 'dark' })
    clock.advance(DOCUMENT_SYNC_DEBOUNCE_MS)
    await settle(laptop.engine)
    phone.edit({ themeMode: 'light', fontSize: 18 })
    clock.advance(DOCUMENT_SYNC_DEBOUNCE_MS)
    await settle(phone.engine)

    // The unrelated key went through; the theme did not overwrite the laptop's.
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'dark', fontSize: 18 })
    expect(phone.engine.current.state).toBe('conflict')
    expect(phone.engine.current.conflicts).toEqual([{ key: 'themeMode', mine: { themeMode: 'light' }, theirs: { themeMode: 'dark' } }])
    expect(phone.profile.themeMode).toBe('light')

    // It stays a conflict across refreshes and polls.
    clock.advance(DOCUMENT_SYNC_POLL_MS)
    await settle(phone.engine)
    expect(phone.engine.current.state).toBe('conflict')

    phone.engine.resolveConflict('themeMode', 'keep-mine')
    await settle(phone.engine)
    expect(cloud.document('ada').settings.themeMode).toBe('light')
    expect(phone.engine.current.state).toBe('synced')
    await laptop.engine.refresh()
    expect(laptop.profile.themeMode).toBe('light')
  })

  test('taking theirs applies the cloud value locally and sends nothing', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const device = client(cloud, 'ada', { clock })
    await device.start({ themeMode: 'system' })
    Object.assign(cloud.document('ada'), { revision: 2, settings: { themeMode: 'dark' } })
    device.edit({ themeMode: 'light' })
    clock.advance(DOCUMENT_SYNC_DEBOUNCE_MS)
    await settle(device.engine)
    expect(device.engine.current.state).toBe('conflict')
    const writes = cloud.writes()

    device.engine.resolveConflict('themeMode', 'take-theirs')
    await settle(device.engine)
    expect(device.profile.themeMode).toBe('dark')
    expect(device.engine.current.state).toBe('synced')
    expect(cloud.writes()).toBe(writes)
  })

  test('a restart keeps unsent edits and sends them when back online', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const storage = memoryStorage()
    const environment = new FakeEnvironment()
    const before = client(cloud, 'ada', { clock, storage, environment })
    await before.start({ themeMode: 'system' })
    environment.signal('offline')
    before.edit({ extraInstructions: 'Be brief.' })
    clock.advance(DOCUMENT_SYNC_DEBOUNCE_MS)
    await settle(before.engine)
    expect(before.engine.current.state).toBe('offline')
    before.engine.dispose()

    const after = client(cloud, 'ada', { clock, storage, environment })
    after.signIn()
    expect(after.engine.current.pendingKeys).toEqual(['extraInstructions'])
    expect(after.engine.current.state).toBe('offline')
    environment.signal('online')
    await settle(after.engine)
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'system', extraInstructions: 'Be brief.' })
    expect(after.engine.current.state).toBe('synced')
  })

  test('a failed write never shows synced, and the last confirmed time does not move', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const device = client(cloud, 'ada', { clock })
    await device.start({ themeMode: 'system' })
    const confirmedAt = device.engine.current.lastSyncedAt
    expect(confirmedAt).not.toBeNull()
    clock.advance(10)

    device.statuses.length = 0
    device.edit({ showToolCalls: false })
    cloud.failNext = 500
    clock.advance(DOCUMENT_SYNC_DEBOUNCE_MS)
    await settle(device.engine)
    expect(device.engine.current.state).toBe('error')
    expect(device.engine.current.error).toEqual({ code: 'internal_error', message: null })

    cloud.isDown = true
    await device.engine.refresh()
    expect(device.engine.current.state).toBe('offline')
    expect(device.engine.current.pendingKeys).toEqual(['showToolCalls'])
    expect(device.engine.current.lastSyncedAt).toBe(confirmedAt)
    expect(device.statuses.map((status) => status.state)).not.toContain('synced')

    cloud.isDown = false
    await device.engine.refresh()
    expect(device.engine.current.state).toBe('synced')
    expect(cloud.document('ada').settings.showToolCalls).toBe(false)
  })

  test('confirmed changes reach the other tabs of one browser profile', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const storage = memoryStorage()
    const hub = new BroadcastHub()
    const tab = client(cloud, 'ada', { clock, storage, hub })
    const otherTab = client(cloud, 'ada', { clock, storage, hub })
    await tab.start({ themeMode: 'system' })
    // The other tab finds the record the first one wrote: no second start.
    await otherTab.start()
    expect(otherTab.engine.current.state).toBe('synced')
    expect(otherTab.profile.themeMode).toBe('system')
    expect(cloud.writes()).toBe(1)

    Object.assign(cloud.document('ada'), { revision: 2, settings: { themeMode: 'dark' } })
    await tab.engine.refresh()
    await settle(tab.engine, otherTab.engine)
    expect(tab.profile.themeMode).toBe('dark')
    expect(otherTab.profile.themeMode).toBe('dark')
    expect(cloud.log.filter((entry) => entry.method === 'GET').length).toBe(3) // the start, the other tab's read, one refresh
  })

  test('a revoked session stops sync until the same account signs in again', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const device = client(cloud, 'ada', { clock })
    await device.start({ themeMode: 'system' })
    device.edit({ fontSize: 15 })
    cloud.failNext = 401
    clock.advance(DOCUMENT_SYNC_DEBOUNCE_MS)
    await settle(device.engine)
    expect(device.engine.current.state).toBe('signed-out')
    expect(clock.pending).toBe(0)

    device.signIn()
    await settle(device.engine)
    expect(cloud.document('ada').settings.fontSize).toBe(15)
    expect(device.engine.current.state).toBe('synced')
  })

  test('refreshes every minute only while foreground and online', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const device = client(cloud, 'ada', { clock })
    await device.start({ themeMode: 'system' })
    const reads = () => cloud.log.filter((entry) => entry.method === 'GET').length
    const start = reads()
    clock.advance(DOCUMENT_SYNC_POLL_MS)
    await settle(device.engine)
    expect(reads()).toBe(start + 1)
    device.environment.signal('background')
    clock.advance(DOCUMENT_SYNC_POLL_MS * 5)
    await settle(device.engine)
    expect(reads()).toBe(start + 1)
    device.environment.signal('foreground')
    await settle(device.engine)
    expect(reads()).toBe(start + 2)
  })
})

// ─── Clear and sign-out ───

describe('clearing synced settings', () => {
  test('a clear advances the generation and starts again from this device; a stale client starts again on the new copy and cannot restore the old settings', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const laptop = client(cloud, 'ada', { clock })
    const phone = client(cloud, 'ada', { clock })
    const tablet = client(cloud, 'ada', { clock })
    await laptop.start({ themeMode: 'dark' })
    await phone.start()
    await tablet.start()

    // The phone is offline with an unsent edit; the tablet edits but has not sent yet.
    phone.environment.signal('offline')
    phone.edit({ extraInstructions: 'old generation' })
    tablet.edit({ fontSize: 30 })

    // Unsent edits on the clearing client are named before anything is lost.
    laptop.edit({ showToolCalls: false })
    expect(await laptop.engine.clearCloud()).toEqual({ kind: 'has-unsent', keys: ['showToolCalls'] })
    laptop.environment.online = false
    expect(await laptop.engine.clearCloud({ discardUnsent: true })).toEqual({ kind: 'offline' })
    laptop.environment.online = true
    expect(await laptop.engine.clearCloud({ discardUnsent: true })).toEqual({ kind: 'cleared', generation: 1 })
    // The clearing device starts the document again from its own copy, as it is now.
    expect(laptop.engine.current.state).toBe('synced')
    expect(cloud.document('ada')).toMatchObject({ generation: 1, revision: 1, settings: { themeMode: 'dark', showToolCalls: false } })

    // The tablet's patch carries the old generation and is refused: it takes the new copy, and its edit goes.
    clock.advance(DOCUMENT_SYNC_DEBOUNCE_MS)
    await settle(tablet.engine, laptop.engine)
    expect(tablet.engine.current).toMatchObject({ state: 'synced', pendingKeys: [], conflicts: [] })
    expect(tablet.profile).toEqual({ themeMode: 'dark', showToolCalls: false })

    // The phone reconnects: it reads the new generation, drops its old edit, and takes the new copy.
    phone.environment.signal('online')
    await settle(phone.engine)
    expect(phone.engine.current).toMatchObject({ state: 'synced', pendingKeys: [] })
    expect(phone.profile).toEqual({ themeMode: 'dark', showToolCalls: false })
    expect(cloud.document('ada')).toMatchObject({ generation: 1, revision: 1 })

    // Edits go on against the new generation.
    phone.edit({ fontSize: 12 })
    clock.advance(DOCUMENT_SYNC_DEBOUNCE_MS)
    await settle(phone.engine)
    expect(cloud.document('ada')).toMatchObject({ generation: 1, revision: 2, settings: { themeMode: 'dark', showToolCalls: false, fontSize: 12 } })
  })

  test('a clear on a device whose copy is empty leaves the account empty until an edit', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const laptop = client(cloud, 'ada', { clock })
    const phone = client(cloud, 'ada', { clock })
    await laptop.start({ themeMode: 'dark' })
    await phone.start()
    for (const key of Object.keys(phone.profile)) delete phone.profile[key as keyof PersonalSettingsDocument]
    expect(await phone.engine.clearCloud()).toEqual({ kind: 'cleared', generation: 1 })
    expect(cloud.document('ada')).toMatchObject({ generation: 1, revision: null, settings: {} })
    expect(phone.engine.current.state).toBe('synced')
  })

  test('sign-out drops the account’s queue; signing in again reads the account anew and it wins', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const storage = memoryStorage()
    const device = client(cloud, 'ada', { clock, storage })
    await device.start({ themeMode: 'dark' })
    device.environment.online = false
    device.edit({ fontSize: 19 })

    device.engine.signOut()
    expect(device.engine.current.state).toBe('signed-out')
    expect([...storage.values.keys()]).toEqual([])

    device.environment.online = true
    device.signIn()
    expect(device.engine.current.state).toBe('loading')
    expect(device.engine.current.pendingKeys).toEqual([])
    await settle(device.engine)
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'dark' })
    expect(device.profile).toEqual({ themeMode: 'dark' })
    expect(device.engine.current.state).toBe('synced')
  })
})

// ─── Requests and organization settings ───

describe('settings requests', () => {
  test('statuses map to typed results on every adapter', async () => {
    const respond = (response: Response | null | 'signed-out') => settingsCloudRequests(async () => response)
    expect(await respond(null).accountSettingsGet()).toEqual({ kind: 'offline' })
    expect(await respond('signed-out').accountSettingsGet()).toEqual({ kind: 'signed-out' })
    expect(await respond(new Response(null, { status: 401 })).accountSettingsGet()).toEqual({ kind: 'signed-out' })
    expect(await respond(Response.json({ revision: 'x' })).accountSettingsGet()).toEqual({ kind: 'error', code: 'invalid_response', message: null })
    expect(await respond(new Response(null, { status: 403 })).organizationSettingsGet('org')).toEqual({ kind: 'forbidden' })
  })

  test('a clear that answers without a body reads the document it left', async () => {
    const sent: string[] = []
    const cleared: AccountSettingsResponse = { schemaVersion: 1, generation: 4, revision: null, settings: {}, updatedAt: 9 }
    const requests = settingsCloudRequests(async (request) => {
      sent.push(request.method)
      return request.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(cleared)
    })
    expect(await requests.accountSettingsDelete()).toEqual({ kind: 'ok', settings: cleared })
    expect(sent).toEqual(['DELETE', 'GET'])
  })

  test('the web adapter sends an account-plane access token, never the cookie, and maps a 409 to the stored document', async () => {
    const current: AccountSettingsResponse = { schemaVersion: 1, generation: 0, revision: 7, settings: { themeMode: 'dark' }, updatedAt: 1 }
    const seen: RequestInit[] = []
    const requests = webSettingsRequests(ORIGIN_A, ACCOUNT_SIGN_IN, (async (_input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(init)
      return Response.json({ error: 'settings_conflict', current }, { status: 409 })
    }) as typeof fetch)
    expect(await requests.accountSettingsPatch({ generation: 0, expectedRevision: 6, set: {}, reset: [] }))
      .toEqual({ kind: 'conflict', reason: 'settings_conflict', current })
    expect(seen[0]?.credentials).toBe('omit')
    expect(new Headers(seen[0]?.headers).get('authorization')).toBe('Bearer account-token')
    // With no sign-in, nothing is sent.
    expect(await webSettingsRequests(ORIGIN_A, { accessToken: async () => null }).accountSettingsGet()).toEqual({ kind: 'signed-out' })
  })
})

describe('authenticated adapters', () => {
  test('desktop main sends nothing without a session and reports an unanswered request as offline', async () => {
    const paths: string[] = []
    const main = { cloudOrigin: ORIGIN_A, isSignedIn: false, cloudRequest: async (path: string) => { paths.push(path); return null } }
    expect(await desktopSettingsRequests(main).accountSettingsGet()).toEqual({ kind: 'signed-out' })
    expect(paths).toEqual([])
    main.isSignedIn = true
    expect(await desktopSettingsRequests(main).accountSettingsGet()).toEqual({ kind: 'offline' })
    expect(paths).toEqual([ACCOUNT_SETTINGS_PATH])
  })

  test('the native client sends an account access token as a bearer, got for each call, and reports a 401', async () => {
    const seen: Headers[] = []
    const client = new CloudAccountClient(ORIGIN_A, (async (_input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers))
      return new Response(null, { status: 401 })
    }) as typeof fetch)
    let refusals = 0
    const requests = client.settingsRequests(async () => 'access-1', () => { refusals += 1 })
    expect(await requests.accountSettingsGet()).toEqual({ kind: 'signed-out' })
    expect(seen[0]?.get('authorization')).toBe('Bearer access-1')
    expect(refusals).toBe(1)
    // No token (signed out): nothing is sent.
    expect(await client.settingsRequests(async () => null, () => {}).accountSettingsGet()).toEqual({ kind: 'signed-out' })
    expect(seen.length).toBe(1)
  })
})

describe('organization settings client', () => {
  const organization: OrganizationSettingsResponse = {
    organizationId: 'org',
    name: 'Acme',
    canManageSettings: true,
    revision: 2,
    settings: { syncAllInsights: true },
  }

  test('saves Sync all Insights against a revision, maps a concurrent save to a conflict, and refuses a bad request before sending', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const client = new OrganizationSettingsClient(settingsCloudRequests(async (request) => {
      calls.push({ method: request.method, path: request.path, body: request.body })
      return Response.json({ error: 'settings_conflict', current: organization }, { status: 409 })
    }))
    expect(await client.save('org', 1, { syncAllInsights: false }))
      .toEqual({ kind: 'conflict', current: organization })
    // Only the setting carried changes; the revision read rides along.
    expect(calls).toEqual([{ method: 'PATCH', path: organizationSettingsPath('org'), body: { expectedRevision: 1, settings: { syncAllInsights: false } } }])

    const refused = await client.save('org', -1, { syncAllInsights: true })
    expect(refused.kind).toBe('invalid')
    expect(calls.length).toBe(1)
  })

  test('a member who is not allowed to save gets forbidden, not a silent success', async () => {
    const client = new OrganizationSettingsClient(settingsCloudRequests(async () => new Response(null, { status: 403 })))
    expect(await client.save('org', 2, { syncAllInsights: false })).toEqual({ kind: 'forbidden' })
  })
})
