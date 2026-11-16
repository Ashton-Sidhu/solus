import { describe, expect, test } from 'bun:test'
import { SolusApp } from '../../apps/mobile/src/app/solus-app'
import { previewHost, unreachableMessage } from '../../apps/mobile/src/features/hosts/lib/pair-input'
import { nearbyHostDetail } from '../../apps/mobile/src/features/hosts/use-nearby-hosts'
import { nativeGet } from '../../apps/mobile/src/platform/native-get'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'
import type { DiscoveredServer } from '@solus/contracts/types'
import { FakeApi, FakeTransport, flushPromises } from './helpers/native-mobile-fakes'

// docs/plans/tailscale-support.md, the phone's half. Over mobile data the phone
// reaches its host only over the tailnet: it must say why an address did not answer
// (D2), find tailnet hosts through the hosts it is connected to (D3), and save a
// tailnet address it found there with the tailnet kind (D8).

const ATS_TEXT = 'The resource could not be loaded because the App Transport Security policy requires the use of a secure connection.'

describe('the add-host screen says why a host did not answer (D2)', () => {
  test('an ATS refusal says to update the app, not to check the network', async () => {
    const result = await previewHost((async () => { throw new TypeError(ATS_TEXT) }) as unknown as typeof fetch, 'http://100.87.157.17:3001')
    expect(result).toEqual({ kind: 'unreachable', cause: 'insecure-blocked', error: ATS_TEXT })
    if (result.kind !== 'unreachable') return
    expect(unreachableMessage(result).message).toBe('This app blocked a plain-HTTP connection to this address. Update Solus, or use an HTTPS address.')
  })

  test('a timeout and a refused port each name their own check', async () => {
    const silent = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })) as unknown as typeof fetch
    const timedOut = await previewHost(silent, 'http://100.64.0.2:3000', 0)
    expect(timedOut.kind === 'unreachable' && unreachableMessage(timedOut).message).toContain('Tailscale or your Wi-Fi')

    const refused = await previewHost((async () => { throw new Error('ECONNREFUSED (Connection refused)') }) as unknown as typeof fetch, 'http://10.0.0.8:3001')
    expect(refused.kind === 'unreachable' && unreachableMessage(refused).message).toContain('a Solus host often uses 3000')
  })

  test('any other failure keeps the old message and shows the error text under it', async () => {
    const result = await previewHost((async () => { throw new TypeError('Could not connect to the server.') }) as unknown as typeof fetch, 'http://10.0.0.8:3000')
    if (result.kind !== 'unreachable') throw new Error('expected unreachable')
    expect(unreachableMessage(result)).toEqual({
      message: 'The host did not answer. Check the address and that this device is on a network that can reach it.',
      detail: 'Could not connect to the server.',
    })
  })
})

/** React Native's XMLHttpRequest, as `nativeGet` drives it. */
class FakeRequest {
  status = 0
  responseText = ''
  url = ''
  aborted = false
  private readonly listeners = new Map<string, () => void>()
  addEventListener(type: string, listener: () => void): void { this.listeners.set(type, listener) }
  open(_method: string, url: string): void { this.url = url }
  send(): void {}
  abort(): void { this.aborted = true }
  fire(type: 'load' | 'error' | 'timeout'): void { this.listeners.get(type)?.() }
}

