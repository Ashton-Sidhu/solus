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
  cookieSettingsRequests,
  settingsCloudRequests,
  type SettingsCloudRequests,
} from '@solus/client-core/settings-requests'
import {
  OrganizationSettingsClient,
  SETTINGS_SYNC_DEBOUNCE_MS,
  SETTINGS_SYNC_POLL_MS,
  SettingsSync,
  type PersonalSettingsChange,
  type SettingsSyncBroadcast,
  type SettingsSyncEnvironment,
  type SettingsSyncMessage,
  type SettingsSyncSignal,
  type SettingsSyncStatus,
  type SettingsSyncStorage,
  type SyncAccount,
} from '@solus/client-core/settings-sync'

// Personal settings sync (plans/018 §5): opt-in per client and account, a durable
// pending patch merged three ways against a compare-and-swap revision, and a
// generation that a clear advances so an old client cannot restore what was cleared.

// ─── Fakes ───

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

class FakeEnvironment implements SettingsSyncEnvironment {
  online = true
  foreground = true
  private listeners = new Set<(signal: SettingsSyncSignal) => void>()
  isOnline = () => this.online
  isForeground = () => this.foreground
  subscribe(listener: (signal: SettingsSyncSignal) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  signal(signal: SettingsSyncSignal): void {
    if (signal === 'online' || signal === 'offline') this.online = signal === 'online'
    if (signal === 'foreground' || signal === 'background') this.foreground = signal === 'foreground'
    for (const listener of this.listeners) listener(signal)
  }
}

function memoryStorage(): SettingsSyncStorage & { values: Map<string, string> } {
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
  private ports = new Set<(message: SettingsSyncMessage) => void>()
  port(): SettingsSyncBroadcast {
    let own: ((message: SettingsSyncMessage) => void) | null = null
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
  const transport = switchableRequests(cookieSettingsRequests(cloud.origin, cloud.fetchFor(userId)))
  const engine = new SettingsSync({
    requests: transport.requests,
    storage,
    environment,
    clock: { now: shared.clock.now, setTimer: shared.clock.setTimer },
    broadcast: shared.hub?.port(),
  })
  const profile: PersonalSettingsDocument = {}
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
    /** Turns sync on, seeding from `seed` (the local profile) when the cloud has no document. */
    async turnOn(seed: PersonalSettingsDocument = {}) {
      const prepared = await engine.prepareEnable()
      if (prepared.kind !== 'offer') throw new Error(`no offer: ${prepared.kind}`)
      if (prepared.offer.kind === 'absent') Object.assign(profile, seed)
      const outcome = prepared.offer.kind === 'absent'
        ? await engine.enable({ kind: 'seed', settings: seed })
        : await engine.enable({ kind: 'use-synced' })
      await engine.idle()
      return outcome
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

// ─── Consent ───

describe('settings sync consent', () => {
  test('a signed-out client and a signed-in client with sync off send nothing', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const device = client(cloud, 'ada', { clock })

    expect(device.engine.current.state).toBe('signed-out')
    expect(device.edit({ themeMode: 'dark' })).toBe('ignored')
    await device.engine.refresh()

    // Signing in alone is not consent.
    device.signIn()
    expect(device.engine.current.state).toBe('off')
    expect(device.edit({ showToolCalls: false })).toBe('ignored')
    device.environment.signal('background')
    device.environment.signal('foreground')
    device.environment.signal('offline')
    device.environment.signal('online')
    await device.engine.refresh()
    clock.advance(SETTINGS_SYNC_POLL_MS * 3)
    await settle(device.engine)

    expect(cloud.log).toEqual([])
    expect(clock.pending).toBe(0)
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
      device.transport.use(cookieSettingsRequests(ORIGIN_A, cloudA.fetchFor('ada')))
      device.engine.setAccount({ origin: ORIGIN_A, userId: 'ada' })
    }
    const asBob = () => {
      device.transport.use(cookieSettingsRequests(ORIGIN_B, cloudB.fetchFor('bob')))
      device.engine.setAccount({ origin: ORIGIN_B, userId: 'bob' })
    }
    // Both accounts have sync on, at the same generation and revision.
    device.signIn()
    await device.turnOn({ themeMode: 'system' })
    asAda()
    await device.turnOn({ themeMode: 'system' })

    // Another device of A changes the theme; this device has an unsent edit for A.
    Object.assign(cloudA.document('ada'), { revision: 2, settings: { themeMode: 'dark' } })
    device.environment.online = false
    device.edit({ extraInstructions: 'A only' })
    device.environment.online = true

    // A's refresh and an enable offer are in flight when the person switches to B.
    cloudA.hold()
    const lateRefresh = device.engine.refresh()
    const lateOffer = device.engine.prepareEnable()
    await Promise.resolve()
    device.applied.length = 0
    asBob()
    expect(device.engine.current.account).toEqual({ origin: ORIGIN_B, userId: 'bob' })
    cloudA.release()
    await lateRefresh
    expect(await lateOffer).toEqual({ kind: 'cancelled' })
    clock.advance(SETTINGS_SYNC_DEBOUNCE_MS * 2)
    await settle(device.engine)

    // Nothing of A's reached B: no applied change, no conflict, no stop.
    expect(device.applied).toEqual([])
    expect(device.engine.current).toMatchObject({ state: 'synced', pendingKeys: [], conflicts: [], stoppedReason: null })
    // The late offer cannot be used for B.
    expect(await device.engine.enable({ kind: 'use-synced' })).toEqual({ kind: 'invalid' })
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
  test('first enable reads the cloud first and never silently overwrites a document someone else created', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const first = client(cloud, 'ada', { clock })
    const second = client(cloud, 'ada', { clock })
    first.signIn()
    second.signIn()

    const firstOffer = await first.engine.prepareEnable()
    const secondOffer = await second.engine.prepareEnable()
    expect(firstOffer).toEqual({ kind: 'offer', offer: { kind: 'absent', generation: 0 } })
    expect(secondOffer).toEqual(firstOffer)
    expect(cloud.writes()).toBe(0)

    expect(await first.engine.enable({ kind: 'seed', settings: { themeMode: 'dark' } })).toEqual({ kind: 'enabled' })
    // The second seed races the first and loses: it is shown the document instead.
    const raced = await second.engine.enable({ kind: 'seed', settings: { themeMode: 'light' } })
    expect(raced).toEqual({ kind: 'changed', offer: { kind: 'present', generation: 0, revision: 1, settings: { themeMode: 'dark' }, updatedAt: expect.any(Number) } })
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'dark' })
    expect(second.engine.current.state).toBe('off')

    // "Use synced settings" applies the cloud document to the local profile.
    expect(await second.engine.enable({ kind: 'use-synced' })).toEqual({ kind: 'enabled' })
    await settle(second.engine)
    expect(second.profile.themeMode).toBe('dark')
    expect(second.engine.current.state).toBe('synced')
  })

  test('"Replace with this device" writes only over the revision it was offered', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const device = client(cloud, 'ada', { clock })
    Object.assign(cloud.document('ada'), { revision: 3, settings: { themeMode: 'dark', showToolCalls: false } })
    device.signIn()
    const prepared = await device.engine.prepareEnable()
    expect(prepared.kind === 'offer' && prepared.offer.kind).toBe('present')

    cloud.document('ada').revision = 4
    const stale = await device.engine.enable({ kind: 'replace', settings: { themeMode: 'light' } })
    expect(stale.kind).toBe('changed')
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'dark', showToolCalls: false })

    expect(await device.engine.enable({ kind: 'replace', settings: { themeMode: 'light' } })).toEqual({ kind: 'enabled' })
    // Replace means the cloud becomes this device: keys it does not hold return to default.
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'light' })
  })

  test('two clients converge, and edits to different keys merge across a stale revision', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const laptop = client(cloud, 'ada', { clock })
    const phone = client(cloud, 'ada', { clock })
    laptop.signIn()
    phone.signIn()
    await laptop.turnOn({ themeMode: 'dark', fontSize: 14 })
    await phone.turnOn()
    expect(phone.profile).toEqual({ themeMode: 'dark', fontSize: 14 })

    // Both edit from revision 1, different keys.
    laptop.edit({ showToolCalls: false })
    phone.edit({ fontSize: 16 })
    clock.advance(SETTINGS_SYNC_DEBOUNCE_MS)
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
    laptop.signIn()
    phone.signIn()
    await laptop.turnOn({ themeMode: 'system' })
    await phone.turnOn()

    laptop.edit({ themeMode: 'dark' })
    clock.advance(SETTINGS_SYNC_DEBOUNCE_MS)
    await settle(laptop.engine)
    phone.edit({ themeMode: 'light', fontSize: 18 })
    clock.advance(SETTINGS_SYNC_DEBOUNCE_MS)
    await settle(phone.engine)

    // The unrelated key went through; the theme did not overwrite the laptop's.
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'dark', fontSize: 18 })
    expect(phone.engine.current.state).toBe('conflict')
    expect(phone.engine.current.conflicts).toEqual([{ key: 'themeMode', mine: { themeMode: 'light' }, theirs: { themeMode: 'dark' } }])
    expect(phone.profile.themeMode).toBe('light')

    // It stays a conflict across refreshes and polls.
    clock.advance(SETTINGS_SYNC_POLL_MS)
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
    device.signIn()
    await device.turnOn({ themeMode: 'system' })
    Object.assign(cloud.document('ada'), { revision: 2, settings: { themeMode: 'dark' } })
    device.edit({ themeMode: 'light' })
    clock.advance(SETTINGS_SYNC_DEBOUNCE_MS)
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
    before.signIn()
    await before.turnOn({ themeMode: 'system' })
    environment.signal('offline')
    before.edit({ extraInstructions: 'Be brief.' })
    clock.advance(SETTINGS_SYNC_DEBOUNCE_MS)
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
    device.signIn()
    await device.turnOn({ themeMode: 'system' })
    const confirmedAt = device.engine.current.lastSyncedAt
    expect(confirmedAt).not.toBeNull()
    clock.advance(10)

    device.statuses.length = 0
    device.edit({ showToolCalls: false })
    cloud.failNext = 500
    clock.advance(SETTINGS_SYNC_DEBOUNCE_MS)
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
    tab.signIn()
    otherTab.signIn()
    await tab.turnOn({ themeMode: 'system' })
    await settle(tab.engine, otherTab.engine)
    expect(otherTab.engine.current.state).toBe('synced')

    Object.assign(cloud.document('ada'), { revision: 2, settings: { themeMode: 'dark' } })
    await tab.engine.refresh()
    await settle(tab.engine, otherTab.engine)
    expect(tab.profile.themeMode).toBe('dark')
    expect(otherTab.profile.themeMode).toBe('dark')
    expect(cloud.log.filter((entry) => entry.method === 'GET').length).toBe(2) // the offer and one refresh
  })

  test('a revoked session stops sync until the same account signs in again', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const device = client(cloud, 'ada', { clock })
    device.signIn()
    await device.turnOn({ themeMode: 'system' })
    device.edit({ fontSize: 15 })
    cloud.failNext = 401
    clock.advance(SETTINGS_SYNC_DEBOUNCE_MS)
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
    device.signIn()
    await device.turnOn({ themeMode: 'system' })
    const reads = () => cloud.log.filter((entry) => entry.method === 'GET').length
    const start = reads()
    clock.advance(SETTINGS_SYNC_POLL_MS)
    await settle(device.engine)
    expect(reads()).toBe(start + 1)
    device.environment.signal('background')
    clock.advance(SETTINGS_SYNC_POLL_MS * 5)
    await settle(device.engine)
    expect(reads()).toBe(start + 1)
    device.environment.signal('foreground')
    await settle(device.engine)
    expect(reads()).toBe(start + 2)
  })
})

