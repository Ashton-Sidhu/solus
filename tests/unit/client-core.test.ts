import { describe, expect, test } from 'bun:test'
import { localApi } from '../../src/client-core/local-api'
import { mergeNativeOnlySolusApi } from '../../src/client-core/native-api-overlay'
import { createNoHostSolusApi } from '../../src/client-core/no-host-api'
import { claimServer, normalizeServerUrl, pairServer, parsePairLink, saveBootstrappedServer } from '../../src/client-core/pairing'
import { base64UrlToUint8Array } from '../../src/client-core/push'
import { encodeQrByteMode } from '../../src/client-core/qr'
import {
  shouldRejectQueuedRequest,
  TransportDisconnectedError,
  WsTransport,
} from '../../src/client-core/ws-transport'

describe('client core transport helpers', () => {
  test('loads before the client bridge and follows the bridge installed later', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { solus: { getPlatform: () => 'web' } },
      })
      expect(localApi.getPlatform()).toBe('web')

      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { solus: { getPlatform: () => 'darwin' } },
      })
      expect(localApi.getPlatform()).toBe('darwin')
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })

  test('keeps the no-host boot API inert and referentially stable', async () => {
    const api = createNoHostSolusApi()

    expect(api.getPlatform()).toBe('web')
    expect(api.getPathForFile({} as File)).toBe('')
    expect(api.start).toBe(api.start)
    expect('onEvent' in api).toBe(false)

    let settled = false
    void api.start().finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
  })

  test('exposes host events separately from the RPC API', () => {
    const transport = new WsTransport({ serverUrl: 'http://localhost:3000', sessionToken: '' })
    const received: unknown[] = []
    const unsubscribe = transport.events.subscribe('tasks.invalidated', (payload) => received.push(payload))

    transport.events.receive({
      type: 'tasks.invalidated',
      payload: { projectRoot: '/project' },
      occurredAt: 123,
    })
    unsubscribe()
    transport.events.receive({
      type: 'tasks.invalidated',
      payload: { projectRoot: '/ignored' },
      occurredAt: 124,
    })

    expect(received).toEqual([{ projectRoot: '/project' }])
    expect('onTasksChanged' in transport.buildSolusApi()).toBe(false)
    transport.destroy()
  })

  test('uploads voice as compact WAV without enqueueing an RPC', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ error: null, transcript: 'A long idea.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const transport = new WsTransport({
      serverUrl: 'http://localhost:3000',
      sessionToken: 'voice-token',
    })
    try {
      const api = transport.buildSolusApi() as Record<string, (...args: unknown[]) => Promise<unknown>>
      const samples = new Float32Array(16_000)
      const result = await api.transcribeAudio(samples)

      expect(result).toEqual({ error: null, transcript: 'A long idea.' })
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('http://localhost:3000/voice/transcribe')
      expect(calls[0].init?.headers).toEqual({
        authorization: 'Bearer voice-token',
        'content-type': 'audio/wav',
      })
      expect((calls[0].init?.body as ArrayBuffer).byteLength).toBe(44 + 16_000 * 2)
      expect((transport as unknown as { requests: Map<string, unknown> }).requests.size).toBe(0)
    } finally {
      transport.destroy()
      globalThis.fetch = originalFetch
    }
  })

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

  test('keeps host RPCs on WebSocket but opens external links on the client device', () => {
    const transportApi = {
      start: () => 'ws-start',
      openExternal: () => 'web-open',
      getPlatform: () => 'web',
      getPathForFile: () => '',
      setQuoteContext: () => 'ws-quote',
      onAskSelectionInNewSession: () => 'ws-ask',
    }
    const nativeApi = {
      start: () => 'ipc-start',
      openExternal: () => 'native-open',
      getPlatform: () => 'darwin',
      getPathForFile: () => '/tmp/file.txt',
      setQuoteContext: () => 'native-quote',
      onAskSelectionInNewSession: () => 'native-ask',
      rendererReady: () => 'native-ready',
      rendererMounted: () => 'native-mounted',
    }

    const merged = mergeNativeOnlySolusApi(transportApi, nativeApi)

    expect((merged.start as () => string)()).toBe('ws-start')
    expect((merged.openExternal as () => string)()).toBe('native-open')
    expect((merged.getPlatform as () => string)()).toBe('darwin')
    expect((merged.getPathForFile as () => string)()).toBe('/tmp/file.txt')
    expect((merged.setQuoteContext as () => string)()).toBe('native-quote')
    expect((merged.onAskSelectionInNewSession as () => string)()).toBe('native-ask')
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
        os: 'macos',
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
        os: 'macos',
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
        os: 'linux',
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
        os: 'linux',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('saves SSH bootstrapped credentials without another pairing exchange', () => {
    const server = saveBootstrappedServer(
      'http://100.64.0.8:3000/',
      {
        sessionToken: 'ssh-issued-session',
        installationId: 'ssh-installation',
        fingerprint: 'abc12345',
      },
      'Build Host',
      'linux',
    )

    expect(server).toMatchObject({
      id: 'ssh-installation',
      label: 'Build Host',
      url: 'http://100.64.0.8:3000',
      sessionToken: 'ssh-issued-session',
      installationId: 'ssh-installation',
      os: 'linux',
    })
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
