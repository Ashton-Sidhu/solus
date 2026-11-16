import { describe, expect, test } from 'bun:test'
import { failureText, unreachableCause } from '@solus/client-core/host-unreachable'
import { askHostsToDiscover, HOST_DISCOVERY_TIMEOUT_MS, mergeDiscovered } from '@solus/client-core/discovery-through-hosts'
import { pairServer } from '@solus/client-core/pairing'
import { readAddress } from '@solus/client-core/host-connection-check'
import { diagnoseHostConnection } from '@solus/client-core/host-connection-diagnosis'
import type { HostDiagnostics } from '@solus/client-core/host-diagnostics'
import type { DiscoveredServer } from '@solus/contracts/types'

// docs/plans/tailscale-support.md: a phone on mobile data reaches its host only over
// the tailnet. These pin the client half: the real reason a host did not answer (D2),
// tailnet hosts found through connected hosts (D3, D4), and the tailnet kind of an
// address that discovery found there (D8).

const ATS_TEXT = 'The resource could not be loaded because the App Transport Security policy requires the use of a secure connection.'

describe('why an address did not answer (D2)', () => {
  test('the iOS App Transport Security refusal is named, by its text or its code', () => {
    // WHY: on 2026-11-16 this refusal hid behind "The host did not answer".
    expect(unreachableCause(new TypeError(ATS_TEXT), false)).toBe('insecure-blocked')
    expect(unreachableCause(new Error('NSURLErrorDomain error -1022'), false)).toBe('insecure-blocked')
  })

  test('a fired timeout is a timeout, whatever the error says', () => {
    expect(unreachableCause(new Error('Aborted'), true)).toBe('timeout')
    const timeout = new Error('The operation timed out.')
    timeout.name = 'TimeoutError'
    expect(unreachableCause(timeout, false)).toBe('timeout')
  })

  test('a refused connection is named from its text or from the cause Node attaches', () => {
    expect(unreachableCause(new Error('Failed to connect to /100.64.0.2:3000: ECONNREFUSED (Connection refused)'), false)).toBe('refused')
    const node = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 100.64.0.2:3000'), { code: 'ECONNREFUSED' }) })
    expect(unreachableCause(node, false)).toBe('refused')
    expect(failureText(node)).toBe('fetch failed: connect ECONNREFUSED 100.64.0.2:3000')
  })

  test('a browser error that names nothing stays "other", with its text kept', () => {
    // WHY: "Could not connect to the server" also means a sleeping host, so it must not claim a wrong port.
    expect(unreachableCause(new TypeError('Failed to fetch'), false)).toBe('other')
    expect(unreachableCause(new Error('Could not connect to the server.'), false)).toBe('other')
    expect(failureText(new TypeError('Failed to fetch'))).toBe('Failed to fetch')
  })

  test('the connection check keeps the error text, and diagnosis blames this device for an ATS refusal', async () => {
    const atsFetch = (async () => { throw new TypeError(ATS_TEXT) }) as unknown as typeof fetch
    const answer = await readAddress(atsFetch, 'http://100.87.157.17:3001/health', new AbortController().signal)
    expect(answer).toEqual({ kind: 'no-answer', error: ATS_TEXT })

    const diagnostics: HostDiagnostics = {
      hostId: 'studio',
      label: 'Studio',
      installationId: 'inst-1',
      state: { readiness: 'unreachable', away: true, unreachableReason: 'no-answer', refusedReason: null, lastSeenAt: 0 },
      dialedUrl: 'http://100.87.157.17:3001',
      routes: [{ kind: 'tailnet', url: 'http://100.87.157.17:3001' }],
      attempt: 2,
      lastDialError: null,
      hostVersion: null,
      clientVersion: '1.0.0',
      connectionCheck: { at: 0, isDeviceOffline: false, cloud: null, routes: [{ kind: 'tailnet', url: 'http://100.87.157.17:3001', answer }] },
      isCheckingConnection: false,
    }
    const diagnosis = diagnoseHostConnection(diagnostics)!
    expect(diagnosis.failedStage).toBe('device')
    expect(diagnosis.headline).toBe('This app blocked a plain-HTTP connection to Studio')
    // The host was never asked, so its stage is not called failed.
    expect(diagnosis.stages.find((stage) => stage.stage === 'host')?.result).toBe('unknown')
  })

  test('diagnosis names the port when an address refused the connection', () => {
    const url = 'http://100.64.0.2:3001'
    const diagnosis = diagnoseHostConnection({
      hostId: 'studio', label: 'Studio', installationId: 'inst-1',
      state: { readiness: 'unreachable', away: true, unreachableReason: 'no-answer', refusedReason: null, lastSeenAt: 0 },
      dialedUrl: url, routes: [{ kind: 'tailnet', url }], attempt: 1, lastDialError: null, hostVersion: null, clientVersion: '1.0.0',
      connectionCheck: { at: 0, isDeviceOffline: false, cloud: null, routes: [{ kind: 'tailnet', url, answer: { kind: 'no-answer', error: 'ECONNREFUSED' } }] },
      isCheckingConnection: false,
    })!
    expect(diagnosis.failedStage).toBe('host')
    expect(diagnosis.steps).toContain(`Nothing listens at ${url}. Check the port; a Solus host often uses 3000.`)
  })
})

