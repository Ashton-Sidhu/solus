import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createServer, type Server as HttpServer } from 'http'
import { createServer as createNetServer } from 'node:net'
import { DatabaseSync } from './helpers/bun-sqlite'
import { WebSocket as RawSocket } from 'ws'
import type { Doors } from '@solus/server/admission/doors'
import { dialTestSocket, handshake } from './helpers/socket-handshake'
import { SOCKET_CONNECT_TIMEOUT_MS, WsTransport, type ConnectionStatus, type GrantSource } from '@solus/client-core/ws-transport'
import { withBrowserCapabilities } from '@solus/client-core/ws-browser-api'
import { UNREACHABLE_AFTER_MS } from '@solus/client-core/host-readiness'
import { HostSupervisor } from '@solus/client-core/host-supervisor'
import type { SolusAPI } from '../../src/preload'
import type { IpcContext } from '@solus/contracts/types'
import { MAX_VOICE_SAMPLES } from '@solus/contracts/voice-audio'
import { readWav } from '@solus/server/transcription/wav'
import { HOST_SOCKET_CLOSE, HOST_SOCKET_PING_INTERVAL_MS, HOST_SOCKET_PING_TIMEOUT_MS, HOST_SOCKET_PROTOCOL_VERSION, serverFrameSchema, splitTextFrame, TEXT_FRAME_PART_MARK, type ServerFrame } from '@solus/contracts/host-socket'
import { HostSocket } from '@solus/client-core/host-socket'
import { setWebSocketFactory } from '@solus/client-core/web-socket'

// bun has no node:sqlite; the server modules' import chain reaches the db even though
// these tests never open it, so everything that reaches it loads after the seam.
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { issueSessionToken, resetAuthStateForTests, revokeDevice, verifySessionToken } = await import('@solus/server/admission/auth')
const { pairedPrincipalFor } = await import('@solus/server/admission/doors')
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { BrowserFrameChannel } = await import('@solus/server/browser/browser-frame-channel')
const { HostEventPublisher } = await import('@solus/server/transport/events/host-event-publisher')
const { attachWebSocketTransport, isLoopbackAddress } = await import('@solus/server/transport/websocket')
const { PresenceManager } = await import('@solus/server/presence/presence-manager')
const { useHostUser } = await import('@solus/server/host/host-user')

interface Harness {
  server: InstanceType<typeof SolusServer>
  http: HttpServer
  url: string
  events: InstanceType<typeof HostEventPublisher>
  transport: ReturnType<typeof attachWebSocketTransport>
  browserFrames: InstanceType<typeof BrowserFrameChannel>
}

const cleanups: Array<() => void> = []
const spentGrants = new Set<string>()

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  spentGrants.clear()
  resetAuthStateForTests()
})

