import { beforeEach, describe, expect, test } from 'bun:test'
import { PairedHosts } from '@solus/server/execution/orchestration/paired-hosts'

// WHY: a paired host's token acts as the owner on that host for 30 days
// (docs/plans/cross-host-sessions.md §10). It must never reach a machine that
// is not the paired host (a LAN address can be reused), must stay alive while
// the pairing is used, must never be paired with this host itself, and must
// never be shown to a client.

const SELF = 'install-self'
const DAY = 24 * 60 * 60 * 1000

interface Sent { url: string; authorization: string | null }

/** A fake network: each URL origin answers as one host, or not at all. */
function network(hostAt: Map<string, string>) {
  const sent: Sent[] = []
  let issued = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const authorization = new Headers(init?.headers).get('authorization')
    sent.push({ url: url.href, authorization })
    const installationId = hostAt.get(url.origin)
    if (!installationId) throw new TypeError('fetch failed')
    if (url.pathname === '/health') return Response.json({ ok: true, installationId, name: `Name of ${installationId}` })
    if (url.pathname === '/pair') {
      const body = JSON.parse(String(init?.body)) as { pairToken: string }
      if (body.pairToken !== '123456') return Response.json({ error: 'Invalid or expired pair token' }, { status: 401 })
      return Response.json({ sessionToken: `token-${installationId}-${issued++}`, installationId })
    }
    if (url.pathname === '/auth/refresh') return Response.json({ sessionToken: `token-${installationId}-${issued++}`, installationId })
    return new Response(null, { status: 404 })
  }) as typeof fetch
  return { fetchImpl, sent }
}

let now = 1_000_000

beforeEach(() => {
  now = 1_000_000
  // The store is one list in the test's data directory: start each test empty.
  const store = new PairedHosts(network(new Map()).fetchImpl, () => now, () => SELF)
  for (const host of store.list()) store.forget(host.installationId)
})

describe('pairing with another host', () => {
  test('stores the host under the name it reports, and never lists the token', async () => {
    const { fetchImpl } = network(new Map([['http://10.0.0.5:7777', 'install-b']]))
    const hosts = new PairedHosts(fetchImpl, () => now, () => SELF)
    const paired = await hosts.pair({ url: '10.0.0.5:7777', code: ' 123456 ' }, 'Laptop (Solus host)')
    expect(paired).toEqual({ installationId: 'install-b', label: 'Name of install-b', url: 'http://10.0.0.5:7777', pairedAt: now })
    expect(JSON.stringify(hosts.list())).not.toContain('token-')
  })

  test('refuses this host itself before it spends the code', async () => {
    const { fetchImpl, sent } = network(new Map([['http://127.0.0.1:7777', SELF]]))
    const hosts = new PairedHosts(fetchImpl, () => now, () => SELF)
    await expect(hosts.pair({ url: 'http://127.0.0.1:7777', code: '123456' }, 'Laptop')).rejects.toThrow('this host')
    expect(sent.some((request) => request.url.endsWith('/pair'))).toBe(false)
  })

  test('a wrong code is refused with the host\'s reason, and nothing is stored', async () => {
    const { fetchImpl } = network(new Map([['http://10.0.0.5:7777', 'install-b']]))
    const hosts = new PairedHosts(fetchImpl, () => now, () => SELF)
    await expect(hosts.pair({ url: 'http://10.0.0.5:7777', code: '000000' }, 'Laptop')).rejects.toThrow('Invalid or expired pair token')
    expect(hosts.list()).toEqual([])
  })

  test('forget removes the host', async () => {
    const { fetchImpl } = network(new Map([['http://10.0.0.5:7777', 'install-b']]))
    const hosts = new PairedHosts(fetchImpl, () => now, () => SELF)
    await hosts.pair({ url: 'http://10.0.0.5:7777', code: '123456' }, 'Laptop')
    expect(hosts.forget('install-b')).toBe(true)
    expect(hosts.list()).toEqual([])
    expect(await hosts.credential('install-b')).toBeNull()
  })
})

describe('the credential for a dial', () => {
  test('is not sent to an address that now answers as another host', async () => {
    const hostAt = new Map([['http://10.0.0.5:7777', 'install-b']])
    const { fetchImpl, sent } = network(hostAt)
    const hosts = new PairedHosts(fetchImpl, () => now, () => SELF)
    await hosts.pair({ url: 'http://10.0.0.5:7777', code: '123456' }, 'Laptop')
    hostAt.set('http://10.0.0.5:7777', 'install-stranger')
    sent.length = 0
    expect(await hosts.credential('install-b')).toBeNull()
    expect(sent.every((request) => request.authorization === null)).toBe(true)
  })

  test('is refreshed once it is a day old, and the new token is kept', async () => {
    const { fetchImpl, sent } = network(new Map([['http://10.0.0.5:7777', 'install-b']]))
    const hosts = new PairedHosts(fetchImpl, () => now, () => SELF)
    await hosts.pair({ url: 'http://10.0.0.5:7777', code: '123456' }, 'Laptop')
    now += DAY - 1
    expect(await hosts.credential('install-b')).toBe('token-install-b-0')
    expect(sent.some((request) => request.url.endsWith('/auth/refresh'))).toBe(false)
    now += 2
    expect(await hosts.credential('install-b')).toBe('token-install-b-1')
    // A new store reads what was saved, as after a restart.
    expect(await new PairedHosts(fetchImpl, () => now, () => SELF).credential('install-b')).toBe('token-install-b-1')
  })
})
