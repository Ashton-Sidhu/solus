import { identityKeyFor, signedHealth } from './helpers/signing-host'
import { describe, expect, test } from 'bun:test'
import { HostPairingFollower } from '@solus/client-core/host-pairing-follower'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { HostPairingsSnapshot } from '@solus/contracts/host-pairing'
import type { KnownHost } from '@solus/client-core/known-host'

const KEY = identityKeyFor('windows')
const listing = { id: 'windows', installationId: 'windows', label: 'Windows', routes: [{ url: 'http://10.0.0.2:3000', kind: 'lan' as const }], identityKey: KEY, lastConnected: 1 }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function harness(options: { owner?: boolean; gate?: Promise<void>; impostor?: boolean } = {}) {
  let snapshot: HostPairingsSnapshot = { hosts: [listing], forgotten: [] }
  const hosts: KnownHost[] = []
  let claims = 0
  const sent: string[] = []
  const started = deferred()
  const errors: string[] = []
  const events = new HostEventSubscriber()
  const follower = new HostPairingFollower({
    api: {
      connectionsGetServerInfo: async () => ({ principal: options.owner === false ? 'org-member' : 'local-owner', permissions: ['host.local'], installationId: 'mac' }),
      hostsListPaired: async () => snapshot,
      hostsPairClient: async () => { claims++; return { listing, url: listing.routes[0]!.url, code: 'one-use-client-code' } },
    },
    events, hosts: () => hosts,
    save: async (host) => { hosts.push(host) },
    forget: async (id) => { const index = hosts.findIndex((host) => host.id === id); if (index !== -1) hosts.splice(index, 1) },
    deviceLabel: 'My phone', onError: (message) => errors.push(message),
    fetchImpl: async (input, init) => {
      if (new URL(String(input)).pathname === '/health') return Response.json(signedHealth(input, options.impostor ? 'impostor' : 'windows'))
      sent.push(String(init?.body))
      started.resolve()
      await options.gate
      return Response.json({ sessionToken: 'phone-token', installationId: 'windows', identityKey: KEY })
    },
  })
  return { follower, hosts, errors, sent, started: started.promise, claims: () => claims, change: (value: HostPairingsSnapshot) => { snapshot = value } }
}

describe('client pairing after a chat or CLI add', () => {
  test('gets a separate client credential once, then forgets when the host is removed', async () => {
    const h = harness()
    try {
      await h.follower.refresh()
      expect(h.hosts[0]?.sessionToken).toBe('phone-token')
      expect(h.sent[0]).toContain('one-use-client-code')
      expect(h.sent[0]).toContain('My phone')
      await h.follower.refresh()
      expect(h.claims()).toBe(1)
      h.change({ hosts: [], forgotten: ['windows'] })
      await h.follower.refresh()
      expect(h.hosts).toEqual([])
    } finally { h.follower.dispose() }
  })
  test('members never request owner pairing credentials', async () => {
    const h = harness({ owner: false })
    try { await h.follower.refresh(); expect(h.claims()).toBe(0); expect(h.hosts).toEqual([]) }
    finally { h.follower.dispose() }
  })
  test('a disposed connection never saves a late HTTP pairing', async () => {
    const gate = deferred()
    const h = harness({ gate: gate.promise })
    const read = h.follower.refresh()
    await h.started
    h.follower.dispose()
    gate.resolve()
    await read
    expect(h.hosts).toEqual([])
  })
  test('forget during the exchange cannot be undone by its late HTTP reply', async () => {
    const gate = deferred()
    const h = harness({ gate: gate.promise })
    try {
      const read = h.follower.refresh()
      await h.started
      h.change({ hosts: [], forgotten: ['windows'] })
      gate.resolve()
      await read
      expect(h.hosts).toEqual([])
    } finally { h.follower.dispose() }
  })
})

 test('a host at a reused address gets no client pairing code', async () => {
  const h = harness({ impostor: true })
  try {
    await h.follower.refresh()
    expect(h.sent).toEqual([])
    expect(h.hosts).toEqual([])
    expect(h.errors).toHaveLength(1)
  } finally { h.follower.dispose() }
})
