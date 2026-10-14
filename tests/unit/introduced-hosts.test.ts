import { beforeEach, describe, expect, test } from 'bun:test'
import { IntroducedHosts, type IntroductionSelf } from '@solus/server/execution/orchestration/introduced-hosts'

// WHY: local reach (docs/plans/host-reach.md §4). A client that holds owner pairings
// for two hosts introduces them, so a person's hosts reach each other with no
// account and no pairing step. An introduced token acts as the owner on the other
// host for 30 days: it must be kept only at an address that answers as that host,
// must never be shown to a client after the hand-over, must die on both sides when
// the person forgets it, and a forgotten host must not come back on the next
// client connection.

const SELF = 'install-self'
const DAY = 24 * 60 * 60 * 1000

interface Sent { url: string; authorization: string | null }

/** A fake network: each URL origin answers as one host, or not at all. */
function network(hostAt: Map<string, string>, revoked: Set<string> = new Set()) {
  const sent: Sent[] = []
  let issued = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const authorization = new Headers(init?.headers).get('authorization')
    sent.push({ url: url.href, authorization })
    const installationId = hostAt.get(url.origin)
    if (!installationId) throw new TypeError('fetch failed')
    if (url.pathname === '/health') return Response.json({ ok: true, installationId, name: `Name of ${installationId}` })
    if (url.pathname === '/auth/refresh') {
      if (revoked.has(authorization ?? '')) return Response.json({ error: 'Unauthorized' }, { status: 401 })
      return Response.json({ sessionToken: `token-${installationId}-${issued++}` })
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
  return { fetchImpl, sent }
}

function selfHost(urls: string[] = ['http://10.0.0.1:7777']) {
  const issued: string[] = []
  const revoked: string[] = []
  const self: IntroductionSelf = {
    installationId: () => SELF,
    name: () => 'Mac mini',
    urls: async () => urls,
    issueToken: (deviceLabel) => {
      const deviceId = `device-${issued.length}`
      issued.push(deviceLabel)
      return { token: `own-token-${deviceId}`, deviceId }
    },
    revokeDevice: (deviceId) => { revoked.push(deviceId) },
  }
  return { self, issued, revoked }
}

const B = { installationId: 'install-b', label: 'Omarchy', urls: ['http://10.0.0.9:7777', 'http://10.0.0.5:7777'], sessionToken: 'given-by-b', deviceId: 'device-of-a-on-b' }

let now = 1_000_000

beforeEach(() => {
  now = 1_000_000
  // The store is one record in the test's data directory: start each test empty.
  const store = new IntroducedHosts(network(new Map()).fetchImpl, () => now, selfHost().self)
  const { hosts, refused } = store.list()
  for (const host of hosts) store.forget(host.installationId)
  for (const entry of [...refused, ...hosts]) store.allow(entry.installationId)
})

describe('an introduction', () => {
  test('a host issues a token for the other host, with the addresses it is reached at', async () => {
    const { self, issued } = selfHost(['http://100.64.0.1:7777', 'http://10.0.0.1:7777'])
    const hosts = new IntroducedHosts(network(new Map()).fetchImpl, () => now, self)
    expect(await hosts.issue({ installationId: 'install-b', label: 'Omarchy' })).toEqual({
      installationId: SELF, label: 'Mac mini', urls: ['http://100.64.0.1:7777', 'http://10.0.0.1:7777'], sessionToken: 'own-token-device-0', deviceId: 'device-0',
    })
    expect(issued).toEqual(['Omarchy (Solus host)'])
  })

  test('the token is kept only at an address that answers as the sender, exchanged for this host\'s own copy, and never listed', async () => {
    const { fetchImpl } = network(new Map([['http://10.0.0.9:7777', 'install-stranger'], ['http://10.0.0.5:7777', 'install-b']]))
    const hosts = new IntroducedHosts(fetchImpl, () => now, selfHost().self)
    await hosts.accept(B, 'device-of-b-here')
    expect(hosts.list()).toEqual({ hosts: [{ installationId: 'install-b', label: 'Name of install-b', url: 'http://10.0.0.5:7777', introducedAt: now }], refused: [] })
    expect(JSON.stringify(hosts.list())).not.toContain('token')
    expect(await hosts.credential('install-b')).toBe('token-install-b-0')
  })

  test('a host that answers at no address is not kept, and the device issued for it is revoked', async () => {
    const { self, revoked } = selfHost()
    const hosts = new IntroducedHosts(network(new Map()).fetchImpl, () => now, self)
    await expect(hosts.accept(B, 'device-of-b-here')).rejects.toThrow('cannot reach Omarchy')
    expect(hosts.list().hosts).toEqual([])
    expect(revoked).toEqual(['device-of-b-here'])
  })

  test('a host is never introduced to itself', async () => {
    const hosts = new IntroducedHosts(network(new Map()).fetchImpl, () => now, selfHost().self)
    await expect(hosts.issue({ installationId: SELF, label: 'Me' })).rejects.toThrow('itself')
    await expect(hosts.accept({ ...B, installationId: SELF }, 'x')).rejects.toThrow('itself')
  })
})

describe('forgetting an introduced host', () => {
  test('revokes its device here and refuses it until it is allowed again', async () => {
    const { fetchImpl } = network(new Map([['http://10.0.0.5:7777', 'install-b']]))
    const { self, revoked } = selfHost()
    const hosts = new IntroducedHosts(fetchImpl, () => now, self)
    await hosts.accept(B, 'device-of-b-here')
    expect(hosts.forget('install-b')).toBe(true)
    expect(revoked).toEqual(['device-of-b-here'])
    expect(hosts.list()).toEqual({ hosts: [], refused: [{ installationId: 'install-b', label: 'Name of install-b' }] })
    // The next client connection does not bring it back.
    await expect(hosts.issue({ installationId: 'install-b', label: 'Omarchy' })).rejects.toThrow('forgotten')
    await expect(hosts.accept(B, 'device-of-b-here')).rejects.toThrow('forgotten')
    expect(hosts.allow('install-b')).toBe(true)
    await hosts.accept(B, 'device-of-b-here-2')
    expect(hosts.list().hosts).toHaveLength(1)
  })

  test('the other side removes this host at its next refresh, when the token is refused there', async () => {
    const refusedTokens = new Set<string>()
    const { fetchImpl } = network(new Map([['http://10.0.0.5:7777', 'install-b']]), refusedTokens)
    const { self, revoked } = selfHost()
    const hosts = new IntroducedHosts(fetchImpl, () => now, self)
    await hosts.accept(B, 'device-of-b-here')
    refusedTokens.add('Bearer token-install-b-0')
    now += DAY
    expect(await hosts.credential('install-b')).toBeNull()
    expect(hosts.list().hosts).toEqual([])
    expect(revoked).toEqual(['device-of-b-here'])
  })
})

describe('the credential for a dial', () => {
  test('is not sent to an address that now answers as another host', async () => {
    const hostAt = new Map([['http://10.0.0.5:7777', 'install-b']])
    const { fetchImpl, sent } = network(hostAt)
    const hosts = new IntroducedHosts(fetchImpl, () => now, selfHost().self)
    await hosts.accept(B, 'device-of-b-here')
    hostAt.set('http://10.0.0.5:7777', 'install-stranger')
    sent.length = 0
    expect(await hosts.credential('install-b')).toBeNull()
    expect(sent.every((request) => request.authorization === null)).toBe(true)
  })

  test('is refreshed once it is a day old, and the new token is kept', async () => {
    const { fetchImpl } = network(new Map([['http://10.0.0.5:7777', 'install-b']]))
    const hosts = new IntroducedHosts(fetchImpl, () => now, selfHost().self)
    await hosts.accept(B, 'device-of-b-here')
    now += DAY - 1
    expect(await hosts.credential('install-b')).toBe('token-install-b-0')
    now += 2
    expect(await hosts.credential('install-b')).toBe('token-install-b-1')
    expect(await new IntroducedHosts(fetchImpl, () => now, selfHost().self).credential('install-b')).toBe('token-install-b-1')
  })
})
