// Adapted from T3 Code apps/mobile/src/native/nativeWebSocket.ios.test.ts (MIT, see apps/mobile/UPSTREAM.md).
// Each load of the iOS module is a fresh copy (a query string), so the native
// module it finds at load time can differ between cases.
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { HostSocket, type HostSocketClose } from '@solus/client-core/host-socket'
import { openWebSocket, setWebSocketFactory } from '@solus/client-core/web-socket'
import type { SolusWebSocketModule } from '../../apps/mobile/src/platform/native-web-socket.ios'

let installedModule: SolusWebSocketModule | null = null
mock.module('expo', () => ({ requireOptionalNativeModule: () => installedModule }))

type NativeSocket = typeof import('../../apps/mobile/src/platform/native-web-socket.ios')
let loadCount = 0
function loadNativeSocket(native: SolusWebSocketModule | null): Promise<NativeSocket> {
  installedModule = native
  return import(`../../apps/mobile/src/platform/native-web-socket.ios.ts?case=${loadCount++}`)
}

type NativeEvent = 'open' | 'message' | 'error' | 'close'

function fakeModule() {
  const listeners = new Map<NativeEvent, (event: never) => void>()
  let nextId = 7
  const calls = { connect: [] as string[], text: [] as Array<[number, string]>, binary: [] as Array<[number, Uint8Array]>, close: [] as Array<[number, number, string]> }
  const native: SolusWebSocketModule = {
    connect: (url) => { calls.connect.push(url); return nextId++ },
    sendText: (id, text) => { calls.text.push([id, text]) },
    sendBinary: (id, bytes) => { calls.binary.push([id, bytes]) },
    close: (id, code, reason) => { calls.close.push([id, code, reason]) },
    addListener: (event, listener) => {
      listeners.set(event, listener as (event: never) => void)
      return { remove: () => listeners.delete(event) }
    },
  }
  const emit = {
    open: (id: number) => listeners.get('open')?.({ id } as never),
    message: (id: number, frame: { text?: string; data?: Uint8Array }) => listeners.get('message')?.({ id, ...frame } as never),
    error: (id: number, message: string) => listeners.get('error')?.({ id, message } as never),
    close: (id: number, code: number, reason: string) => listeners.get('close')?.({ id, code, reason, wasClean: true } as never),
  }
  return { native, calls, emit }
}

async function nativeSocket() {
  const fake = fakeModule()
  const { nativeWebSocketFactory } = await loadNativeSocket(null)
  const socket = nativeWebSocketFactory(fake.native)('ws://host.test/ws')
  const events: unknown[] = []
  socket.addEventListener('open', () => events.push('open'))
  socket.addEventListener('message', (event) => events.push(event.data))
  socket.addEventListener('error', () => events.push('error'))
  socket.addEventListener('close', (event) => events.push({ code: event.code, reason: event.reason }))
  return { ...fake, socket, events, id: 7 }
}

afterEach(() => setWebSocketFactory(null))

describe('the iOS native WebSocket', () => {
  it('delivers text as a string and binary as an ArrayBuffer of only its own bytes', async () => {
    // WHY: client-core reads binary frames (browser frames) as an ArrayBuffer, as the
    // browser does with binaryType 'arraybuffer'. A view's whole buffer would add bytes.
    const { socket, emit, events, calls, id } = await nativeSocket()
    expect(calls.connect).toEqual(['ws://host.test/ws'])
    expect(() => socket.send('early')).toThrow(/connecting/)

    emit.open(id)
    emit.message(id, { text: 'hello' })
    emit.message(id, { data: new Uint8Array([1, 2, 3]).subarray(1) })
    emit.message(id + 1, { text: 'another socket' })
    expect(events.slice(0, 2)).toEqual(['open', 'hello'])
    expect(events[2]).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(events[2] as ArrayBuffer)]).toEqual([2, 3])
    expect(events).toHaveLength(3)

    const bytes = new Uint8Array([9])
    socket.send('out')
    socket.send(bytes)
    expect(calls.text).toEqual([[id, 'out']])
    expect(calls.binary).toEqual([[id, bytes]])
  })

  it("reports the host's close code and reason once and ignores later events", async () => {
    // WHY: the host's close code (for one, a refused credential) decides whether the
    // client redials; a second close would report the end twice.
    const { emit, events, socket, id } = await nativeSocket()
    emit.open(id)
    emit.close(id, 4001, 'unauthorized')
    emit.close(id, 1006, '')
    emit.message(id, { text: 'late' })
    expect(socket.readyState).toBe(3)
    expect(events).toEqual(['open', { code: 4001, reason: 'unauthorized' }])
  })

  it('reports an error before the close when the handshake fails', async () => {
    const { emit, events, id } = await nativeSocket()
    emit.error(id, 'connection refused')
    emit.close(id, 1006, '')
    expect(events).toEqual(['error', { code: 1006, reason: '' }])
  })

  it('closes through the module once and drops writes after close', async () => {
    // WHY: client-core writes a pong or a reply as a socket ends; the browser drops it, so must this.
    const { socket, emit, calls, events, id } = await nativeSocket()
    emit.open(id)
    socket.close(1000, 'done')
    socket.close(1000, 'again')
    expect(socket.readyState).toBe(2)
    expect(calls.close).toEqual([[id, 1000, 'done']])
    expect(() => socket.send('after close')).not.toThrow()
    expect(calls.text).toEqual([])
    emit.close(id, 1000, 'done')
    expect(events).toEqual(['open', { code: 1000, reason: 'done' }])
  })

  it("carries the host's close to a HostSocket", async () => {
    const { native, emit } = fakeModule()
    const { nativeWebSocketFactory } = await loadNativeSocket(null)
    setWebSocketFactory(nativeWebSocketFactory(native))
    const closes: HostSocketClose[] = []
    new HostSocket('http://host.test', { welcome: () => {}, refused: () => {}, result: () => {}, closed: (close) => closes.push(close) })
    emit.open(7)
    emit.close(7, 4001, 'unauthorized')
    expect(closes).toEqual([{ opened: true, welcomed: false, code: 4001, reason: 'unauthorized' }])
  })
})

describe('the WebSocket client-core dials on iOS', () => {
  it('stays the platform WebSocket when the build has no native module', async () => {
    // WHY: a dev client built before the module shipped must still connect.
    const platformSocket = globalThis.WebSocket
    const dialed: string[] = []
    class PlatformSocket {
      binaryType = 'blob'
      constructor(url: string) { dialed.push(url) }
    }
    Reflect.set(globalThis, 'WebSocket', PlatformSocket)
    try {
      await loadNativeSocket(null)
      const socket = openWebSocket('ws://host.test/ws')
      expect(socket).toBeInstanceOf(PlatformSocket)
      expect(dialed).toEqual(['ws://host.test/ws'])
      expect(Reflect.get(socket, 'binaryType')).toBe('arraybuffer')
    } finally {
      Reflect.set(globalThis, 'WebSocket', platformSocket)
    }
  })

  it('dials through the native module when the build has it', async () => {
    const { native, calls } = fakeModule()
    await loadNativeSocket(native)
    openWebSocket('ws://host.test/ws')
    expect(calls.connect).toEqual(['ws://host.test/ws'])
  })
})
