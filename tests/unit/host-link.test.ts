import { describe, expect, test } from 'bun:test'
import { HostLink, type LinkTransport } from '@solus/client-core/host-link'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { asHostApi } from '@solus/client-core/host-api'
import type { DialOutcome } from '@solus/client-core/host-supervisor'
import type { HostRoute } from '@solus/contracts/host-routes'

// docs/plans/simplify-auth-and-sync.md §3 rule 7 and §4.4: one host link on every
// client. Web and desktop (`ServerConnections`) and mobile (`HostConnections`) hold
// this one class, so these tests pin the route policy for all three.

const DIRECT: HostRoute = { kind: 'lan', url: 'http://10.0.0.20:51234' }
const TUNNEL: HostRoute = { kind: 'tunnel', url: 'https://build.tunnel.solus.test' }
const MIRROR: HostRoute = { kind: 'tunnel', url: 'https://app.solus.test/api/mirror' }

class FakeTransport implements LinkTransport {
  readonly events = new HostEventSubscriber()
  readonly dials: Array<{ url: string; hostConfirmed: boolean }> = []
  report: (outcome: DialOutcome) => void = () => {}
  isDestroyed = false
  constructor(public serverUrl: string) {}
  start(options: { hostConfirmed?: boolean } = {}): void { this.dials.push({ url: this.serverUrl, hostConfirmed: options.hostConfirmed ?? false }) }
  async probe(): Promise<void> {}
  switchServerUrl(serverUrl: string): void { this.serverUrl = serverUrl }
  attachDialOutcomeReporter(report: (outcome: DialOutcome) => void): void { this.report = report }
  setUnreachable(): void {}
  destroy(): void { this.isDestroyed = true }
}

/** Timers a test runs by hand, so the retry ladder never waits on the clock. */
function manualTimers() {
  const pending = new Map<number, () => void>()
  let next = 0
  return {
    setTimeoutFn: ((callback: () => void) => { pending.set(++next, callback); return next }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: number) => { pending.delete(id) }) as unknown as typeof clearTimeout,
    runAll() {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback()
    },
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

function link(options: { routes: HostRoute[]; answering: string[]; fallback?: HostRoute[] }) {
  const transport = new FakeTransport(options.routes[0]?.url ?? options.fallback?.[0]?.url ?? '')
  const timers = manualTimers()
  const checked: string[] = []
  const hostLink = new HostLink({
    hostId: 'host-1',
    transport,
    api: asHostApi({}),
    routes: () => options.routes,
    fallbackRoutes: () => options.fallback ?? [],
    answersAsHost: async (url) => {
      checked.push(url)
      return options.answering.includes(url)
    },
    ...timers,
  })
  return { hostLink, transport, timers, checked }
}

describe('one route policy', () => {
  test('a host with one route is dialed at once, and the dial checks its identity itself', async () => {
    // WHY: a route check before the only route costs a round trip and decides nothing.
    const { hostLink, transport, checked } = link({ routes: [TUNNEL], answering: [TUNNEL.url] })
    hostLink.start()
    expect(transport.dials).toEqual([{ url: TUNNEL.url, hostConfirmed: false }])
    expect(checked).toEqual([])
  })

  test('a host whose only route is http is proved before the dial, even with one route', async () => {
    // WHY: docs/plans/host-routes.md D3. The dial carries a credential, so an http route
    // is dialed only after the host there proves its identity key.
    const { hostLink, transport, checked } = link({ routes: [DIRECT], answering: [DIRECT.url] })
    hostLink.start()
    await settle()
    expect(checked).toEqual([DIRECT.url])
    expect(transport.dials).toEqual([{ url: DIRECT.url, hostConfirmed: true }])
  })

  test('when no http route proves the host, nothing is dialed and the dial counts as failed', async () => {
    // WHY: a device that took the host's old address must not get the credential.
    const outcomes: DialOutcome[] = []
    const transport = new FakeTransport(DIRECT.url)
    const hostLink = new HostLink({
      hostId: 'host-1',
      transport,
      api: asHostApi({}),
      routes: () => [DIRECT],
      answersAsHost: async () => false,
      onOutcome: (outcome) => outcomes.push(outcome),
      ...manualTimers(),
    })
    hostLink.start()
    await settle()
    expect(transport.dials).toEqual([])
    expect(outcomes).toEqual([{ kind: 'dial-failed' }])
  })

  test('every route is checked at once, the one that answers is dialed, and its identity is not asked again', async () => {
    const { hostLink, transport, checked } = link({ routes: [DIRECT, TUNNEL], answering: [TUNNEL.url] })
    hostLink.start()
    await settle()
    expect(checked.sort()).toEqual([DIRECT.url, TUNNEL.url].sort())
    expect(transport.dials).toEqual([{ url: TUNNEL.url, hostConfirmed: true }])
  })

  test('a failed dial is followed by route choice again, never a round-robin switch', async () => {
    // WHY: the direct route may answer again (the laptop came home); the next dial asks every route.
    const answering = [TUNNEL.url]
    const { hostLink, transport, timers } = link({ routes: [DIRECT, TUNNEL], answering })
    hostLink.start()
    await settle()
    answering.push(DIRECT.url)
    transport.report({ kind: 'dial-failed' })
    expect(transport.serverUrl).toBe(TUNNEL.url)
    timers.runAll()
    await settle()
    expect(transport.dials.at(-1)).toEqual({ url: DIRECT.url, hostConfirmed: true })
  })

  test('a fallback route is dialed only when no route of the host answers', async () => {
    // WHY: a guest's mirror is read only; the live host is always asked first.
    const answering = [MIRROR.url]
    const { hostLink, transport, timers } = link({ routes: [TUNNEL], fallback: [MIRROR], answering })
    hostLink.start()
    await settle()
    expect(transport.dials).toEqual([{ url: MIRROR.url, hostConfirmed: true }])
    answering.push(TUNNEL.url)
    transport.report({ kind: 'dropped' })
    timers.runAll()
    await settle()
    expect(transport.dials.at(-1)).toEqual({ url: TUNNEL.url, hostConfirmed: true })
  })

  test('a host reached through its tunnel moves to a direct route that answers at a wake', async () => {
    const answering = [TUNNEL.url]
    const { hostLink, transport } = link({ routes: [DIRECT, TUNNEL], answering })
    hostLink.start()
    await settle()
    transport.report({ kind: 'accepted', recovered: false })
    answering.push(DIRECT.url)
    hostLink.wake('activation')
    await settle()
    expect(transport.serverUrl).toBe(DIRECT.url)
    expect(transport.dials.at(-1)?.url).toBe(DIRECT.url)
  })

  test('a link aimed at a route the directory no longer lists moves to the first one it does', () => {
    const routes = [TUNNEL]
    const { hostLink, transport } = link({ routes, answering: [] })
    routes.splice(0, 1, { kind: 'tunnel', url: 'https://moved.tunnel.solus.test' })
    hostLink.followRoutes()
    expect(transport.serverUrl).toBe('https://moved.tunnel.solus.test')
  })

  test('destroying the link destroys its transport, and a late route answer dials nothing', async () => {
    const { hostLink, transport } = link({ routes: [DIRECT, TUNNEL], answering: [TUNNEL.url] })
    hostLink.start()
    hostLink.destroy()
    await settle()
    expect(transport.isDestroyed).toBe(true)
    expect(transport.dials).toEqual([])
  })
})
