import { describe, expect, test } from 'bun:test'
import type { HostRoute } from '@solus/contracts/host-routes'
import { chooseRoute, dialableRoutes, directRouteBack, DIRECT_ROUTE_GRACE_MS, LEARNED_ROUTE_TTL_MS, mergeRoutes, ROUTE_CHECK_TIMEOUT_MS, routeForUrl } from '@solus/contracts/host-routes'

const lan: HostRoute = { kind: 'lan', url: 'http://192.168.1.20:7777' }
const staleLan: HostRoute = { kind: 'lan', url: 'http://10.0.0.9:51234' }
const tunnel: HostRoute = { kind: 'tunnel', url: 'https://studio.tunnel.solus.sh' }

/** Timers a test fires by hand, so no check waits on the clock. */
function manualTimers() {
  const pending = new Map<number, { at: number; run: () => void }>()
  let now = 0
  let nextId = 1
  const setTimeoutFn = ((run: () => void, ms: number) => {
    const id = nextId++
    pending.set(id, { at: now + ms, run })
    return id
  }) as unknown as typeof setTimeout
  const clearTimeoutFn = ((id: number) => { pending.delete(id) }) as unknown as typeof clearTimeout
  const advance = (ms: number) => {
    now += ms
    for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now) continue
      pending.delete(id)
      timer.run()
    }
  }
  return { setTimeoutFn, clearTimeoutFn, advance, pendingCount: () => pending.size }
}

