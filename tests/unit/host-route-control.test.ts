import { describe, expect, test } from 'bun:test'
import { checkRouteToAdd, newRouteRefusalText, routeInUse, routeRows, routeUrlFromInput, withoutRoute, withRouteMoved, withUserRoute, type NewRouteInput, type RouteHolder } from '@solus/client-core/host-route-control'
import { listingOf } from '@solus/client-core/host-list-source'
import type { SavedServer } from '@solus/client-core/server-registry'
import { mergeDirectoryIntoSaved, withDiscoveredRoutes } from '@solus/client-core/uplink-session'
import { dialableRoutes, dialChoicesOf, type HostRoute } from '@solus/contracts/host-routes'
import { hostIdentityFor, identityKeyFor, signedHealth } from './helpers/signing-host'

// WHY: docs/plans/host-routes.md §12. A person controls the routes to a host, but a
// typed address gets no trust of its own: it must prove it is this host before it is
// saved, it sends no credential to do that, and a route a read gives back cannot
// be removed because the removal would not last.

const INSTALLATION = 'inst-studio'
const pairing: HostRoute = { kind: 'lan', url: 'http://10.0.0.8:3000', source: 'pairing' }
const learned: HostRoute = { kind: 'lan', url: 'http://192.168.1.20:3000', source: 'host' }
const tunnel: HostRoute = { kind: 'tunnel', url: 'https://studio.tunnel.solus.sh', source: 'directory' }
const viewer = { clientOrigin: '' }
const identity = { installationId: INSTALLATION, identityKey: identityKeyFor(INSTALLATION) }

describe('the route list', () => {
  test('a learned route can move but not be removed; a paired or added route can be removed', () => {
    const rows = routeRows({ routes: [pairing, learned, tunnel] }, viewer)
    expect(rows.find((row) => row.url === learned.url)).toMatchObject({ isLearned: true, canRemove: false })
    expect(rows.find((row) => row.url === tunnel.url)).toMatchObject({ isLearned: true, canRemove: false })
    expect(rows.find((row) => row.url === pairing.url)).toMatchObject({ isLearned: false, canRemove: true })
    const moved = withRouteMoved({ routes: [pairing, learned, tunnel] }, learned.url, 1)
    expect(routeRows(moved, viewer).map((row) => row.url)).toEqual([pairing.url, tunnel.url, learned.url])
  })

  test('a paired address the host also advertises is learned: removing it would not last', () => {
    const rows = routeRows({ routes: [pairing, { ...learned, url: pairing.url }, tunnel] }, viewer)
    expect(rows.find((row) => row.url === pairing.url)).toMatchObject({ isLearned: true, canRemove: false })
  })

  test('the last route this client can dial stays', () => {
    expect(routeRows({ routes: [pairing] }, viewer)[0]?.canRemove).toBe(false)
    const onHttpsPage = routeRows({ routes: [{ kind: 'public', url: 'https://solus.example.com', source: 'user' }, pairing] }, { clientOrigin: 'https://app.solus.sh' })
    expect(onHttpsPage.find((row) => row.url === pairing.url)).toMatchObject({ block: 'mixed-content', canRemove: true })
    expect(onHttpsPage.find((row) => row.kind === 'public')?.canRemove).toBe(false)
  })

  test('a route the token must stay off is listed with the reason, not hidden', () => {
    const rows = routeRows({ routes: [learned, tunnel], tokenPairedOverHttps: true }, viewer)
    expect(rows.find((row) => row.url === learned.url)?.block).toBe('token-in-clear')
    expect(rows.find((row) => row.url === tunnel.url)?.block).toBeNull()
  })

  test('a managed host lists only its tunnel, and nothing there can be removed', () => {
    const holder: RouteHolder = { routes: [pairing, tunnel, { ...tunnel, url: 'https://b.tunnel.solus.sh' }], uplink: { kind: 'managed' } }
    const rows = routeRows(holder, viewer)
    expect(rows.map((row) => row.kind)).toEqual(['tunnel', 'tunnel'])
    expect(rows.some((row) => row.canRemove)).toBe(false)
  })

  test('the route in use is named only while the host is connected', () => {
    const rows = routeRows({ routes: [pairing, tunnel] }, viewer)
    expect(routeInUse(rows, tunnel.url, true)).toBe(tunnel.url)
    expect(routeInUse(rows, tunnel.url, false)).toBeNull()
    expect(routeInUse(rows, 'http://gone:1', true)).toBeNull()
  })

  test('removing a route takes it out of the order too', () => {
    const moved = withRouteMoved({ routes: [pairing, learned, tunnel] }, tunnel.url, -1)
    const removed = withoutRoute(moved, pairing.url)
    expect(removed.routeOrder).not.toContain(pairing.url)
    expect(routeRows(removed, viewer).map((row) => row.url)).toEqual([tunnel.url, learned.url])
  })

  test('a move past either end changes nothing', () => {
    const holder = { routes: [pairing, tunnel] }
    expect(withRouteMoved(holder, pairing.url, -1)).toBe(holder)
    expect(withRouteMoved(holder, tunnel.url, 1)).toBe(holder)
  })
})

