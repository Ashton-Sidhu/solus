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
const PAIRED_AT = 1_000
function harness(options: { owner?: boolean; gate?: Promise<void>; impostor?: boolean; forgetFails?: boolean; refused?: boolean; listError?: Error; readError?: Error; pairError?: Error } = {}) {
  let snapshot: HostPairingsSnapshot = { hosts: [{ listing, pairedAt: PAIRED_AT }], forgotten: [] }
  const hosts: KnownHost[] = []
  let claims = 0
  const errors: string[] = []
  const sent: string[] = []
  const started = deferred()
  const events = new HostEventSubscriber()
  let refused = options.refused ?? false
  let pairError = options.pairError ?? null
  const follower = new HostPairingFollower({
    serverInfo: async () => ({ principal: options.owner === false ? 'org-member' : 'local-owner', permissions: ['host.local'], installationId: 'mac' }),
    api: {
      hostsListPaired: async () => {
        if (options.readError) throw options.readError
        return snapshot
      },
      hostsPairClient: async () => {
        claims++
        if (pairError) throw pairError
        return { listing, url: listing.routes[0]!.url, code: 'one-use-client-code' } },
    },
    events, hosts: () => hosts,
    save: async (host) => {
      const index = hosts.findIndex((saved) => saved.id === host.id)
      if (index !== -1) hosts.splice(index, 1)
      hosts.push(host)
      return { listError: options.listError ?? null }
    },
    forget: async (id) => {
      if (options.forgetFails) throw new Error('The account host list did not answer.')
      const index = hosts.findIndex((host) => host.id === id)
      if (index !== -1) hosts.splice(index, 1)
    },
    isRefused: () => refused,
    deviceLabel: () => 'My phone', onError: (message) => errors.push(message),
    fetchImpl: async (input, init) => {
      if (new URL(String(input)).pathname === '/health') return Response.json(signedHealth(input, options.impostor ? 'impostor' : 'windows'))
      sent.push(String(init?.body))
      started.resolve()
      await options.gate
      return Response.json({ sessionToken: `phone-token-${sent.length}`, installationId: 'windows', identityKey: KEY })
    },
  })
  return {
    follower, events, hosts, errors, sent, started: started.promise, claims: () => claims,
    change: (value: HostPairingsSnapshot) => { snapshot = value },
    refuse: (value: boolean) => { refused = value },
    pairSucceeds: () => { pairError = null },
  }
}

