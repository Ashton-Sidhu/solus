import { afterAll, describe, expect, mock, test } from 'bun:test'
import { serverConnections } from '@solus/client-core/server-connections'
import { hostCatalog } from '@solus/client-core/host-catalog'
import type { HostReadinessState } from '@solus/client-core/host-readiness'
import { pairPageHosts } from './helpers/page-host-catalog'

mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', info: () => '', dismiss: () => {} }) }))
mock.module('@solus/workspace-ui/contexts/notifications/notifications.store.svelte', () => ({
  notificationsStore: { wants: () => false },
}))

const previousLocalStorage = globalThis.localStorage
const previousState = (globalThis as unknown as { $state?: unknown }).$state

const values = new Map<string, string>([['solus.activeServerId', 'local']])

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  } satisfies Storage,
})
;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value

const { serversStore } = await import('@solus/workspace-ui/contexts/connections/servers.store.svelte')

// The page's catalog is a module singleton shared with other test files: this
// file pairs its own hosts, so they exist regardless of execution order.
await pairPageHosts([{
  id: 'remote',
  label: 'Build host',
  routes: [{ kind: 'lan', url: 'http://10.10.1.22:3000', source: 'pairing', seenAt: 1 }],
  sessionToken: 'token',
  installationId: 'build-host',
  lastConnected: 1,
}, {
  id: 'early-host',
  label: 'Cloud host',
  routes: [{ kind: 'lan', url: 'https://early-host.example', source: 'pairing', seenAt: 1 }],
  sessionToken: 'token',
  installationId: 'early-host',
  lastConnected: 1,
}])

afterAll(() => {
  if (previousLocalStorage === undefined) {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: previousLocalStorage,
    })
  }
  if (previousState === undefined) {
    delete (globalThis as unknown as { $state?: unknown }).$state
  } else {
    ;(globalThis as unknown as { $state: unknown }).$state = previousState
  }
})


function state(readiness: HostReadinessState['readiness'], refusedReason: HostReadinessState['refusedReason'] = null): HostReadinessState {
  return { readiness, away: readiness === 'unreachable' || readiness === 'refused' || readiness === 'gone', unreachableReason: readiness === 'unreachable' ? 'no-answer' : null, refusedReason, lastSeenAt: null }
}

/** Answer `readinessFor` from `answers` for the length of `run`, as the host links would. */
async function withReadiness(answers: Record<string, HostReadinessState>, run: () => void | Promise<void>): Promise<void> {
  const original = serverConnections.readinessFor
  serverConnections.readinessFor = (serverId) => answers[serverId] ?? original.call(serverConnections, serverId)
  try {
    await run()
  } finally {
    serverConnections.readinessFor = original
  }
}

describe('server readiness', () => {
  test('a host row and readinessFor give the same answer as the host moves', async () => {
    // WHY: a page mounted while a host is dialed must advance with the picker
    // instead of keeping a different copy of the host's state.
    const answers: Record<string, HostReadinessState> = { remote: state('checking') }
    await withReadiness(answers, () => {
      expect(serversStore.readinessFor('remote').readiness).toBe('checking')
      expect(serversStore.servers.find((server) => server.id === 'remote')?.readiness).toBe('checking')

      answers.remote = state('ready')
      expect(serversStore.readinessFor('remote').readiness).toBe('ready')
      expect(serversStore.servers.find((server) => server.id === 'remote')?.readiness).toBe('ready')
    })
  })

  test('an identity mismatch is distinct from an offline host', async () => {
    // WHY: retrying cannot fix an address that now reaches a different Solus
    // installation. The host row must tell the user to pair deliberately.
    await withReadiness({ remote: state('refused', 'identity-mismatch') }, () => {
      expect(serversStore.readinessFor('remote')).toMatchObject({ readiness: 'refused', refusedReason: 'identity-mismatch' })
      expect(serversStore.servers.find((server) => server.id === 'remote')?.readiness).toBe('refused')
    })
  })

  test('a host that was ready before tracking began still reads as ready', async () => {
    // WHY: boot dials saved hosts before the app mounts. A host that is ready in
    // that gap never announces it again, and the Run on picker only appears for
    // a ready remote — so the store reads the link, not a copy it tracked.
    await withReadiness({ 'early-host': state('ready') }, () => {
      serversStore.trackConnections()

      expect(serversStore.readinessFor('early-host').readiness).toBe('ready')
      expect(serversStore.connectedRemotes.map((server) => server.id)).toContain('early-host')
    })
  })

  test('a host the catalog no longer names is not listed, even while its socket is open', () => {
    // WHY: the list reads the host store. An open socket to a forgotten host kept it in
    // Run on, online, under the name the host reports.
    const originalIds = serverConnections.serverIds
    const originalConnectionFor = serverConnections.connectionFor
    const forgotten = {
      link: { readiness: 'ready', attempt: 0 },
      target: { id: 'forgotten-host', label: 'sidhu', url: 'http://10.10.1.10:3000', sessionToken: '', local: false },
    } as unknown as ReturnType<typeof serverConnections.connectionFor>
    serverConnections.serverIds = () => ['forgotten-host']
    serverConnections.connectionFor = (serverId) => serverId === 'forgotten-host' ? forgotten : undefined
    try {
      expect(serversStore.servers.map((server) => server.id)).not.toContain('forgotten-host')
    } finally {
      serverConnections.serverIds = originalIds
      serverConnections.connectionFor = originalConnectionFor
    }
  })

  test('the host a web client booted against wears its operating system', () => {
    // WHY: a web client's serving host may be one this browser never saved. It is in
    // the catalog for the page, so the OS its /health reports must reach its row;
    // without it the Run on chip shows the unknown-OS globe for a Mac.
    hostCatalog.addPageHost({ id: 'serving-host', label: 'Mac mini', sessionToken: '', installationId: 'serving-host', lastConnected: 0, routes: [{ kind: 'lan', url: 'https://mac-mini.example' }] })
    hostCatalog.stampOperatingSystem('serving-host', 'macos')

    expect(serversStore.servers.find((server) => server.id === 'serving-host')?.os).toBe('macos')
  })
})