describe('host socket transport', () => {
  test('an Uplink connection streams video larger than the RPC limit', async () => {
    const harness = await createHarness(true)
    let receivedBytes = 0
    const upload = createServer(async (request, response) => {
      for await (const chunk of request) receivedBytes += chunk.length
      response.writeHead(204).end()
    })
    await new Promise<void>((resolve) => upload.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => { upload.close() })
    const address = upload.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    harness.server.register('attachUploadToken', async () => ({
      relativeUrl: `http://127.0.0.1:${address.port}/api/uploads/test-video`,
      hostPath: '/host/uploads/recording.mp4',
      expiresAt: Date.now() + 60_000,
    }))
    const client = createClient(harness.url, { acquire: async () => 'grant:video' })
    client.start()
    await waitForStatus(client, 'connected')
    const api = withBrowserCapabilities(client.buildSolusApi(), client) as SolusAPI
    const file = new File([new Uint8Array(11 * 1024 * 1024)], 'recording.mp4', { type: 'video/mp4' })
    const attachments = await api.uploadFiles([file], { session: { sessionId: 'session-1' } } as IpcContext)
    expect(attachments?.[0]?.hostPath).toBe('/host/uploads/recording.mp4')
    expect(receivedBytes).toBe(file.size)
  })

  test('cloud dictation sends compact WAV over the admitted socket and survives reconnect', async () => {
    const harness = await createHarness(true)
    let calls = 0
    let grants = 0
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const received = new Promise<void>((resolve) => { started = resolve })
    // More than the former 1 MB socket limit, with a partial base64 chunk.
    const samples = new Float32Array(600_001)
    samples[0] = -1
    samples[12_288] = 0.5
    samples[samples.length - 1] = 0.25
    harness.server.register('transcribeAudio', async ([audio, options]) => {
      expect(options).toEqual({ vocabulary: ['Solus', 'Café'] })
      calls++
      expect(typeof audio).toBe('string')
      if (typeof audio !== 'string') throw new Error('expected base64 WAV')
      expect(audio.length).toBe(Math.ceil((44 + samples.length * 2) / 3) * 4)
      const decoded = readWav(Buffer.from(audio, 'base64'))
      expect(decoded.length).toBe(samples.length)
      expect(decoded[0]).toBe(-1)
      expect(decoded[12_288]).toBeCloseTo(0.5, 4)
      expect(decoded[decoded.length - 1]).toBeCloseTo(0.25, 4)
      started()
      await gate
      return { error: null, transcript: 'Cloud dictation works.' }
    })
    const client = createClient(harness.url, {
      acquire: async () => `grant:${++grants}`,
    })
    client.start()
    await waitForStatus(client, 'connected')
    // SAFETY: buildSolusApi installs the declared RPC methods.
    const api = client.buildSolusApi() as SolusAPI
    const result = api.transcribeAudio(samples, { vocabulary: ['Solus', 'Café'] })
    try {
      // Also fails promptly if dictation returns the old cloud refusal.
      await Promise.race([received, result.then(() => { throw new Error('transcription ended before upload') })])
      closeClientEngine(client)
      await waitForStatus(client, 'reconnecting')
      await waitForStatus(client, 'connected')
    } finally {
      release()
    }
    expect(await result).toEqual({ error: null, transcript: 'Cloud dictation works.' })
    expect(calls).toBe(1)
    expect(grants).toBe(2)
  })

  test('cloud dictation rejects recordings over the duration limit before upload', async () => {
    const client = createClient('http://localhost:1', { acquire: async () => 'grant:1' })
    // SAFETY: buildSolusApi installs the declared RPC methods.
    const api = client.buildSolusApi() as SolusAPI
    const samples = new Float32Array(MAX_VOICE_SAMPLES + 1)
    expect(await api.transcribeAudio(samples)).toEqual({
      error: 'Voice recordings can be up to 60 minutes long.', transcript: null,
    })
  })

  test('closing a listener removes every connected person once, including clients with two sockets', async () => {
    // A host always has its own user from boot (plans/012 stage 1); presence names the owner by it.
    useHostUser({ localId: 'test-host' })
    cleanups.push(() => useHostUser(null))
    const presence = new PresenceManager()
    const disconnected: string[] = []
    const harness = await createHarness(false, '127.0.0.1', '127.0.0.1', {
      onClientConnected: ({ clientId }) => {
        presence.join(clientId, { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Test' }, 'Test')
      },
      onClientDisconnected: ({ clientId }) => {
        disconnected.push(clientId)
        presence.leave(clientId)
      },
    })
    for (const clientInstanceId of ['same_client_12345', 'same_client_12345', 'other_client_1234']) {
      expect((await dialTestSocket(harness.url, handshake(undefined, clientInstanceId), cleanups)).ok).toBe(true)
    }
    expect(harness.transport.sessions.size).toBe(3)
    expect((await presence.hostSnapshot()).participants).toHaveLength(2)
    const watchers = (await presence.hostSnapshot()).participants.map((person) => person.clientId)
    harness.transport.close()
    harness.transport.close()
    expect(disconnected).toHaveLength(2)
    expect(new Set(disconnected).size).toBe(2)
    expect((await presence.hostSnapshot()).participants).toEqual([])
    expect(presence.sessionSnapshot('session-1', watchers, null).participants).toEqual([])
  })

  test('does not negotiate frame compression for a loopback client', async () => {
    const harness = await createHarness(false)
    const client = createClient(harness.url)
    client.start()
    await waitForStatus(client, 'connected')

    expect(hasServerFrameCompression(harness)).toBe(false)
  })

  test('recognizes IPv4, mapped IPv4, and IPv6 loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.10')).toBe(false)
  })

  test('rejects a session token anywhere but the handshake credential', async () => {
    // WHY: a socket has one credential, in its handshake's `credential` field
    // (docs/plans/simplify-auth-and-sync.md §3 rule 4); any other field is no credential.
    const harness = await createHarness(true)
    const sessionToken = issueSessionToken('Legacy browser').token
    const legacy = { ...handshake(undefined, 'legacy_browser_1234'), token: sessionToken }
    const dialed = await dialTestSocket(harness.url, legacy, cleanups)
    expect(dialed.ok ? null : dialed.code).toBe('UNAUTHORIZED')
  })

  test('requeues an unanswered RPC across reconnect and runs its handler once', async () => {
    const harness = await createHarness(false)
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    harness.server.register('connectionsGetServerInfo', async () => {
      calls++
      await gate
      return { installationId: 'server-1' }
    })

    const client = createClient(harness.url)
    client.start()
    await waitForStatus(client, 'connected')
    const api = client.buildSolusApi() as Record<string, (...args: unknown[]) => Promise<unknown>>
    const response = api.connectionsGetServerInfo()
    await waitFor(() => calls === 1)

    closeClientEngine(client)
    await waitForStatus(client, 'reconnecting')
    await waitForStatus(client, 'connected')
    release()

    expect(await response).toEqual({ installationId: 'server-1' })
    expect(calls).toBe(1)
  })

  test('surfaces an RPC handler error instead of rejecting its ack envelope', async () => {
    const harness = await createHarness(false)
    harness.server.register('connectionsGetServerInfo', () => {
      throw new Error('snapshot read failed')
    })

    const client = createClient(harness.url)
    client.start()
    await waitForStatus(client, 'connected')
    // SAFETY: buildSolusApi installs every RPC method declared by SolusAPI.
    const api = client.buildSolusApi() as SolusAPI

    await expect(api.connectionsGetServerInfo()).rejects.toThrow('snapshot read failed')
  })

  test('hands back an uploaded attachment when the browser withholds crypto.randomUUID', async () => {
    // WHY: a phone reaches a LAN host over plain HTTP, an insecure context where
    // the browser hides `crypto.randomUUID`. The photo had already landed on the
    // host, so the client must still mint an id for the composer instead of
    // reporting the upload as failed.
    const harness = await createHarness(false)
    harness.server.register('attachUpload', async (args) => `/host/uploads/${args[1].name}`)
    const client = createClient(harness.url)
    client.start()
    await waitForStatus(client, 'connected')
    // SAFETY: buildSolusApi installs every RPC method declared by SolusAPI; the browser layer adds uploads.
    const api = withBrowserCapabilities(client.buildSolusApi(), client) as SolusAPI

    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true })
    Object.defineProperty(globalThis, 'FileReader', { value: DataUrlFileReader, configurable: true })
    cleanups.push(() => {
      Reflect.deleteProperty(globalThis.crypto, 'randomUUID')
      Reflect.deleteProperty(globalThis, 'FileReader')
    })

    const photo = new File([Buffer.from('jpeg-bytes')], 'IMG_3090.jpeg', { type: 'image/jpeg' })
    const attachments = await api.uploadFiles([photo], { session: { sessionId: 'session-1' } } as IpcContext)

    expect(attachments).toHaveLength(1)
    expect(attachments?.[0]).toMatchObject({
      type: 'image',
      name: 'IMG_3090.jpeg',
      hostPath: '/host/uploads/IMG_3090.jpeg',
      mimeType: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`,
    })
    expect(attachments?.[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('sends a video as a file with its video type when the host cannot take a stream', async () => {
    // WHY: an older host has no upload URL. A small video must still attach
    // through the RPC it always had, as a file the agent opens by path, never
    // as an image, even when the picker reported no type for it.
    const harness = await createHarness(false)
    const received: Array<{ name: string; mime: string; dataUrl: string }> = []
    harness.server.register('attachUpload', async (args) => {
      received.push(args[1])
      return `/host/uploads/${args[1].name}`
    })
    const client = createClient(harness.url)
    client.start()
    await waitForStatus(client, 'connected')
    // SAFETY: buildSolusApi installs every RPC method declared by SolusAPI; the browser layer adds uploads.
    const api = withBrowserCapabilities(client.buildSolusApi(), client) as SolusAPI
    Object.defineProperty(globalThis, 'FileReader', { value: DataUrlFileReader, configurable: true })
    cleanups.push(() => { Reflect.deleteProperty(globalThis, 'FileReader') })

    const clip = new File([Buffer.from('mov-bytes')], 'bug.mov', { type: '' })
    const attachments = await api.uploadFiles([clip], { session: { sessionId: 'session-1' } } as IpcContext)

    expect(received.map((request) => request.mime)).toEqual(['video/quicktime'])
    expect(received[0].dataUrl.startsWith('data:video/quicktime;base64,')).toBe(true)
    expect(attachments?.[0]).toMatchObject({ type: 'file', mimeType: 'video/quicktime', hostPath: '/host/uploads/bug.mov' })
    expect(attachments?.[0].dataUrl).toBeUndefined()
  })

  test('admits a mounted-tab startup burst above the old receipt limit', async () => {
    // WHY: restoring many mounted tabs can issue more than 64 reads in one tick.
    // The task snapshot or another routine read must not fail according to its
    // position in that routine burst.
    const harness = await createHarness(false)
    const requestCount = 96
    let calls = 0
    let active = 0
    let maximumActive = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    harness.server.register('connectionsGetServerInfo', async () => {
      calls++
      active++
      maximumActive = Math.max(maximumActive, active)
      await gate
      active--
      return { installationId: 'server-1' }
    })

    const client = createClient(harness.url)
    client.start()
    await waitForStatus(client, 'connected')
    const api = client.buildSolusApi() as SolusAPI
    const requests = Array.from(
      { length: requestCount },
      () => api.connectionsGetServerInfo(),
    )

    await waitFor(() => calls === requestCount)
    expect(maximumActive).toBe(requestCount)
    release()

    await expect(Promise.all(requests)).resolves.toHaveLength(requestCount)
  })

  test('refreshes once after auth rejection, then blocks if that token is revoked', async () => {
    const harness = await createHarness(true)
    const refreshedToken = issueSessionToken('Test browser').token
    let refreshes = 0
    let authFailures = 0
    const statuses: ConnectionStatus[] = []
    const client = createClient(harness.url, {
      sessionToken: 'expired',
      refreshToken: async () => {
        refreshes++
        return { result: 'refreshed', sessionToken: refreshedToken }
      },
      onAuthFailed: () => { authFailures++ },
      onStatusChange: (status) => statuses.push(status),
    })

    client.start()
    await waitForStatus(client, 'connected')
    expect(refreshes).toBe(1)

    const session = verifySessionToken(refreshedToken)
    expect(session).not.toBeNull()
    revokeDevice(session!.deviceId)
    closeClientEngine(client, true)
    await waitFor(() => statuses.at(-1) === 'blocked')

    expect(refreshes).toBe(1)
    expect(authFailures).toBe(1)
  })

  test('a refresh the host does not answer retries instead of blocking the host', async () => {
    // WHY: a network error or 5xx during the refresh says nothing about the token. Before
    // T3 Code #16554's fix in Solus, one such blip blocked the host until the person retried.
    const harness = await createHarness(true)
    const refreshedToken = issueSessionToken('Test browser').token
    let refreshes = 0
    let authFailures = 0
    const statuses: ConnectionStatus[] = []
    const client = createClient(harness.url, {
      sessionToken: 'expired',
      refreshToken: async () => {
        refreshes++
        return refreshes === 1 ? { result: 'unavailable' } : { result: 'refreshed', sessionToken: refreshedToken }
      },
      onAuthFailed: () => { authFailures++ },
      onStatusChange: (status) => statuses.push(status),
    })

    client.start()
    await waitForStatus(client, 'connected')
    expect(refreshes).toBe(2)
    expect(authFailures).toBe(0)
    expect(statuses).not.toContain('blocked')
  })

  test('an Uplink client asks its grant source on every dial', async () => {
    // WHY: the source decides whether a kept grant still serves; the transport never
    // holds one past the dial, so a refused or expired grant is never presented twice.
    const harness = await createHarness(true)
    const minted: string[] = []
    let authFailures = 0
    const client = createClient(harness.url, {
      sessionToken: '',
      acquire: async () => {
        const grant = `grant:${minted.length + 1}`
        minted.push(grant)
        return grant
      },
      onAuthFailed: () => { authFailures++ },
    })

    client.start()
    await waitForStatus(client, 'connected')
    expect(minted).toEqual(['grant:1'])

    closeClientEngine(client, true)
    await waitForStatus(client, 'reconnecting')
    await waitForStatus(client, 'connected')
    expect(minted).toEqual(['grant:1', 'grant:2'])
    expect(authFailures).toBe(0)
  })

  test('a dial checks the host identity beside the credential exchange, not after the socket opens', async () => {
    // WHY: through a tunnel every step is a relay round trip. Checking identity only
    // once the socket was open put one more of them before the first RPC.
    const harness = await createHarness(true)
    let identityCheckStarted!: () => void
    const identityChecking = new Promise<void>((resolve) => { identityCheckStarted = resolve })
    const client = createClient(harness.url, {
      acquire: async () => {
        await identityChecking
        return 'grant:overlap'
      },
      verifyConnectedHost: async () => {
        identityCheckStarted()
        return true
      },
    })

    client.start()
    await waitForStatus(client, 'connected')
  })

  test('a dial on a route that does not answer fails at the socket\'s short connect timeout', async () => {
    // WHY: a host's LAN route seen from another network drops packets. A TCP connect can
    // wait far longer to call that a failure; the next dial's route choice needs the answer sooner.
    const silent = createNetServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => { silent.close() })
    const address = silent.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    const client = createClient(`http://127.0.0.1:${address.port}`, { sessionToken: 'paired-token' })
    const outcomes: string[] = []
    client.attachDialOutcomeReporter((outcome) => outcomes.push(outcome.kind))

    client.start()
    await waitFor(() => outcomes.length > 0, SOCKET_CONNECT_TIMEOUT_MS + 2_000)
    expect(outcomes).toEqual(['dial-failed'])
  }, SOCKET_CONNECT_TIMEOUT_MS + 5_000)

  test('a grant-admitted socket ends when its grant expires', async () => {
    // WHY: a socket lives no longer than its grant — revocation is grant expiry plus
    // a re-dial the revoked device cannot complete. Nothing else ends the socket.
    const harness = await createHarness(true)
    const dialed = await dialTestSocket(harness.url, handshake({ kind: 'access-token', token: 'grant:short-lived' }), cleanups)
    if (!dialed.ok) throw new Error(dialed.message)
    const codes: number[] = []
    dialed.socket.onClose((close) => codes.push(close.code))
    await waitFor(() => codes.length === 1)
    expect(codes).toEqual([HOST_SOCKET_CLOSE.ended])
  })

  test('replays the events a dropped socket missed without a reset, and resets when the host has no stream to resume', async () => {
    // WHY: a reset makes every surface reload; a short drop must not cost that.
    const harness = await createHarness(false)
    const client = createClient(harness.url)
    const taskEvents: unknown[] = []
    let resets = 0
    client.events.subscribe('tasks.invalidated', (payload) => taskEvents.push(payload))
    client.onReset(() => { resets++ })

    client.start()
    await waitForStatus(client, 'connected')
    closeClientEngine(client)
    await waitForStatus(client, 'reconnecting')
    harness.events.broadcast('tasks.invalidated', {})
    await waitForStatus(client, 'connected')
    await waitFor(() => taskEvents.length === 1)

    expect(taskEvents).toEqual([{}])
    expect(resets).toBe(0)

    closeClientEngine(client, true)
    await waitForStatus(client, 'reconnecting')
    await waitForStatus(client, 'connected')
    expect(resets).toBe(1)
  })

  test('a late wake probe keeps a socket that still receives data, and drops a silent one', async () => {
    // WHY: a busy host answers the probe late but keeps streaming. Hanging up on it
    // cut a working session and forced a full reconnect (T3 Code #14518).
    const harness = await createHarness(false)
    let releaseProbe = () => {}
    // SAFETY: the probe reads only that an answer came, never its fields.
    harness.server.register('connectionsGetServerInfo', () => new Promise((resolve) => {
      releaseProbe = () => resolve({ installationId: 'busy' } as never)
    }))
    const client = createClient(harness.url)
    client.start()
    await waitForStatus(client, 'connected')

    const stream = setInterval(() => harness.events.broadcast('tasks.invalidated', {}), 200)
    try {
      await client.probe()
    } finally {
      clearInterval(stream)
      releaseProbe()
    }
    expect((client as unknown as { status: ConnectionStatus }).status).toBe('connected')

    // Let the first probe's late answer arrive, so it is not traffic during the next one.
    await new Promise((resolve) => setTimeout(resolve, 200))
    // The same late answer with nothing else arriving: the socket is dead.
    await expect(client.probe()).rejects.toThrow('timeout')
    releaseProbe()
  }, 15_000)

  test('delivers targeted events only to sockets in the owning client room', async () => {
    const harness = await createHarness(false)
    const first = createClient(harness.url)
    const second = createClient(harness.url)
    const firstEvents: unknown[] = []
    const secondEvents: unknown[] = []
    first.events.subscribe('session.eventReceived', (payload) => firstEvents.push(payload))
    second.events.subscribe('session.eventReceived', (payload) => secondEvents.push(payload))

    first.start()
    second.start()
    await Promise.all([waitForStatus(first, 'connected'), waitForStatus(second, 'connected')])
    const clientId = `ws:local:${getClientInstanceId(first)}`
    expect(await harness.events.publish(clientId, 'session.eventReceived', {
      sessionId: 'session-1',
      event: { type: 'assistant_message', text: 'hello' },
    })).toBe(1)
    await waitFor(() => firstEvents.length === 1)

    expect(firstEvents).toEqual([{ sessionId: 'session-1', event: { type: 'assistant_message', text: 'hello' } }])
    expect(secondEvents).toEqual([])
  })
})

