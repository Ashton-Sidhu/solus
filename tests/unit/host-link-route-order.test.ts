import { describe, expect, test } from 'bun:test'
import { HostLink, type LinkTransport } from '@solus/client-core/host-link'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { asHostApi } from '@solus/client-core/host-api'
import type { DialOutcome } from '@solus/client-core/host-supervisor'
import { EARLIER_ROUTE_RECHECK_MS, type HostRoute } from '@solus/contracts/host-routes'

// WHY: docs/plans/tailscale-support.md D12. A client that cannot connect on its route
// follows its route order: the next route that answers carries the host, the first
// route takes it back once it answers again, and with no route answering the retries
// start again from the first route. There is no network-change listener (§10, answer 5),
// so this order is the only way back. Desktop, web, and mobile share `HostLink`.

const LAN: HostRoute = { kind: 'lan', url: 'http://10.0.0.20:3000' }
const TAILNET: HostRoute = { kind: 'tailnet', url: 'http://100.64.0.2:3000' }
const TUNNEL: HostRoute = { kind: 'tunnel', url: 'https://build.tunnel.solus.test' }
const RELAY: HostRoute = { kind: 'tunnel', url: 'https://relay.solus.test' }

class FakeTransport implements LinkTransport {
  readonly events = new HostEventSubscriber()
  readonly dials: string[] = []
  report: (outcome: DialOutcome) => void = () => {}
  constructor(public serverUrl: string) {}
  start(): void { this.dials.push(this.serverUrl) }
  async probe(): Promise<void> {}
  switchServerUrl(serverUrl: string): void { this.serverUrl = serverUrl }
  attachDialOutcomeReporter(report: (outcome: DialOutcome) => void): void { this.report = report }
  setUnreachable(): void {}
  destroy(): void {}
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/** Timers on a clock the test moves, so a delay is measured, never waited for. */
function virtualClock() {
  let now = 0
  let next = 0
  const pending = new Map<number, { at: number; callback: () => void }>()
  return {
    get now() { return now },
    setTimeoutFn: ((callback: () => void, ms = 0) => { pending.set(++next, { at: now + ms, callback }); return next }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: number) => { pending.delete(id) }) as unknown as typeof clearTimeout,
    /** Runs every timer due by `now + ms`, in time order. */
    async advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        now = due[1].at
        due[1].callback()
        await settle()
      }
      now = until
    },
  }
}

function link(routes: HostRoute[], answering: Set<string>) {
  const transport = new FakeTransport(routes[0]!.url)
  const clock = virtualClock()
  const hostLink = new HostLink({
    hostId: 'host-1',
    transport,
    api: asHostApi({}),
    routes: () => routes,
    answersAsHost: async (url) => answering.has(url),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  })
  return { hostLink, transport, clock }
}

describe('a failed connection follows the route order', () => {
  test('route 1 fails, route 2 connects, and the link returns to route 1 within the recheck time', async () => {
    const answering = new Set([TAILNET.url])
    const { hostLink, transport, clock } = link([LAN, TAILNET], answering)
    hostLink.start()
    await settle()
    expect(transport.dials).toEqual([TAILNET.url])
    transport.report({ kind: 'accepted', recovered: false })
    expect(hostLink.readiness).toBe('ready')

    answering.add(LAN.url)
    await clock.advance(EARLIER_ROUTE_RECHECK_MS)
    expect(transport.serverUrl).toBe(LAN.url)
    expect(transport.dials.at(-1)).toBe(LAN.url)
  })

  test('route 2 drops while route 1 answers again: the next dial goes to route 1, not back to route 2', async () => {
    const answering = new Set([TAILNET.url])
    const { hostLink, transport, clock } = link([LAN, TAILNET], answering)
    hostLink.start()
    await settle()
    transport.report({ kind: 'accepted', recovered: false })

    answering.add(LAN.url)
    answering.delete(TAILNET.url)
    transport.report({ kind: 'dropped' })
    // The supervisor's first retry comes well before the recheck.
    await clock.advance(EARLIER_ROUTE_RECHECK_MS - 1)
    expect(transport.dials.at(-1)).toBe(LAN.url)
  })

  test('with no route answering, each retry asks every route again and starts from the first one', async () => {
    const answering = new Set([RELAY.url])
    const { hostLink, transport, clock } = link([LAN, TUNNEL, RELAY], answering)
    hostLink.start()
    await settle()
    expect(transport.dials).toEqual([RELAY.url])
    transport.report({ kind: 'accepted', recovered: false })

    answering.clear()
    transport.report({ kind: 'dropped' })
    await clock.advance(EARLIER_ROUTE_RECHECK_MS - 1)
    // No route proved the host, so the dial goes to the first route a dial may try unproven.
    const retries = transport.dials.slice(1)
    expect(retries.length).toBeGreaterThan(0)
    expect(retries[0]).toBe(TUNNEL.url)

    // The first route answers again: the next retry takes it.
    answering.add(LAN.url)
    transport.report({ kind: 'dial-failed' })
    await clock.advance(EARLIER_ROUTE_RECHECK_MS)
    expect(transport.dials.at(-1)).toBe(LAN.url)
  })
})
