import { afterAll, describe, expect, mock, test } from 'bun:test'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostReadinessState } from '@solus/client-core/host-readiness'

mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', info: () => '', dismiss: () => {} }) }))
mock.module('@solus/workspace-ui/contexts/notifications/notifications.store.svelte', () => ({
  notificationsStore: { wants: () => false },
}))

const previousLocalStorage = globalThis.localStorage
const previousState = (globalThis as unknown as { $state?: unknown }).$state

const values = new Map<string, string>([
  ['solus.activeServerId', 'local'],
  ['solus.servers', JSON.stringify([{
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
  }])],
])

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

// The store is a module singleton shared with other test files (e.g. server
// removal deletes 'remote' from its in-memory list); re-read this file's
// localStorage so the fixture host exists regardless of execution order.
serversStore.refreshServers()

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

type ReadinessListener = Parameters<typeof serverConnections.onReadinessChange>[0]

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

  test('the host a web client booted against wears its operating system', async () => {
    // WHY: a web client's serving host is never saved, so it has no entry to
    // carry the OS that /health reports. Without it the Run on chip shows the
    // unknown-OS globe for a Mac.
    const originalIds = serverConnections.connectedServerIds
    const originalConnectionFor = serverConnections.connectionFor
    const originalProbeHealth = serverConnections.probeHealth
    const serving = {
      link: { readiness: 'ready', attempt: 0 },
      target: { id: 'serving-host', label: 'Mac mini', url: 'https://mac-mini.example', local: false },
    } as unknown as ReturnType<typeof serverConnections.connectionFor>
    serverConnections.connectedServerIds = () => ['serving-host']
    serverConnections.connectionFor = (serverId) => serverId === 'serving-host' ? serving : undefined
    serverConnections.probeHealth = async () => ({ ok: true, installationId: 'serving-host', name: 'Mac mini', os: 'macos' })

    try {
      serversStore.trackConnections()
      // SAFETY: the listener set is the one a host link reports into; calling it is a readiness change.
      const listeners = (serverConnections as unknown as { readinessListeners: Set<ReadinessListener> }).readinessListeners
      for (const listener of listeners) listener('serving-host', 'ready', 0)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(serversStore.servers.find((server) => server.id === 'serving-host')?.os).toBe('macos')
    } finally {
      serverConnections.connectedServerIds = originalIds
      serverConnections.connectionFor = originalConnectionFor
      serverConnections.probeHealth = originalProbeHealth
    }
  })
})