describe('a typed address', () => {
  test('becomes a route url, or is refused', () => {
    expect(routeUrlFromInput(' https://solus.example.com/ ')).toBe('https://solus.example.com')
    expect(routeUrlFromInput('10.0.0.8')).toBe('http://10.0.0.8:3000')
    expect(routeUrlFromInput('ftp://box')).toBeNull()
    expect(routeUrlFromInput('ssh://box')).toBeNull()
    expect(routeUrlFromInput('https://user:secret@box')).toBeNull()
    expect(routeUrlFromInput('')).toBeNull()
  })
})

describe('adding a route', () => {
  const NEW_URL = 'https://solus.example.com'

  /** A fake network: each url answers as an installation, signed by its own key, and every request is kept. */
  function network(answers: Record<string, string>, signer?: string) {
    const requests: Request[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(String(input), init)
      requests.push(request)
      const installationId = answers[new URL(request.url).origin]
      if (!installationId) throw new Error('unreachable')
      if (!signer) return Response.json(signedHealth(input, installationId))
      const nonce = new URL(request.url).searchParams.get('nonce')
      return Response.json({ ok: true, installationId, ...(nonce ? { proof: hostIdentityFor(signer).proveTo(nonce, installationId) } : {}) })
    }) as typeof fetch
    return { fetchImpl, requests }
  }

  const input = (overrides: Partial<NewRouteInput> = {}): NewRouteInput => ({
    address: NEW_URL,
    holder: { routes: [pairing] },
    identity,
    viewer,
    signal: AbortSignal.timeout(1_000),
    ...overrides,
  })

  test('an address that proves it is this host is accepted, and it receives no credential', async () => {
    const { fetchImpl, requests } = network({ [NEW_URL]: INSTALLATION })
    expect(await checkRouteToAdd(fetchImpl, input())).toEqual({ ok: true, url: NEW_URL })
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) {
      expect(new URL(request.url).pathname).toBe('/health')
      expect(request.headers.get('authorization')).toBeNull()
    }
  })

  test('an https address that names the right installation but cannot sign is refused: the id is public', async () => {
    const { fetchImpl } = network({ [NEW_URL]: INSTALLATION }, 'inst-impostor')
    expect(await checkRouteToAdd(fetchImpl, input())).toEqual({ ok: false, refusal: 'another-host' })
  })

  test('an address that answers as another host is refused, and one that does not answer says so', async () => {
    expect(await checkRouteToAdd(network({ [NEW_URL]: 'inst-other' }).fetchImpl, input())).toEqual({ ok: false, refusal: 'another-host' })
    expect(await checkRouteToAdd(network({}).fetchImpl, input())).toEqual({ ok: false, refusal: 'no-answer' })
  })

  test('nothing is asked before the rules that need no network', async () => {
    const { fetchImpl, requests } = network({})
    expect(await checkRouteToAdd(fetchImpl, input({ address: 'ftp://box' }))).toEqual({ ok: false, refusal: 'invalid-address' })
    expect(await checkRouteToAdd(fetchImpl, input({ address: pairing.url }))).toEqual({ ok: false, refusal: 'already-saved' })
    expect(await checkRouteToAdd(fetchImpl, input({ holder: { routes: [tunnel], uplink: { kind: 'managed' } } }))).toEqual({ ok: false, refusal: 'managed-host' })
    expect(await checkRouteToAdd(fetchImpl, input({ address: 'http://192.168.1.9:3000', viewer: { clientOrigin: 'https://app.solus.sh' } }))).toEqual({ ok: false, refusal: 'mixed-content' })
    expect(await checkRouteToAdd(fetchImpl, input({ identity: { installationId: INSTALLATION } }))).toEqual({ ok: false, refusal: 'no-identity-key' })
    expect(requests).toEqual([])
  })

  test('a token paired over HTTPS cannot gain a plain http address, except inside the tailnet name or over https', async () => {
    const holder: RouteHolder = { routes: [tunnel], tokenPairedOverHttps: true }
    const { fetchImpl } = network({ 'http://192.168.1.9:3000': INSTALLATION, [NEW_URL]: INSTALLATION })
    expect(await checkRouteToAdd(fetchImpl, input({ holder, address: 'http://192.168.1.9:3000' }))).toEqual({ ok: false, refusal: 'token-in-clear' })
    expect(await checkRouteToAdd(fetchImpl, input({ holder }))).toEqual({ ok: true, url: NEW_URL })
  })

  test('every refusal has words', () => {
    for (const refusal of ['invalid-address', 'managed-host', 'already-saved', 'mixed-content', 'token-in-clear', 'no-identity-key', 'no-answer', 'another-host'] as const) {
      expect(newRouteRefusalText(refusal).length).toBeGreaterThan(0)
    }
  })

  test('an added route has an honest kind, and a dial needs a proof at each use', () => {
    const added = withUserRoute({ routes: [pairing] }, NEW_URL, 5)
    expect(added.routes.at(-1)).toEqual({ kind: 'public', url: NEW_URL, source: 'user', seenAt: 5 })
    expect(dialableRoutes(added.routes, '').map((route) => route.kind)).toEqual(['lan', 'public'])
  })
})