describe('nativeGet keeps the native error text that fetch drops', () => {
  test('a native failure rejects with its own text, so previewHost can name ATS', async () => {
    // WHY: React Native's fetch rejects every failure with "Network request failed".
    const request = new FakeRequest()
    const pending = nativeGet('http://100.87.157.17:3001/health', {}, () => request)
    request.responseText = ATS_TEXT
    request.fire('error')
    await expect(pending).rejects.toThrow(ATS_TEXT)
  })

  test('an answer resolves with its status and body', async () => {
    const request = new FakeRequest()
    const pending = nativeGet('http://h:1/health', {}, () => request)
    expect(request.url).toBe('http://h:1/health')
    request.status = 200
    request.responseText = '{"ok":true}'
    request.fire('load')
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test('an abort stops the request and rejects as the signal says', async () => {
    const request = new FakeRequest()
    const controller = new AbortController()
    const pending = nativeGet('http://h:1/health', { signal: controller.signal }, () => request)
    controller.abort(new DOMException('timed out', 'TimeoutError'))
    await expect(pending).rejects.toThrow('timed out')
    expect(request.aborted).toBe(true)
  })
})

const discovered = (installationId: string, host: string, source: DiscoveredServer['source']): DiscoveredServer =>
  ({ host, port: 3000, name: installationId, installationId, source })

function healthFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/pair')) return Response.json({ sessionToken: 'tok', installationId: url.includes('100.64.0.3') ? 'inst-c' : 'inst-a' })
    return Response.json({ ok: true, installationId: 'inst-a', name: 'Studio Mac' })
  }) as typeof fetch
}

async function connectedApp(hostAnswer: () => Promise<DiscoveredServer[]>, ownScan: DiscoveredServer[]) {
  const transports: FakeTransport[] = []
  const app = new SolusApp({
    storage: memoryKeyValueStore(),
    secrets: memorySecretStore(),
    fetch: healthFetch(),
    createTransport: (options) => {
      const transport = new FakeTransport(options, new FakeApi().on('discoverServers', hostAnswer))
      transports.push(transport)
      return transport
    },
    openBrowser: async () => {},
    deviceLabel: 'Solus for iPhone',
    uuid: () => 'uuid-1',
    scanLocalNetwork: async () => ownScan,
  })
  await app.load()
  await app.pair({ url: 'https://studio.example.com' }, '123456')
  app.connections.connection('inst-a')
  await flushPromises()
  await transports[0]!.accept()
  expect(app.connections.readiness('inst-a').readiness).toBe('ready')
  return app
}

describe('the phone finds tailnet hosts through the hosts it is connected to (D3)', () => {
  test("a connected host's tailnet hosts are listed; its LAN hosts and the phone's own LAN route win or stay out", async () => {
    const app = await connectedApp(
      async () => [discovered('inst-b', '100.64.0.9', 'tailnet'), discovered('inst-c', '100.64.0.3', 'tailnet'), discovered('inst-d', '192.168.5.5', 'lan')],
      [discovered('inst-b', '10.0.0.9', 'lan')],
    )
    const nearby = await app.scanNearby()
    expect(nearby).toEqual([discovered('inst-b', '10.0.0.9', 'lan'), discovered('inst-c', '100.64.0.3', 'tailnet')])
    expect(nearbyHostDetail(nearby[1]!)).toBe('100.64.0.3 · Tailscale')
  })

  test('a saved host found on the tailnet gains a tailnet discovery route', async () => {
    const app = await connectedApp(async () => [discovered('inst-e', '100.64.0.5', 'tailnet')], [])
    await app.registry.savePaired({ id: 'inst-e', label: 'Build box', url: 'https://build.example.com' }, 'tok-e')
    expect(await app.scanNearby()).toEqual([])
    expect(app.registry.host('inst-e')!.routes).toContainEqual(expect.objectContaining({ kind: 'tailnet', url: 'http://100.64.0.5:3000', source: 'discovery' }))
  })

  test('a host that fails to answer does not stop the phone\'s own scan', async () => {
    const app = await connectedApp(async () => { throw new Error('discovery failed') }, [discovered('inst-b', '10.0.0.9', 'lan')])
    expect((await app.scanNearby()).map((server) => server.installationId)).toEqual(['inst-b'])
  })

  test('pairing a host found on the tailnet saves its address as a tailnet route (D8)', async () => {
    const app = await connectedApp(async () => [], [])
    const host = await app.pair({ url: 'http://100.64.0.3:3000', onTailnet: true }, '123456')
    expect(host.routes.map((route) => route.kind)).toEqual(['tailnet'])
  })
})