/** A check whose answer for each url the test gives later; an aborted check answers false. */
function scriptedCheck() {
  const answers = new Map<string, (answers: boolean) => void>()
  const asked: string[] = []
  const check = (url: string, signal: AbortSignal) => new Promise<boolean>((resolve) => {
    asked.push(url)
    answers.set(url, resolve)
    signal.addEventListener('abort', () => resolve(false))
  })
  return { check, asked, answer: (url: string, value: boolean) => answers.get(url)?.(value) }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('chooseRoute', () => {
  test('asks every route at once, so a dead address does not delay the next one', async () => {
    const timers = manualTimers()
    const { check, asked, answer } = scriptedCheck()
    const choice = chooseRoute([staleLan, lan, tunnel], check, timers)
    expect(asked).toEqual([staleLan.url, lan.url, tunnel.url])
    answer(lan.url, true)
    expect(await choice).toEqual(lan)
  })

  test('a direct route that answers wins over a tunnel that answered first', async () => {
    const timers = manualTimers()
    const { check, answer } = scriptedCheck()
    const choice = chooseRoute([lan, tunnel], check, timers)
    answer(tunnel.url, true)
    await flush()
    timers.advance(DIRECT_ROUTE_GRACE_MS - 1)
    answer(lan.url, true)
    expect(await choice).toEqual(lan)
  })

  test('the tunnel wins when no direct route answers within the grace', async () => {
    // WHY: away from the host's network, the phone must not wait out the full check
    // timeout for an address that will never answer.
    const timers = manualTimers()
    const { check, answer } = scriptedCheck()
    const choice = chooseRoute([staleLan, tunnel], check, timers)
    answer(tunnel.url, true)
    await flush()
    timers.advance(DIRECT_ROUTE_GRACE_MS)
    expect(await choice).toEqual(tunnel)
    expect(timers.pendingCount()).toBe(0)
  })

  test('a route that answers as another host is never chosen', async () => {
    const timers = manualTimers()
    const { check, answer } = scriptedCheck()
    const choice = chooseRoute([lan, tunnel], check, timers)
    answer(lan.url, false)
    answer(tunnel.url, true)
    expect(await choice).toEqual(tunnel)
  })

  test('no route answers before the timeout: null, and every check is stopped', async () => {
    const timers = manualTimers()
    const { check } = scriptedCheck()
    const choice = chooseRoute([lan, tunnel], check, timers)
    timers.advance(ROUTE_CHECK_TIMEOUT_MS)
    expect(await choice).toBeNull()
  })
})

describe('directRouteBack', () => {
  test('a host reached through its tunnel goes back to a direct route that answers', async () => {
    const { check, answer, asked } = scriptedCheck()
    const back = directRouteBack([lan, tunnel], tunnel.url, check, manualTimers())
    expect(asked).toEqual([lan.url])
    answer(lan.url, true)
    expect(await back).toEqual(lan)
  })

  test('a host already on a direct route is not checked', async () => {
    const { check, asked } = scriptedCheck()
    expect(await directRouteBack([lan, tunnel], lan.url, check, manualTimers())).toBeNull()
    expect(asked).toEqual([])
  })
})

// docs/plans/host-routes.md D1: one merge rule and one dial order for every client and the server.
describe('mergeRoutes', () => {
  const named = (routes: readonly HostRoute[]) => routes.map((route) => `${route.source} ${route.url}`)

  test('a read from one source replaces only that source\'s routes', () => {
    // WHY: a directory read must not erase the address this client paired at or found on its network.
    let routes = mergeRoutes([], [{ kind: 'lan', url: 'http://10.0.0.8:3000' }], 'pairing', 1)
    routes = mergeRoutes(routes, [{ kind: 'lan', url: 'http://192.168.1.20:7777' }], 'discovery', 2)
    routes = mergeRoutes(routes, [tunnel], 'directory', 3)
    routes = mergeRoutes(routes, [{ kind: 'tunnel', url: 'https://moved.tunnel.solus.sh' }], 'directory', 4)
    expect(named(routes)).toEqual(['directory https://moved.tunnel.solus.sh', 'discovery http://192.168.1.20:7777', 'pairing http://10.0.0.8:3000'])
    // An empty read from a source removes that source's routes and nothing else.
    expect(named(mergeRoutes(routes, [], 'directory', 5))).toEqual(['discovery http://192.168.1.20:7777', 'pairing http://10.0.0.8:3000'])
    // Each kept route says when its source last named it.
    expect(routes.find((route) => route.source === 'directory')?.seenAt).toBe(4)
  })

  test('a route the host advertised or a scan found expires when no read names it for the TTL', () => {
    // WHY: a learned address goes stale when a machine moves; the user typed no such address, so it may go.
    const learned = [
      { ...lan, source: 'host' as const, seenAt: 0 },
      { ...staleLan, source: 'discovery' as const, seenAt: 0 },
    ]
    expect(named(mergeRoutes(learned, [], 'directory', LEARNED_ROUTE_TTL_MS - 1))).toEqual(['host http://192.168.1.20:7777', 'discovery http://10.0.0.9:51234'])
    expect(mergeRoutes(learned, [], 'directory', LEARNED_ROUTE_TTL_MS)).toEqual([])
  })

  test('a paired or directory route never expires by age', () => {
    // WHY: the user paired that address; the directory replaces its own routes on every read.
    const kept = [
      { ...lan, source: 'pairing' as const, seenAt: 0 },
      { ...tunnel, source: 'directory' as const, seenAt: 0 },
    ]
    expect(named(mergeRoutes(kept, [], 'discovery', 10 * LEARNED_ROUTE_TTL_MS))).toEqual(['pairing http://192.168.1.20:7777', 'directory https://studio.tunnel.solus.sh'])
  })
})

describe('routeForUrl', () => {
  test('a Tailscale address or name is a tailnet route; any other address is a lan route', () => {
    expect(routeForUrl('http://100.64.0.2:7777')).toEqual({ kind: 'tailnet', url: 'http://100.64.0.2:7777' })
    expect(routeForUrl('http://100.127.255.1:7777').kind).toBe('tailnet')
    expect(routeForUrl('https://studio.tail1234.ts.net').kind).toBe('tailnet')
    // Just outside 100.64.0.0/10.
    expect(routeForUrl('http://100.63.0.1:7777').kind).toBe('lan')
    expect(routeForUrl('http://100.128.0.1:7777').kind).toBe('lan')
    expect(routeForUrl('http://192.168.1.20:7777').kind).toBe('lan')
    expect(routeForUrl('not a url').kind).toBe('lan')
  })
})

describe('dialableRoutes', () => {
  const tailnet: HostRoute = { kind: 'tailnet', url: 'http://100.64.0.2:7777' }
  const forwarded: HostRoute = { kind: 'forwarded', url: 'http://127.0.0.1:41000', viaHostId: 'inst-laptop' }

  test('routes are dialed forwarded, then lan, then tailnet, then the tunnel, whatever order they were saved in', () => {
    // WHY: local traffic stays local, and a host stays usable when Solus cloud is down.
    expect(dialableRoutes([tunnel, tailnet, lan, forwarded], 'http://127.0.0.1:5173', 'inst-laptop').map((route) => route.kind))
      .toEqual(['forwarded', 'lan', 'tailnet', 'tunnel'])
    // Routes of one kind keep their saved order.
    expect(dialableRoutes([staleLan, lan], '').map((route) => route.url)).toEqual([staleLan.url, lan.url])
  })

  test('an https page drops http routes: a browser refuses mixed content', () => {
    expect(dialableRoutes([lan, tailnet, tunnel], 'https://app.solus.sh')).toEqual([tunnel])
    expect(dialableRoutes([lan, tunnel], 'http://127.0.0.1:5173')).toEqual([lan, tunnel])
  })

  test('a forwarded route is dialed only on the machine that holds the forward', () => {
    // WHY: it is a loopback port; on any other machine it reaches something else.
    expect(dialableRoutes([forwarded, tunnel], '', 'inst-laptop')).toEqual([forwarded, tunnel])
    expect(dialableRoutes([forwarded, tunnel], '', 'inst-other')).toEqual([tunnel])
    expect(dialableRoutes([forwarded, tunnel], '')).toEqual([tunnel])
  })

  test('a url two sources name is dialed once', () => {
    const routes: HostRoute[] = [{ ...lan, source: 'discovery' }, { ...lan, source: 'pairing' }, tunnel]
    expect(dialableRoutes(routes, '').map((route) => route.url)).toEqual([lan.url, tunnel.url])
  })
})