describe('client pairing after a chat or CLI add', () => {
  test('reports a failed snapshot read without removing saved hosts', async () => {
    const h = harness({ readError: new Error('disconnected') })
    h.hosts.push({ ...listing, sessionToken: 'saved-token' })
    try {
      await h.follower.refresh()
      expect(h.hosts[0]?.sessionToken).toBe('saved-token')
      expect(h.errors).toEqual(['Could not update paired hosts. Solus will try again when the connection changes.'])
    } finally { h.follower.dispose() }
  })

  // Each reconnect and host-list event refreshes the follower; a pairing the
  // remote host refuses must not be asked for again on every one of them.
  test('a failed pairing waits for a newer owner pairing or Pair again', async () => {
    const h = harness({ pairError: new Error('The remote host refused this connection. Pair it again.') })
    try {
      await h.follower.refresh()
      await h.follower.refresh()
      expect(h.claims()).toBe(1)
      expect(h.errors).toEqual(['Could not pair this device with Windows. Connect to its network and choose Pair again.'])
      h.change({ hosts: [{ listing, pairedAt: PAIRED_AT + 1 }], forgotten: [] })
      await h.follower.refresh()
      expect(h.claims()).toBe(2)
      h.pairSucceeds()
      expect(await h.follower.pairAgain('windows')).toBe(true)
      expect(h.hosts[0]?.sessionToken).toBe('phone-token-1')
    } finally { h.follower.dispose() }
  })

  test('a host-list event pairs the new host without a reload', async () => {
    const h = harness()
    try {
      h.events.receive({ type: 'host.listChanged', payload: {}, occurredAt: 1 })
      await h.follower.refresh()
      expect(h.hosts[0]?.sessionToken).toBe('phone-token-1')
      expect(h.hosts[0]?.ownerPairedAt).toBe(PAIRED_AT)
      expect(h.claims()).toBe(1)
    } finally { h.follower.dispose() }
  })

  test('a failed removal reports the failure and still pairs the replacement', async () => {
    const h = harness({ forgetFails: true })
    h.hosts.push({ id: 'old', installationId: 'old', label: 'Old Windows', routes: [], sessionToken: 'old-token', lastConnected: 0 })
    h.change({ hosts: [{ listing, pairedAt: PAIRED_AT }], forgotten: ['old'] })
    try {
      await h.follower.refresh()
      expect(h.hosts.find((host) => host.id === 'windows')?.sessionToken).toBe('phone-token-1')
      expect(h.errors).toEqual(['Could not remove Old Windows from your host list. Other hosts can still pair.'])
    } finally { h.follower.dispose() }
  })

  test('a refused token follows a newer owner pairing once, and a second refusal pairs nothing', async () => {
    // WHY: pairing on every refusal minted a token and a device row on each round,
    // with no end, when the host also refused the new token.
    const h = harness({ refused: true })
    h.hosts.push({ ...listing, sessionToken: 'revoked-token', ownerPairedAt: PAIRED_AT - 1 })
    try {
      await h.follower.refresh()
      expect(h.claims()).toBe(1)
      expect(h.hosts).toHaveLength(1)
      expect(h.hosts[0]).toMatchObject({ sessionToken: 'phone-token-1', ownerPairedAt: PAIRED_AT })
      expect(h.sent[0]).toContain('"replacesSessionToken":"revoked-token"')
      await h.follower.refresh()
      expect(h.claims()).toBe(1)
    } finally { h.follower.dispose() }
  })

  test('a refused token at the same owner pairing waits for Pair again', async () => {
    const h = harness({ refused: true })
    h.hosts.push({ ...listing, sessionToken: 'refused-token', ownerPairedAt: PAIRED_AT })
    try {
      await h.follower.refresh()
      expect(h.claims()).toBe(0)
      expect(await h.follower.pairAgain('windows')).toBe(true)
      expect(h.claims()).toBe(1)
      expect(h.hosts[0]?.sessionToken).toBe('phone-token-1')
    } finally { h.follower.dispose() }
  })

  test('a working token stays when the owner pairs the host again', async () => {
    // WHY: this device's token does not depend on the owner's; replacing it would only churn device rows.
    const h = harness()
    h.hosts.push({ ...listing, sessionToken: 'working-token', ownerPairedAt: PAIRED_AT - 1 })
    try {
      await h.follower.refresh()
      expect(h.claims()).toBe(0)
      expect(h.hosts[0]?.sessionToken).toBe('working-token')
    } finally { h.follower.dispose() }
  })

  test('Pair again answers false for a host this host did not pair, so the caller asks for a code', async () => {
    const h = harness()
    try {
      expect(await h.follower.pairAgain('studio')).toBe(false)
      expect(h.claims()).toBe(0)
    } finally { h.follower.dispose() }
  })

  test('reports a failed listing write while keeping the successful client pairing', async () => {
    const h = harness({ listError: new Error('The account did not answer.') })
    try {
      await h.follower.refresh()
      expect(h.hosts[0]?.sessionToken).toBe('phone-token-1')
      expect(h.errors).toEqual(['Windows is paired on this device, but its host list could not be saved. Solus will try again.'])
    } finally { h.follower.dispose() }
  })
  test('gets a separate client credential once, then forgets when the host is removed', async () => {
    const h = harness()
    try {
      await h.follower.refresh()
      expect(h.hosts[0]?.sessionToken).toBe('phone-token-1')
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

test('a Settings link is visible without connecting until the user requests it', async () => {
  const h = harness()
  h.change({ hosts: [{ listing, pairedAt: PAIRED_AT, clientConnect: 'on-request' }], forgotten: [] })
  try {
    await h.follower.refresh()
    expect(h.follower.snapshot()?.hosts[0]?.listing).toEqual(listing)
    expect(h.claims()).toBe(0)
    expect(h.hosts).toHaveLength(0)
    expect(await h.follower.pairAgain('windows')).toBe(true)
    expect(h.claims()).toBe(1)
    expect(h.hosts[0]?.sessionToken).toBe('phone-token-1')
  } finally { h.follower.dispose() }
})