describe('routes on web and desktop', () => {
  const NOW = 100
  const listed = { hostId: 'cloud-1', installationId: INSTALLATION, label: 'Studio', routes: [{ kind: 'tunnel' as const, url: tunnel.url }], kind: 'personal' as const, category: 'personal' as const, organizationIds: [] }

  test('a directory read keeps what the person chose', () => {
    const saved: SavedServer = { id: INSTALLATION, label: 'Studio', sessionToken: 'token', installationId: INSTALLATION, lastConnected: 1, routes: [pairing], routeOrder: [pairing.url], tokenPairedOverHttps: true }
    const [merged] = mergeDirectoryIntoSaved([saved], [listed], 'https://app.solus.sh', NOW, '')
    expect(merged).toMatchObject({ routeOrder: [pairing.url], tokenPairedOverHttps: true })
  })

  test('the first dial obeys the order and the token rule', () => {
    const first = (holder: RouteHolder) => dialableRoutes(holder.routes, '', null, dialChoicesOf(holder))[0]?.url
    const holder = { routes: [pairing, tunnel] }
    expect(first(holder)).toBe(pairing.url)
    expect(first({ ...holder, routeOrder: [tunnel.url, pairing.url] })).toBe(tunnel.url)
    expect(first({ ...holder, tokenPairedOverHttps: true })).toBe(tunnel.url)
  })

  test('a scan through Tailscale says tailnet, not a guess from the range', () => {
    const saved: SavedServer = { id: INSTALLATION, label: 'Studio', sessionToken: 'token', installationId: INSTALLATION, lastConnected: 1, routes: [pairing] }
    const next = withDiscoveredRoutes([saved], [{ host: '100.64.0.2', port: 3000, name: 'Studio', installationId: INSTALLATION, source: 'tailnet' }], NOW)
    expect(next?.[0]?.routes.find((route) => route.source === 'discovery')?.kind).toBe('tailnet')
  })
})

describe('routes and the host list', () => {
  const server = (overrides: Partial<SavedServer> = {}): SavedServer => ({
    id: INSTALLATION, label: 'Studio', sessionToken: 'token', installationId: INSTALLATION, lastConnected: 1, routes: [pairing], ...overrides,
  })

  test('an added route and the order stay on this client', () => {
    const listing = listingOf(withRouteMoved(withUserRoute(server(), 'https://solus.example.com', 2), pairing.url, 1))
    expect(listing?.routes.map((route) => route.url)).toEqual([pairing.url])
    expect(Object.keys(listing ?? {})).not.toContain('routeOrder')
  })

  test('a removed route leaves the listing, and the order and the token flag stay', () => {
    const local = withoutRoute(server({ routes: [pairing, learned, tunnel], tokenPairedOverHttps: true, routeOrder: [tunnel.url, pairing.url, learned.url] }), pairing.url)
    expect(local.routes.map((route) => route.url)).toEqual([learned.url, tunnel.url])
    expect(local).toMatchObject({ tokenPairedOverHttps: true, routeOrder: [tunnel.url, learned.url] })
    expect(listingOf(local)?.routes.map((route) => route.url)).not.toContain(pairing.url)
  })
})