describe('the host socket protocol', () => {
  test('a socket is ready one round trip after it opens: the hello, then the welcome, with no other step', async () => {
    // WHY: through a tunnel every round trip before the first RPC is a delay the person sees.
    const harness = await createHarness(true)
    harness.server.register('connectionsGetServerInfo', async () => ({ installationId: 'server-1' }))
    const { socket, frames } = await rawSocket(harness.url)
    socket.send(JSON.stringify({ t: 'hello', v: HOST_SOCKET_PROTOCOL_VERSION, credential: { kind: 'access-token', token: 'grant:ready' } }))
    await waitFor(() => frames.length === 1)
    expect(frames[0]).toMatchObject({ t: 'welcome', recovered: false })

    // The first RPC needs nothing more than the welcome.
    socket.send(JSON.stringify({ t: 'rpc', id: '1', method: 'connectionsGetServerInfo', args: [] }))
    await waitFor(() => frames.length === 2)
    expect(frames[1]).toEqual({ t: 'result', id: '1', result: { installationId: 'server-1' } })
  })

  test('a refused credential gets a refused frame with its code, then the host closes the socket', async () => {
    const harness = await createHarness(true)
    const { socket, frames, closed } = await rawSocket(harness.url)
    socket.send(JSON.stringify({ t: 'hello', v: HOST_SOCKET_PROTOCOL_VERSION, credential: { kind: 'session-token', token: 'forged.token' } }))
    expect(await closed).toBe(HOST_SOCKET_CLOSE.refused)
    expect(frames).toEqual([{ t: 'refused', code: 'UNAUTHORIZED', message: 'unauthorized' }])
    expect(harness.transport.sessions.size).toBe(0)
  })

  test('a frame before the hello is refused, and the RPC in it never runs', async () => {
    // WHY: admission is the hello; a request that comes first has no principal to run as.
    const harness = await createHarness(false)
    let calls = 0
    harness.server.register('connectionsGetServerInfo', async () => { calls++; return { installationId: 'server-1' } })
    const { socket, frames, closed } = await rawSocket(harness.url)
    socket.send(JSON.stringify({ t: 'rpc', id: '1', method: 'connectionsGetServerInfo', args: [] }))
    expect(await closed).toBe(HOST_SOCKET_CLOSE.refused)
    expect(frames).toEqual([{ t: 'refused', code: 'PROTOCOL', message: 'hello first' }])
    expect(calls).toBe(0)
  })

  test('a hello for another protocol is refused', async () => {
    const harness = await createHarness(false)
    const { socket, frames, closed } = await rawSocket(harness.url)
    socket.send(JSON.stringify({ t: 'hello', v: HOST_SOCKET_PROTOCOL_VERSION + 1 }))
    expect(await closed).toBe(HOST_SOCKET_CLOSE.refused)
    expect(frames).toEqual([{ t: 'refused', code: 'PROTOCOL', message: 'unsupported protocol' }])
  })

  test('a socket opened before the credential is ready is admitted when the late hello comes', async () => {
    // WHY: the socket opens while the client signs in, so the open costs no time after the token arrives.
    const harness = await createHarness(true)
    let upgrades = 0
    harness.http.on('upgrade', () => { upgrades++ })
    let release!: () => void
    const tokenReady = new Promise<void>((resolve) => { release = resolve })
    const client = createClient(harness.url, { acquire: async () => { await tokenReady; return 'grant:late' } })
    client.start()
    await waitFor(() => upgrades === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(harness.transport.sessions.size).toBe(0)
    release()
    await waitForStatus(client, 'connected')
    expect(upgrades).toBe(1)
  })

  test('a client the host dropped dials again and calls go through on the new socket', async () => {
    const harness = await createHarness(false)
    harness.server.register('connectionsGetServerInfo', async () => ({ installationId: 'server-1' }))
    const statuses: ConnectionStatus[] = []
    const client = createClient(harness.url, { onStatusChange: (status) => statuses.push(status) })
    client.start()
    await waitForStatus(client, 'connected')
    const firstSession = [...harness.transport.sessions.keys()][0]
    expect(harness.transport.disconnectWhere(() => true, 'test drop')).toBe(1)
    await waitFor(() => statuses.at(-1) === 'connected' && statuses.includes('reconnecting'))
    // SAFETY: buildSolusApi installs every RPC method declared by SolusAPI.
    const api = client.buildSolusApi() as SolusAPI
    expect(await api.connectionsGetServerInfo()).toEqual({ installationId: 'server-1' })
    expect([...harness.transport.sessions.keys()]).not.toContain(firstSession)
    expect(statuses).toEqual(['connecting', 'connected', 'reconnecting', 'connected'])
  })

  test('a browser frame arrives as one binary frame with its header', async () => {
    const harness = await createHarness(false)
    const client = createClient(harness.url)
    const received: Array<{ seq: number; bytes: number[] }> = []
    client.frames.subscribe('page-1', (header, data) => received.push({ seq: header.seq, bytes: [...new Uint8Array(data)] }))
    client.start()
    await waitForStatus(client, 'connected')
    harness.browserFrames.publish([`ws:local:${getClientInstanceId(client)}`], { browserPageId: 'page-1', seq: 4 }, new Uint8Array([255, 216, 1, 2]))
    await waitFor(() => received.length === 1)
    expect(received).toEqual([{ seq: 4, bytes: [255, 216, 1, 2] }])
  })
})

describe('large text frames', () => {
  const emoji = '😀'
  const largeAnswer = { installationId: `é€${emoji}x`.repeat(40_000) }

  test('a frame comes apart on any boundary and joins to the same text, within the part size', () => {
    // WHY: half a surrogate pair turns into a replacement character on the wire.
    for (const lead of ['', 'a']) {
      const frame = lead + emoji.repeat(50_000)
      const parts = splitTextFrame(frame)
      expect(parts.length).toBeGreaterThan(1)
      expect(parts.slice(0, -1).every((part) => part.startsWith(TEXT_FRAME_PART_MARK))).toBe(true)
      expect(parts.at(-1)?.startsWith(TEXT_FRAME_PART_MARK)).toBe(false)
      expect(parts.every((part) => Buffer.byteLength(part) <= 48 * 1024 + 1)).toBe(true)
      expect(parts.map((part) => part.replace(TEXT_FRAME_PART_MARK, '')).join('')).toBe(frame)
    }
    expect(splitTextFrame('{"t":"ping"}')).toEqual(['{"t":"ping"}'])
  })

  test('a client that joins parts gets a large answer in parts, and an older client gets it whole', async () => {
    // WHY: a client from before parts would drop every part as unreadable.
    const harness = await createHarness(false)
    harness.server.register('connectionsGetServerInfo', async () => largeAnswer)
    const whole = await messagesAfterRpc(harness.url, {})
    expect(whole).toHaveLength(1)
    const parted = await messagesAfterRpc(harness.url, { frameParts: true })
    expect(parted.length).toBeGreaterThan(1)
    expect(JSON.parse(parted.map((part) => part.replace(TEXT_FRAME_PART_MARK, '')).join(''))).toEqual({ t: 'result', id: '1', result: largeAnswer })
  })

  test('a client reads a large answer as one result', async () => {
    const harness = await createHarness(false)
    harness.server.register('connectionsGetServerInfo', async () => largeAnswer)
    const client = createClient(harness.url)
    client.start()
    await waitForStatus(client, 'connected')
    const api = client.buildSolusApi() as unknown as { connectionsGetServerInfo(): Promise<typeof largeAnswer> }
    expect(await api.connectionsGetServerInfo()).toEqual(largeAnswer)
  })

  test('parts that take longer than the ping timeout keep both sides of the socket alive', () => {
    // WHY: the ping waits behind a large frame on the same socket. At 4,000 bytes/s a
    // config of a few hundred KiB outlasts the timeout, and the socket redials for the
    // same frame in a loop.
    const timers = new Map<number, { at: number; run: () => void }>()
    let now = 0
    let nextTimer = 1
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const sent: string[] = []
    const listeners = new Map<string, (event?: { data: string }) => void>()
    setWebSocketFactory(() => ({
      readyState: 1,
      send: (frame: string | Uint8Array) => { sent.push(String(frame)) },
      close: () => {},
      addEventListener: (type: string, listener: (event?: { data: string }) => void) => { listeners.set(type, listener) },
    }))
    globalThis.setTimeout = ((run: () => void, delay: number) => {
      timers.set(nextTimer, { at: now + delay, run })
      return nextTimer++
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as unknown as typeof clearTimeout
    try {
      const closes: number[] = []
      const results: string[] = []
      new HostSocket('http://host.test', {
        welcome: () => {},
        refused: () => {},
        closed: (close) => closes.push(close.code),
        result: (result) => results.push(result.id),
      })
      listeners.get('open')?.()
      const parts = splitTextFrame(JSON.stringify({ t: 'result', id: '1', result: largeAnswer }))
      const stepMs = (HOST_SOCKET_PING_INTERVAL_MS + HOST_SOCKET_PING_TIMEOUT_MS) / 2
      expect(parts.length * stepMs).toBeGreaterThan(HOST_SOCKET_PING_INTERVAL_MS + HOST_SOCKET_PING_TIMEOUT_MS)
      for (const part of parts) {
        now += stepMs
        for (const [id, timer] of [...timers]) {
          if (timer.at > now) continue
          timers.delete(id)
          timer.run()
        }
        listeners.get('message')?.({ data: part })
      }
      expect(closes).toEqual([])
      expect(results).toEqual(['1'])
      // One pong per part: the host's silence clock reads these.
      expect(sent.filter((frame) => frame === '{"t":"pong"}')).toHaveLength(parts.length)
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      setWebSocketFactory(null)
    }
  })
})

/** The text messages that answer one RPC on a raw socket admitted with these hello fields. */
async function messagesAfterRpc(url: string, hello: { frameParts?: true }): Promise<string[]> {
  const socket = new RawSocket(`${url.replace('http', 'ws')}/ws`)
  cleanups.push(() => socket.terminate())
  const messages: string[] = []
  socket.on('message', (data) => messages.push(data.toString()))
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
  socket.send(JSON.stringify({ t: 'hello', v: HOST_SOCKET_PROTOCOL_VERSION, ...hello }))
  await waitFor(() => messages.length === 1)
  messages.length = 0
  socket.send(JSON.stringify({ t: 'rpc', id: '1', method: 'connectionsGetServerInfo', args: [] }))
  await waitFor(() => messages.length > 0 && !messages.at(-1)?.startsWith(TEXT_FRAME_PART_MARK))
  return messages
}

async function createHarness(requireAuth: boolean, bindHost = '127.0.0.1', urlHost = bindHost, lifecycle: Pick<Parameters<typeof attachWebSocketTransport>[2], 'onClientConnected' | 'onClientDisconnected'> = {}): Promise<Harness> {
  const http = createServer((_request, response) => {
    response.statusCode = 404
    response.end()
  })
  const server = new SolusServer()
  const clientEvents = new ClientEventRegistry()
  const events = new HostEventPublisher(clientEvents)
  const browserFrames = new BrowserFrameChannel()
  const transport = attachWebSocketTransport(http, server, {
    clientEvents,
    browserFrames,
    requireAuth,
    doors: testDoors,
    ...lifecycle,
  })
  await new Promise<void>((resolve) => http.listen(0, bindHost, resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  const harness = { server, http, events, transport, browserFrames, url: `http://${urlHost}:${address.port}` }
  cleanups.push(() => transport.close())
  return harness
}

/**
 * The harness host's doors. A paired device's session token is real. `grant:<n>` stands
 * for a verified access token; this host takes each one once, as a host linked again
 * since refuses a client's kept token. `grant:short-lived` ends in 200 ms.
 */
const testDoors: Doors = {
  admitCredential: async (credential) => {
    if (credential.kind === 'session-token') return pairedPrincipalFor(credential.token)
    if (credential.kind !== 'access-token' || !credential.token.startsWith('grant:') || spentGrants.has(credential.token)) return { ok: false, reason: 'token-refused' }
    spentGrants.add(credential.token)
    const expiresAt = Date.now() + (credential.token === 'grant:short-lived' ? 200 : 600_000)
    return { ok: true, principal: { kind: 'owner', via: 'grant', userId: 'user_1', deviceId: 'session_1', expiresAt, deviceLabel: 'Solus cloud' } }
  },
  admitBearer: async () => ({ ok: false, reason: 'not-accepted' }),
}

/** Bun has no FileReader; this is the one browser call `uploadFiles` makes. */
class DataUrlFileReader {
  result: string | null = null
  error: Error | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  readAsDataURL(file: File): void {
    void file.arrayBuffer().then((bytes) => {
      this.result = `data:${file.type};base64,${Buffer.from(bytes).toString('base64')}`
      this.onload?.()
    })
  }
}

/** A client; `acquire` makes it a host reached with grants, from a signed-in account. */
function createClient(url: string, { acquire, ...overrides }: Partial<ConstructorParameters<typeof WsTransport>[0]> & { acquire?: GrantSource['acquire'] } = {}): WsTransport {
  const client = new WsTransport({ serverUrl: url, sessionToken: '', grants: acquire ? { acquire, isSignedOut: () => false } : undefined, ...overrides })
  // The supervisor is the sole retry owner (dispatch-client step 3): the
  // harness attaches a fast-ladder one so a drop redials the SAME socket —
  // which is exactly what keeps connection-state recovery working.
  const supervisor = new HostSupervisor({
    transport: client,
    // The ladder runs fast; the 12 s readiness grace keeps its length, so a short
    // drop in a test is a reconnect and not an unreachable host.
    setTimeoutFn: ((handler: () => void, delay: number) => setTimeout(handler, delay >= UNREACHABLE_AFTER_MS ? delay : 10)) as typeof setTimeout,
  })
  client.attachDialOutcomeReporter((outcome) => supervisor.report(outcome))
  cleanups.push(() => supervisor.destroy())
  cleanups.push(() => client.destroy())
  return client
}

/** Drops the client's socket as a network does: the WebSocket closes under the transport. */
function closeClientEngine(client: WsTransport, discardRecovery = false): void {
  const transport = client as unknown as { socket: HostSocket | null; resume: object | null }
  const socket = transport.socket as unknown as { ws: WebSocket } | null
  socket?.ws.close()
  if (discardRecovery) transport.resume = null
}

function getClientInstanceId(client: WsTransport): string {
  return (client as unknown as { clientInstanceId: string }).clientInstanceId
}

function hasServerFrameCompression(harness: Harness): boolean {
  const session = [...harness.transport.sessions.values()][0]
  // `ws` names the negotiated extensions as a header string; Bun's `ws` as an object.
  const extensions: unknown = session.socket.extensions
  return typeof extensions === 'string' ? extensions.includes('permessage-deflate') : Object.keys(extensions ?? {}).includes('permessage-deflate')
}

/** A socket with no client logic: what it sends and what the host answers, frame by frame. */
async function rawSocket(url: string): Promise<{ socket: RawSocket; frames: ServerFrame[]; closed: Promise<number> }> {
  const socket = new RawSocket(`${url.replace('http', 'ws')}/ws`)
  cleanups.push(() => socket.terminate())
  const frames: ServerFrame[] = []
  socket.on('message', (data) => {
    const frame = serverFrameSchema.safeParse(JSON.parse(data.toString()))
    if (frame.success) frames.push(frame.data)
  })
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)))
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
  return { socket, frames, closed }
}


function waitForStatus(client: WsTransport, expected: ConnectionStatus): Promise<void> {
  return waitFor(() => (client as unknown as { status: ConnectionStatus }).status === expected)
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
