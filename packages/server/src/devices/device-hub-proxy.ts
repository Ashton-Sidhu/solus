import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { z } from 'zod'
import { DEVICE_PLATFORMS, type DevicePlatform } from '@solus/contracts/device-types'
import { getAssetSigningSecret, readSignedToken, signToken } from '../admission/signed-token'
import { createLogger } from '../logger'
import type { DeviceControlTarget } from './device-control'

const log = createLogger('devices', 'device-hub-proxy.ts')

/**
 * The signed pass-through proxy between a client and the device hub
 * (docs/plans/native-devices.md, D2). Adapted from T3 Code's
 * `apps/server/src/device/DeviceHubProxy.ts` (MIT, pingdotgg/t3code).
 *
 * A token names one device and one client; it opens only that device's video
 * and socket, so the hub's exec and action routes stay unreachable. Bytes pass
 * through unchanged. Client to hub, input passes only while that client holds
 * the control lease.
 */

export const DEVICE_HUB_PREFIX = '/api/device-hub/'
const TOKEN_TTL_MS = 60_000
/** Messages a client sends before the hub socket opens; more are dropped. */
const MAX_PENDING_MESSAGES = 64
/** serve-sim's hardware-keyboard setting: every viewer sends it when its socket opens. */
const IOS_MSG_HARDWARE_KEYBOARD = 0x0d

/** The proxy's own routes. The client never sees a hub path. */
export type DeviceHubRoute = 'video.avcc' | 'video.mjpeg' | 'socket'

const tokenSchema = z.object({
  purpose: z.literal('device-hub'),
  deviceHostId: z.string(),
  deviceId: z.string(),
  platform: z.enum(DEVICE_PLATFORMS),
  clientId: z.string(),
  expiresAt: z.number(),
}).strict()
type DeviceHubToken = z.infer<typeof tokenSchema>

/** serve-emu's keyframe request: a viewer needs it to start decoding. */
const keyframeRequestSchema = z.object({ type: z.literal('reset-video') })

export interface DeviceHubProxyDeps {
  /** The hub that serves this device now. Throws when it is not running. */
  hubOrigin: (target: DeviceControlTarget) => Promise<string>
  /** Whether this client holds the device's control lease now. */
  holdsControl: (target: DeviceControlTarget, clientId: string) => boolean
  secret?: () => Buffer
  now?: () => number
}

export class DeviceHubProxy {
  private readonly sockets = new Map<string, Set<WebSocket>>()
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  private readonly secret: () => Buffer
  private readonly now: () => number

  constructor(private readonly deps: DeviceHubProxyDeps) {
    this.secret = deps.secret ?? getAssetSigningSecret
    this.now = deps.now ?? Date.now
  }

  /** A path that opens one device's stream for one client. */
  mint(clientId: string, target: DeviceControlTarget, platform: DevicePlatform): string {
    const payload: DeviceHubToken = {
      purpose: 'device-hub',
      deviceHostId: target.deviceHostId,
      deviceId: target.deviceId,
      platform,
      clientId,
      expiresAt: this.now() + TOKEN_TTL_MS,
    }
    return `${DEVICE_HUB_PREFIX}${signToken(payload, this.secret())}`
  }

  private read(token: string): DeviceHubToken | null {
    const payload = readSignedToken(token, this.secret(), tokenSchema)
    return payload && payload.expiresAt > this.now() ? payload : null
  }

  /** The hub URL a route maps to, or null when the platform has no such route. */
  private upstreamPath(payload: DeviceHubToken, route: string): string | null {
    const device = encodeURIComponent(payload.deviceId)
    if (payload.platform === 'ios') {
      if (route === 'video.avcc') return `/vendor/serve-sim/helper/${device}/stream.avcc`
      if (route === 'video.mjpeg') return `/vendor/serve-sim/helper/${device}/stream.mjpeg`
      if (route === 'socket') return `/vendor/serve-sim/helper/ws?device=${device}`
      return null
    }
    // serve-emu carries video and input on one socket.
    return route === 'socket' ? `/vendor/serve-emu/ws?device=${device}&frame-meta=1` : null
  }

