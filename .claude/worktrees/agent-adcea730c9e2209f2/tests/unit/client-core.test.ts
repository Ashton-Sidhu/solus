import { describe, expect, test } from 'bun:test'
import { mergeNativeOnlySolusApi } from '../../src/client-core/native-api-overlay'
import { claimServer, normalizeServerUrl, pairServer, parsePairLink } from '../../src/client-core/pairing'
import { base64UrlToUint8Array } from '../../src/client-core/push'
import { encodeQrByteMode } from '../../src/client-core/qr'
import {
  shouldRejectQueuedRequest,
  TransportDisconnectedError,
  WsTransport,
} from '../../src/client-core/ws-transport'

describe('client core transport helpers', () => {
  test('rejects undeliverable requests with TransportDisconnectedError', async () => {
    const transport = new WsTransport({ serverUrl: 'http://localhost:3000', sessionToken: '' })
    const api = transport.buildSolusApi() as Record<string, (...args: unknown[]) => Promise<unknown>>
    const request = api.connectionsGetServerInfo()

    transport.destroy()

    try {
      await request
      throw new Error('expected request to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(TransportDisconnectedError)
      expect(err).toMatchObject({ message: 'disconnected', code: 'TRANSPORT_DISCONNECTED' })
    }
  })

  test('expires outage-queued requests after 15s but never ages out the boot queue', () => {
    expect(shouldRejectQueuedRequest(1_000, false, 16_001)).toBe(true)
    expect(shouldRejectQueuedRequest(1_000, false, 16_000)).toBe(false)
    expect(shouldRejectQueuedRequest(1_000, true, 60_000)).toBe(false)
  })

  test('overlays only native methods so RPC calls keep riding WebSocket', () => {
    const transportApi = {
      start: () => 'ws-start',
      getPlatform: () => 'web',
      getPathForFile: () => '',
      setQuoteContext: () => 'ws-quote',
    }
    const nativeApi = {
      start: () => 'ipc-start',
      getPlatform: () => 'darwin',
      getPathForFile: () => '/tmp/file.txt',
      setQuoteContext: () => 'native-quote',
      rendererReady: () => 'native-ready',
      rendererMounted: () => 'native-mounted',
    }

    const merged = mergeNativeOnlySolusApi(transportApi, nativeApi)

    expect((merged.start as () => string)()).toBe('ws-start')
    expect((merged.getPlatform as () => string)()).toBe('darwin')
    expect((merged.getPathForFile as () => string)()).toBe('/tmp/file.txt')
    expect((merged.setQuoteContext as () => string)()).toBe('native-quote')
    expect((merged.rendererReady as () => string)()).toBe('native-ready')
    expect((merged.rendererMounted as () => string)()).toBe('native-mounted')
  })

  test('parses pair links without leaking the /pair path into the server URL', () => {
    expect(parsePairLink('http://10.0.0.8:51234/pair#token=abc123')).toEqual({
      url: 'http://10.0.0.8:51234',
      pairToken: 'abc123',
    })
    expect(parsePairLink('not a link')).toBeNull()
    expect(parsePairLink('http://10.0.0.8:51234/pair')).toBeNull()
  })

  test('normalizes manual server addresses for pairing', () => {
    expect(normalizeServerUrl('10.0.0.8:51234/')).toBe('http://10.0.0.8:51234')
    expect(normalizeServerUrl('https://solus.example.com/')).toBe('https://solus.example.com')
  })

  test('pairs with POST /pair and maps the trusted installation id into the saved server', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        sessionToken: 'device.123.label.sig',
        installationId: 'server-installation-1',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const result = await pairServer({
        url: 'http://10.0.0.8:51234/',
        pairToken: '123456',
        deviceLabel: 'Solus desktop',
        serverLabel: 'Studio Mac',
      })

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('http://10.0.0.8:51234/pair')
      expect(calls[0].init?.method).toBe('POST')
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({
        pairToken: '123456',
        deviceLabel: 'Solus desktop',
      })
      expect(result.server).toMatchObject({
        id: 'server-installation-1',
        label: 'Studio Mac',
        url: 'http://10.0.0.8:51234',
        sessionToken: 'device.123.label.sig',
        installationId: 'server-installation-1',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('claims with POST /claim and maps owner credentials into the saved server', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        ok: true,
        sessionToken: 'owner.123.label.sig',
        ownerDeviceId: 'owner-device-1',
        claimedAt: 1770000000000,
        installationId: 'claimed-installation-1',
        fingerprint: 'abc123ef',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const result = await claimServer({
        url: 'http://100.64.0.4:3000/',
        code: '123456',
        deviceLabel: 'Solus desktop',
        serverLabel: 'Studio server',
      })

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('http://100.64.0.4:3000/claim')
      expect(calls[0].init?.method).toBe('POST')
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({
        code: '123456',
        deviceLabel: 'Solus desktop',
      })
      expect(result).toMatchObject({
        sessionToken: 'owner.123.label.sig',
        ownerDeviceId: 'owner-device-1',
        claimedAt: 1770000000000,
        installationId: 'claimed-installation-1',
        fingerprint: 'abc123ef',
      })
      expect(result.server).toMatchObject({
        id: 'claimed-installation-1',
        label: 'Studio server',
        url: 'http://100.64.0.4:3000',
        sessionToken: 'owner.123.label.sig',
        installationId: 'claimed-installation-1',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('encodes pair links as stable QR byte-mode matrices with finder patterns', () => {
    const qr = encodeQrByteMode('http://127.0.0.1:8765/pair#token=test-token')

    expect(qr.version).toBe(4)
    expect(qr.size).toBe(33)
    expect(qr.modules).toHaveLength(33)
    expect(qr.modules.every((row) => row.length === 33)).toBe(true)
    expect(moduleChecksum(qr.modules)).toEqual({ dark: 581, checksum: 1477092 })

    expectFinderPattern(qr.modules, 0, 0)
    expectFinderPattern(qr.modules, qr.size - 7, 0)
    expectFinderPattern(qr.modules, 0, qr.size - 7)
  })

  test('decodes VAPID base64url applicationServerKey values into bytes', () => {
    expect(Array.from(base64UrlToUint8Array('SGVsbG8td29ybGQ_'))).toEqual(
      Array.from(new TextEncoder().encode('Hello-world?')),
    )
    expect(Array.from(base64UrlToUint8Array('AQID-__6'))).toEqual([1, 2, 3, 251, 255, 250])
  })
})

function moduleChecksum(modules: boolean[][]): { dark: number; checksum: number } {
  let dark = 0
  let checksum = 0
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < modules[y].length; x++) {
      if (!modules[y][x]) continue
      dark++
      checksum = (checksum + (y + 1) * 131 + (x + 1) * 17) >>> 0
    }
  }
  return { dark, checksum }
}

function expectFinderPattern(modules: boolean[][], left: number, top: number): void {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const dist = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      expect(modules[top + y][left + x]).toBe(dist !== 2)
    }
  }
}