const found = (installationId: string, host: string, source: DiscoveredServer['source']): DiscoveredServer =>
  ({ host, port: 3000, name: installationId, installationId, source })

describe('tailnet hosts found through connected hosts (D3, D4)', () => {
  test("a host's LAN results are left out: they describe the host's network, not this device's", () => {
    const merged = mergeDiscovered([], [[found('inst-b', '100.64.0.9', 'tailnet'), found('inst-d', '192.168.5.5', 'lan')]])
    expect(merged.map((server) => server.installationId)).toEqual(['inst-b'])
  })

  test("this device's own result wins over a tailnet result for the same host: it is the closer route", () => {
    const merged = mergeDiscovered(
      [found('inst-b', '10.0.0.9', 'lan')],
      [[found('inst-b', '100.64.0.9', 'tailnet'), found('inst-c', '100.64.0.3', 'tailnet')], [found('inst-c', '100.64.0.33', 'tailnet')]],
    )
    expect(merged).toEqual([found('inst-b', '10.0.0.9', 'lan'), found('inst-c', '100.64.0.3', 'tailnet')])
  })

  test('a host that fails or does not answer in time is left out, and does not stop the others', async () => {
    const timers = new Map<number, () => void>()
    let next = 0
    const setTimeoutFn = ((callback: () => void, ms: number) => {
      expect(ms).toBe(HOST_DISCOVERY_TIMEOUT_MS)
      timers.set(++next, callback)
      return next
    }) as unknown as typeof setTimeout
    const clearTimeoutFn = ((id: number) => { timers.delete(id) }) as unknown as typeof clearTimeout
    const answers = askHostsToDiscover([
      async () => [found('inst-c', '100.64.0.3', 'tailnet')],
      async () => { throw new Error('host refused the request') },
      () => new Promise<DiscoveredServer[]>(() => {}),
    ], { setTimeoutFn, clearTimeoutFn })
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    // Only the silent host's timer is left; it fires at the limit.
    expect(timers.size).toBe(1)
    for (const fire of timers.values()) fire()
    expect(await answers).toEqual([[found('inst-c', '100.64.0.3', 'tailnet')], [], []])
  })
})

describe('the kind of a paired tailnet address (D8)', () => {
  const pairFetch = (async () => new Response(JSON.stringify({ sessionToken: 'tok', installationId: 'inst-c' }))) as unknown as typeof fetch

  test('a host that discovery found on the tailnet is saved with a tailnet route, not a vpn route', async () => {
    // WHY: only a confirmed tailnet route counts as encrypted (isEncryptedRouteUrl).
    const { server } = await pairServer({ url: 'http://100.64.0.3:3000', pairToken: '123456', deviceLabel: 'Phone', fetchImpl: pairFetch, onTailnet: true })
    expect(server.routes.map((route) => route.kind)).toEqual(['tailnet'])
  })

  test('the same address typed by hand stays vpn until the host advertises its routes', async () => {
    const { server } = await pairServer({ url: 'http://100.64.0.3:3000', pairToken: '123456', deviceLabel: 'Phone', fetchImpl: pairFetch })
    expect(server.routes.map((route) => route.kind)).toEqual(['vpn'])
  })
})