// ─── Off and clear ───

describe('turning sync off and clearing synced settings', () => {
  test('turning off on this device stops every transfer and leaves the cloud and local values alone', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const device = client(cloud, 'ada', { clock })
    device.signIn()
    await device.turnOn({ themeMode: 'dark' })
    device.edit({ fontSize: 20 })
    const requests = cloud.log.length

    device.engine.turnOff()
    expect(device.engine.current.state).toBe('off')
    expect(device.edit({ fontSize: 22 })).toBe('ignored')
    clock.advance(SETTINGS_SYNC_POLL_MS * 3)
    device.environment.signal('foreground')
    await device.engine.refresh()
    await settle(device.engine)

    expect(cloud.log.length).toBe(requests)
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'dark' })
    expect(device.profile).toEqual({ themeMode: 'dark', fontSize: 22 })
    expect(device.applied).toEqual([])
  })

  test('a clear advances the generation; a stale client turns off, cannot restore the old settings, and must be turned on again', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const laptop = client(cloud, 'ada', { clock })
    const phone = client(cloud, 'ada', { clock })
    const tablet = client(cloud, 'ada', { clock })
    for (const device of [laptop, phone, tablet]) device.signIn()
    await laptop.turnOn({ themeMode: 'dark' })
    await phone.turnOn()
    await tablet.turnOn()

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
    expect(laptop.engine.current.state).toBe('off')
    expect(laptop.profile.themeMode).toBe('dark')
    expect(cloud.document('ada')).toMatchObject({ generation: 1, revision: null, settings: {} })

    // The tablet's patch carries the old generation and is refused.
    clock.advance(SETTINGS_SYNC_DEBOUNCE_MS)
    await settle(tablet.engine, laptop.engine)
    expect(tablet.engine.current.state).toBe('off')
    expect(tablet.engine.current.stoppedReason).toBe('generation-changed')

    // The phone reconnects: it reads the new generation and drops its old edit.
    phone.environment.signal('online')
    await settle(phone.engine)
    expect(phone.engine.current.state).toBe('off')
    expect(phone.engine.current.stoppedReason).toBe('generation-changed')
    expect(phone.engine.current.pendingKeys).toEqual([])
    expect(cloud.document('ada')).toMatchObject({ generation: 1, revision: null, settings: {} })

    // Nothing resumes on its own.
    expect(phone.edit({ fontSize: 12 })).toBe('ignored')
    clock.advance(SETTINGS_SYNC_POLL_MS * 2)
    await phone.engine.refresh()
    await settle(phone.engine, tablet.engine)
    expect(cloud.document('ada').revision).toBeNull()

    // Turning on again starts from the new generation.
    const prepared = await phone.engine.prepareEnable()
    expect(prepared).toEqual({ kind: 'offer', offer: { kind: 'absent', generation: 1 } })
    expect(await phone.engine.enable({ kind: 'seed', settings: { themeMode: 'light' } })).toEqual({ kind: 'enabled' })
    expect(cloud.document('ada')).toMatchObject({ generation: 1, revision: 1, settings: { themeMode: 'light' } })
  })

  test('sign-out drops the account’s consent and queue; signing in again starts off', async () => {
    const cloud = new FakeCloud(ORIGIN_A)
    const clock = new FakeClock()
    const storage = memoryStorage()
    const device = client(cloud, 'ada', { clock, storage })
    device.signIn()
    await device.turnOn({ themeMode: 'dark' })
    device.environment.online = false
    device.edit({ fontSize: 19 })

    device.engine.signOut()
    expect(device.engine.current.state).toBe('signed-out')
    expect([...storage.values.keys()]).toEqual([])

    device.environment.online = true
    device.signIn()
    expect(device.engine.current.state).toBe('off')
    expect(device.engine.current.pendingKeys).toEqual([])
    clock.advance(SETTINGS_SYNC_POLL_MS * 2)
    await settle(device.engine)
    expect(cloud.document('ada').settings).toEqual({ themeMode: 'dark' })
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

  test('the web adapter sends the cookie and maps a 409 to the stored document', async () => {
    const current: AccountSettingsResponse = { schemaVersion: 1, generation: 0, revision: 7, settings: { themeMode: 'dark' }, updatedAt: 1 }
    const seen: RequestInit[] = []
    const requests = cookieSettingsRequests(ORIGIN_A, (async (_input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(init)
      return Response.json({ error: 'settings_conflict', current }, { status: 409 })
    }) as typeof fetch)
    expect(await requests.accountSettingsPatch({ generation: 0, expectedRevision: 6, set: {}, reset: [] }))
      .toEqual({ kind: 'conflict', reason: 'settings_conflict', current })
    expect(seen[0]?.credentials).toBe('include')
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

  test('the native client sends its session as a bearer token and reports which token a 401 refused', async () => {
    const seen: Headers[] = []
    const client = new CloudAccountClient(ORIGIN_A, (async (_input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers))
      return new Response(null, { status: 401 })
    }) as typeof fetch)
    const refused: string[] = []
    const requests = client.settingsRequests(() => 'token-1', (token) => refused.push(token))
    expect(await requests.accountSettingsGet()).toEqual({ kind: 'signed-out' })
    expect(seen[0]?.get('authorization')).toBe('Bearer token-1')
    expect(refused).toEqual(['token-1'])
    expect(await client.settingsRequests(() => null, () => {}).accountSettingsGet()).toEqual({ kind: 'signed-out' })
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
