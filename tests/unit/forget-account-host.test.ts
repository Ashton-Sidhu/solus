import { afterAll, describe, expect, mock, test } from 'bun:test'
import { configureUplinkAccountSource } from '@solus/client-core/uplink-account'
import { oauthUplinkAccountSource, type UplinkAccountSource } from '@solus/client-core/uplink-session'

mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', info: () => '', dismiss: () => {} }) }))
mock.module('@solus/workspace-ui/contexts/notifications/notifications.store.svelte', () => ({
  notificationsStore: { wants: () => false },
}))

// A host this account owns is listed by the account on every device, so forgetting
// it on one device alone came back on the next directory read. Forget removes it
// from the account first, and forgets it here only once the account agrees.

const values = new Map<string, string>()
const previousLocalStorage = globalThis.localStorage
const previousState = (globalThis as unknown as { $state?: unknown }).$state
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  } satisfies Storage,
})
;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
// Forget returns focus to the input with a window event.
const previousWindow = globalThis.window
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  },
})
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  writable: true,
  value: {
    documentElement: { classList: { toggle: () => {} } },
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    hasFocus: () => true,
  },
})

const { serversStore } = await import('@solus/workspace-ui/contexts/connections/servers.store.svelte')
const { toasts } = await import('@solus/workspace-ui/lib/toasts')
const { upsertServer } = await import('@solus/client-core/server-registry')

afterAll(() => {
  configureUplinkAccountSource(null)
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
  else Reflect.deleteProperty(globalThis, 'document')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: previousLocalStorage })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function saveHost(): void {
  values.set('solus.activeServerId', 'local')
  values.set('solus.servers', JSON.stringify([{
    id: 'omarchy',
    label: 'omarchy',
    url: '',
    sessionToken: '',
    installationId: 'omarchy',
    lastConnected: 1,
    routes: [{ kind: 'direct', url: 'http://10.10.1.79:3000' }],
    uplink: { hostId: 'host_omarchy', directoryUrl: 'https://app.solus.test' },
  }]))
  serversStore.refreshServers()
  serversStore.activeServerId = 'local'
}

function accountSource(removeHost: (hostId: string) => Promise<boolean>): UplinkAccountSource {
  return {
    listDirectory: async () => null,
    accessToken: async () => null,
    issueEnrollmentTicket: async () => null,
    loadOrganizationDirectory: async () => null,
    startManagedHost: async () => null,
    removeHost,
  }
}

const savedIds = () => (JSON.parse(values.get('solus.servers') ?? '[]') as Array<{ id: string }>).map((server) => server.id)

describe('forgetting a host the account lists', () => {
  test('the host leaves the account before this device forgets it', async () => {
    saveHost()
    const removed: string[] = []
    configureUplinkAccountSource(accountSource(async (hostId) => { removed.push(hostId); return true }))

    await serversStore.remove('omarchy')

    expect(removed).toEqual(['host_omarchy'])
    expect(savedIds()).toEqual([])
  })

  test('a refused removal keeps the host, so the list never claims it is gone', async () => {
    saveHost()
    configureUplinkAccountSource(accountSource(async () => false))

    await serversStore.remove('omarchy')

    expect(savedIds()).toEqual(['omarchy'])
  })

  test('forgetting twice at once ends with the host gone and no error', async () => {
    // WHY: a double click or a retry must not fail on a host already removed.
    saveHost()
    configureUplinkAccountSource(accountSource(async () => true))
    const errors: string[] = []
    const originalError = toasts.error
    toasts.error = (message: string) => { errors.push(message) }
    try {
      await Promise.all([serversStore.remove('omarchy'), serversStore.remove('omarchy')])
      await serversStore.remove('omarchy')
    } finally {
      toasts.error = originalError
    }

    expect(savedIds()).toEqual([])
    expect(errors).toEqual([])
  })
})

describe('adding a host', () => {
  test('pairing a host the account already lists leaves one row', () => {
    // WHY: pairing and the account list name a host by its installation id, so
    // adding it again replaces the row instead of listing the machine twice.
    saveHost()
    upsertServer({ id: 'omarchy', label: 'omarchy', url: 'http://10.10.1.79:3000', sessionToken: 'token', installationId: 'omarchy', lastConnected: 2 })
    upsertServer({ id: 'omarchy', label: 'omarchy', url: 'http://10.10.1.79:3000', sessionToken: 'token', installationId: 'omarchy', lastConnected: 3 })

    expect(savedIds()).toEqual(['omarchy'])
  })
})

describe('removing a host from the web client', () => {
  test('deletes the host on the serving origin with the account token', async () => {
    const calls: Array<{ url: string; method: string | undefined; authorization: string | null }> = []
    const source = oauthUplinkAccountSource('https://app.solus.test', { accessToken: async () => 'account-token' }, (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, authorization: new Headers(init?.headers).get('authorization') })
      return new Response(null, { status: 204 })
    }) as typeof fetch)

    expect(await source.removeHost('host_omarchy')).toBe(true)
    expect(calls).toEqual([{ url: 'https://app.solus.test/v1/hosts/host_omarchy', method: 'DELETE', authorization: 'Bearer account-token' }])
  })

  test('a host the account no longer lists is already removed', async () => {
    const source = oauthUplinkAccountSource('https://app.solus.test', { accessToken: async () => 'account-token' }, (async () => new Response('{}', { status: 404 })) as typeof fetch)
    expect(await source.removeHost('host_omarchy')).toBe(true)
  })

  test('a refusal reads as not removed', async () => {
    const source = oauthUplinkAccountSource('https://app.solus.test', { accessToken: async () => 'account-token' }, (async () => new Response('{}', { status: 403 })) as typeof fetch)
    expect(await source.removeHost('host_omarchy')).toBe(false)
  })
})
