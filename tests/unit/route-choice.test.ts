import { describe, expect, test } from 'bun:test'
import type { HostRoute } from '@solus/contracts/uplink'
import { chooseRoute, directRouteBack, DIRECT_ROUTE_GRACE_MS, ROUTE_CHECK_TIMEOUT_MS } from '@solus/client-core/route-choice'

const lan: HostRoute = { kind: 'direct', url: 'http://192.168.1.20:7777' }
const staleLan: HostRoute = { kind: 'direct', url: 'http://10.0.0.9:51234' }
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