  /** Serve an HTTP route: a long-lived video body. */
  async serve(token: string, route: string, signal: AbortSignal): Promise<Response> {
    const payload = this.read(token)
    if (!payload) return new Response('This device link expired.', { status: 403 })
    const path = route === 'socket' ? null : this.upstreamPath(payload, route)
    if (!path) return new Response('Not found', { status: 404 })
    const origin = await this.deps.hubOrigin(payload).catch(() => null)
    if (!origin) return new Response('The device hub is not running.', { status: 503 })
    const upstream = await fetch(`${origin}${path}`, { signal }).catch(() => null)
    if (!upstream) return new Response('The device hub did not answer.', { status: 502 })
    // Long-lived video must not be buffered or compressed on the way.
    const headers = new Headers({ 'cache-control': 'no-store, no-transform' })
    const type = upstream.headers.get('content-type')
    if (type) headers.set('content-type', type)
    return new Response(upstream.body, { status: upstream.status, headers })
  }

  /** Take a WebSocket upgrade for the proxy's socket route. False when the path is not ours. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? '/', 'http://proxy')
    if (!url.pathname.startsWith(DEVICE_HUB_PREFIX)) return false
    const [token = '', route = ''] = url.pathname.slice(DEVICE_HUB_PREFIX.length).split('/')
    const payload = this.read(token)
    const path = payload && route === 'socket' ? this.upstreamPath(payload, route) : null
    if (!payload || !path) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return true
    }
    // Answer the upgrade at once; the hub socket opens behind it.
    this.server.handleUpgrade(request, socket, head, (client) => this.pipe(client, payload, path))
    return true
  }

  private pipe(client: WebSocket, payload: DeviceHubToken, path: string): void {
    const owned = this.sockets.get(payload.clientId) ?? new Set<WebSocket>()
    this.sockets.set(payload.clientId, owned)
    owned.add(client)
    const pending: { data: RawData; isBinary: boolean }[] = []
    let upstream: WebSocket | null = null
    const end = () => {
      owned.delete(client)
      if (owned.size === 0 && this.sockets.get(payload.clientId) === owned) this.sockets.delete(payload.clientId)
      client.close()
      upstream?.close()
    }
    client.on('message', (data, isBinary) => {
      if (!this.passes(payload, data, isBinary)) return
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
      else if (pending.length < MAX_PENDING_MESSAGES) pending.push({ data, isBinary })
    })
    client.on('close', end)
    client.on('error', end)
    void (async () => {
      let origin: string
      try {
        origin = await this.deps.hubOrigin(payload)
      } catch (error) {
        log.debug('device_hub_socket_unavailable', { deviceHostId: payload.deviceHostId, deviceId: payload.deviceId, error: error instanceof Error ? error.message : String(error) })
        end()
        return
      }
      if (client.readyState !== WebSocket.OPEN) return
      const hub = new WebSocket(`${origin.replace(/^http/, 'ws')}${path}`)
      upstream = hub
      hub.on('open', () => {
        for (const message of pending.splice(0)) hub.send(message.data, { binary: message.isBinary })
      })
      hub.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
      })
      hub.on('close', end)
      hub.on('error', end)
    })()
  }

  /** Input passes only for the control holder; a viewer may still ask for a keyframe and set the keyboard mode. */
  private passes(payload: DeviceHubToken, data: RawData, isBinary: boolean): boolean {
    if (this.deps.holdsControl(payload, payload.clientId)) return true
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (payload.platform === 'ios') return isBinary && bytes[0] === IOS_MSG_HARDWARE_KEYBOARD
    if (isBinary) return false
    try {
      return keyframeRequestSchema.safeParse(JSON.parse(bytes.toString('utf8'))).success
    } catch {
      return false
    }
  }

  /** A client's Solus connection expired: its proxied sockets close. */
  dropClient(clientId: string): void {
    for (const socket of this.sockets.get(clientId) ?? []) socket.close()
  }
}
