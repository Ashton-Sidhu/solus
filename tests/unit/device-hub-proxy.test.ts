import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { DeviceHubProxy } from '@solus/server/devices/device-hub-proxy'

/**
 * The host's hub proxy (docs/plans/native-devices.md, D2). A signed path
 * opens one device's stream for one client and nothing else on the hub, and a
 * viewer without the control lease cannot drive the device through it.
 */

const DEVICE = { deviceHostId: 'local', deviceId: 'emulator-5554' }
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}

async function setup() {
  // The fake hub: one video route, one socket that records what reaches it.
  const reached: { url: string; message: string }[] = []
  const hubServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/avcc' }).end(`video for ${req.url}`)
  })
  const hubSockets = new WebSocketServer({ server: hubServer })
  hubSockets.on('connection', (socket, request) => {
    socket.on('message', (data) => reached.push({ url: request.url ?? '', message: data.toString() }))
  })
  const hubOrigin = await listen(hubServer)

  let holder: string | null = null
  const clock = { now: 1_000 }
  const secret = randomBytes(32)
  const proxy = new DeviceHubProxy({
    hubOrigin: async () => hubOrigin,
    holdsControl: (_target, clientId) => clientId === holder,
    secret: () => secret,
    now: () => clock.now,
  })
  const front = createServer()
  front.on('upgrade', (request, socket, head) => {
    if (!proxy.handleUpgrade(request, socket, head)) socket.destroy()
  })
  const origin = await listen(front)
  const open = (path: string) => new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}${path}/socket`)
    socket.once('open', () => resolve(socket))
    socket.on('error', reject)
  })
  return { proxy, reached, clock, open, setHolder: (clientId: string | null) => { holder = clientId } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('device hub proxy', () => {
  test('a signed path opens only its own device video', async () => {
    const { proxy, clock } = await setup()
    const path = proxy.mint('client-a', { deviceHostId: 'local', deviceId: 'SIM 1' }, 'ios')
    const token = path.split('/').at(-1)!
    const video = await proxy.serve(token, 'video.avcc', new AbortController().signal)
    expect(await video.text()).toBe('video for /vendor/serve-sim/helper/SIM%201/stream.avcc')
    // The hub's other routes do not exist here.
    expect((await proxy.serve(token, 'exec', new AbortController().signal)).status).toBe(404)
    // A changed token or an expired one opens nothing.
    expect((await proxy.serve(`${token.slice(0, -2)}xx`, 'video.avcc', new AbortController().signal)).status).toBe(403)
    clock.now += 61_000
    expect((await proxy.serve(token, 'video.avcc', new AbortController().signal)).status).toBe(403)
  })

  test('a viewer cannot drive the device; the control holder can', async () => {
    // WHY: watching never takes control. A viewer still needs keyframes.
    const { proxy, reached, open, setHolder } = await setup()
    const socket = await open(proxy.mint('client-a', DEVICE, 'android'))
    socket.send(JSON.stringify({ type: 'touch', action: 'down', x: 0.5, y: 0.5 }))
    socket.send(JSON.stringify({ type: 'reset-video', ack: false }))
    await settle()
    expect(reached.map((entry) => JSON.parse(entry.message).type)).toEqual(['reset-video'])
    expect(reached[0]!.url).toBe('/vendor/serve-emu/ws?device=emulator-5554&frame-meta=1')
    setHolder('client-a')
    socket.send(JSON.stringify({ type: 'touch', action: 'down', x: 0.5, y: 0.5 }))
    await settle()
    expect(reached.map((entry) => JSON.parse(entry.message).type)).toEqual(['reset-video', 'touch'])
    socket.close()
  })

  test('an expired client loses its proxied sockets', async () => {
    const { proxy, open } = await setup()
    const socket = await open(proxy.mint('client-a', DEVICE, 'android'))
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    proxy.dropClient('client-a')
    await closed
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  })

  test('a socket with a bad token is refused before it opens', async () => {
    const { open } = await setup()
    await expect(open('/api/device-hub/not-a-token')).rejects.toThrow()
  })
})
