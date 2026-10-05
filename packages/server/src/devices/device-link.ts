import type {
  DeviceButton,
  DeviceFrameHeader,
  DeviceInput,
  DevicePlatform,
  DeviceScreenConfig,
} from '@solus/contracts/device-types'
import { createLogger } from '../logger'
import { DeviceDomainError } from './device-errors'
import type { DeviceFrameChannel } from './device-frame-channel'
import {
  AvccDemuxer,
  androidButtonName,
  androidInput,
  androidKeyMessage,
  avcCodecString,
  hidUsageForCode,
  iosButtonName,
  iosInput,
  iosRawPoint,
  isVideoSessionMessage,
  nextOrientation,
  parseIosHelperPacket,
  parseSemuPacket,
  scanAccessUnit,
} from './device-protocol'
import { MjpegSplitter, type DeviceUpstream, type UpstreamSocket } from './device-upstream'
import { iosTextKeys } from './device-text-keys'

const log = createLogger('devices', 'device-link.ts')

/** A client whose transport has this many unsent packets skips video until the next keyframe. */
export const SLOW_CLIENT_BUFFERED_PACKETS = 24
const GOP_MAX_BYTES = 4 * 1024 * 1024
const GOP_MAX_PACKETS = 300
const RETRY_DELAY_MS = 1_000
const SOCKET_OPEN_TIMEOUT_MS = 5_000
const KEYFRAME_REQUEST_INTERVAL_MS = 2_000

/** One message to the hub's input socket: tagged binary for iOS, JSON text for Android. */
type UpstreamMessage = string | Uint8Array

export interface DeviceLinkTarget {
  deviceHostId: string
  deviceId: string
  platform: DevicePlatform
  hubOrigin: string
}

export type DeviceVideoFormat = 'h264' | 'jpeg'

interface Packet {
  header: DeviceFrameHeader
  data: Uint8Array
}

interface Subscriber {
  format: DeviceVideoFormat
  awaitingKey: boolean
}

/** A host-side consumer (a recording). Receives every H.264 packet. */
export interface DeviceServerSink {
  onPacket(header: DeviceFrameHeader, data: Uint8Array): void
}

export interface DeviceLinkDeps {
  channel: DeviceFrameChannel
  upstream: DeviceUpstream
  /** Allocates stream generations; seeded from the clock so restarts never repeat one. */
  nextGeneration: () => number
  now?: () => number
  delay?: (ms: number) => Promise<void>
}

/**
 * One device's connection to the hub on the host. It reads video from the
 * hub once, however many clients and recorders watch, and forwards whole
 * packets: H.264 is never decoded or re-encoded here. It owns the input
 * socket too, so pointer coordinates are mapped against the screen the host
 * last saw. Protocol details follow T3 Code's stream client (MIT,
 * pingdotgg/t3code@43bd667, packages/client-runtime/src/device/stream.ts).
 */
export class DeviceLink {
  streamGeneration: number
  screen: DeviceScreenConfig | null = null
  screenGeneration = 0
  private seq = 0
  private closed = false
  private readonly subscribers = new Map<string, Subscriber>()
  private readonly sinks = new Set<DeviceServerSink>()
  private readonly heldPointers = new Map<string, { x: number; y: number }>()
  private config: Packet | null = null
  private gop: Packet[] = []
  private gopBytes = 0
  private lastJpeg: Packet | null = null
  private videoAbort: AbortController | null = null
  private jpegAbort: AbortController | null = null
  private socket: UpstreamSocket | null = null
  private socketOpen = false
  private socketWaiters: (() => void)[] = []
  private lastKeyframeRequest = Number.NEGATIVE_INFINITY
  private readonly now: () => number
  private readonly delay: (ms: number) => Promise<void>

  constructor(readonly target: DeviceLinkTarget, private readonly deps: DeviceLinkDeps) {
    this.streamGeneration = deps.nextGeneration()
    this.now = deps.now ?? Date.now
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private vendor(): string {
    return this.target.platform === 'ios' ? '/vendor/serve-sim' : '/vendor/serve-emu'
  }

  private url(path: string, protocol: 'http' | 'ws' = 'http'): string {
    const origin = protocol === 'ws' ? this.target.hubOrigin.replace(/^http/, 'ws') : this.target.hubOrigin
    return `${origin}${this.vendor()}${path}`
  }

  private get device(): string {
    return encodeURIComponent(this.target.deviceId)
  }

  /** Nothing watches, records or holds a pointer on this device. */
  isIdle(): boolean {
    return this.subscribers.size === 0 && this.sinks.size === 0 && this.heldPointers.size === 0
  }

  watchers(): string[] {
    return [...this.subscribers.keys()]
  }

  // ─── Subscriptions ───

  subscribe(clientId: string, format: DeviceVideoFormat): void {
    if (this.closed) throw new DeviceDomainError('request_failed', 'The device stream ended. Open the device again.')
    if (format === 'jpeg' && this.target.platform === 'android') {
      throw new DeviceDomainError('action_unsupported', 'Android streams need H.264 decoding (WebCodecs). This client cannot decode them.')
    }
    const subscriber: Subscriber = { format, awaitingKey: true }
    this.subscribers.set(clientId, subscriber)
    this.ensureControlSocket()
    if (format === 'jpeg') {
      this.ensureJpeg()
      if (this.lastJpeg) this.sendTo(clientId, subscriber, this.lastJpeg)
    } else {
      this.ensureVideo()
      // A joiner needs the decoder configuration and a decodable frame first,
      // never an arbitrary delta.
      if (this.config) this.sendTo(clientId, subscriber, this.config)
      for (const packet of this.gop) this.deps.channel.send(clientId, packet.header, packet.data)
      subscriber.awaitingKey = this.gop.length === 0
      if (subscriber.awaitingKey) this.requestKeyframe()
    }
    this.sendScreen(clientId)
  }

  unsubscribe(clientId: string): void {
    this.subscribers.delete(clientId)
    this.stopUnusedUpstreams()
  }

  addSink(sink: DeviceServerSink): void {
    this.sinks.add(sink)
    this.ensureControlSocket()
    this.ensureVideo()
    if (this.config) sink.onPacket(this.config.header, this.config.data)
    for (const packet of this.gop) sink.onPacket(packet.header, packet.data)
  }

  removeSink(sink: DeviceServerSink): void {
    this.sinks.delete(sink)
    this.stopUnusedUpstreams()
  }

  private wantsVideo(): boolean {
    return this.sinks.size > 0 || [...this.subscribers.values()].some((subscriber) => subscriber.format === 'h264')
  }

  private wantsJpeg(): boolean {
    return [...this.subscribers.values()].some((subscriber) => subscriber.format === 'jpeg')
  }

  private stopUnusedUpstreams(): void {
    if (!this.wantsVideo() && this.videoAbort) {
      this.videoAbort.abort()
      this.videoAbort = null
      this.config = null
      this.clearGop()
    }
    if (!this.wantsJpeg() && this.jpegAbort) {
      this.jpegAbort.abort()
      this.jpegAbort = null
      this.lastJpeg = null
    }
    // Android carries video on the input socket: close it only when idle.
    if (this.isIdle()) this.closeSocket()
  }

  /** End the link: every subscriber is told why and every upstream stops. */
  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const clientId of this.subscribers.keys()) {
      this.deps.channel.send(clientId, this.header('ended', { detail: reason }), new Uint8Array())
    }
    for (const sink of this.sinks) sink.onPacket(this.header('ended', { detail: reason }), new Uint8Array())
    this.subscribers.clear()
    this.sinks.clear()
    this.heldPointers.clear()
    this.videoAbort?.abort()
    this.jpegAbort?.abort()
    this.videoAbort = null
    this.jpegAbort = null
    this.closeSocket()
  }

  get isClosed(): boolean {
    return this.closed
  }

  // ─── Packets ───

  private header(kind: DeviceFrameHeader['kind'], extra: Partial<DeviceFrameHeader> = {}): DeviceFrameHeader {
    return {
      deviceHostId: this.target.deviceHostId,
      deviceId: this.target.deviceId,
      streamGeneration: this.streamGeneration,
      seq: ++this.seq,
      kind,
      ...extra,
    }
  }

  private sendTo(clientId: string, subscriber: Subscriber, packet: Packet): void {
    const { kind } = packet.header
    if (kind === 'screen' || kind === 'ended' || kind === 'config') {
      if (kind === 'config') subscriber.awaitingKey = true
      this.deps.channel.send(clientId, packet.header, packet.data)
      return
    }
    const congested = this.deps.channel.buffered(clientId) > SLOW_CLIENT_BUFFERED_PACKETS
    if (kind === 'jpeg') {
      // Latest image wins; a slow client simply skips frames.
      if (!congested) this.deps.channel.send(clientId, packet.header, packet.data)
      return
    }
    if (kind === 'key') {
      if (congested) return
      subscriber.awaitingKey = false
      this.deps.channel.send(clientId, packet.header, packet.data)
      return
    }
    if (subscriber.awaitingKey) return
    if (congested) {
      // Dropping one delta corrupts every later one; wait for a keyframe.
      subscriber.awaitingKey = true
      this.requestKeyframe()
      return
    }
    this.deps.channel.send(clientId, packet.header, packet.data)
  }

  private emit(packet: Packet): void {
    if (this.closed) return
    for (const [clientId, subscriber] of this.subscribers) {
      const wanted = packet.header.kind === 'jpeg' ? subscriber.format === 'jpeg' : subscriber.format === 'h264'
      if (wanted || packet.header.kind === 'screen') this.sendTo(clientId, subscriber, packet)
    }
    if (packet.header.kind !== 'jpeg') for (const sink of this.sinks) sink.onPacket(packet.header, packet.data)
  }

  private clearGop(): void {
    this.gop = []
    this.gopBytes = 0
  }

  private videoPacket(kind: 'key' | 'delta', data: Uint8Array, timestamp?: number | null): void {
    const packet = { header: this.header(kind, timestamp == null ? {} : { timestamp }), data }
    if (kind === 'key') {
      this.gop = [packet]
      this.gopBytes = data.byteLength
    } else if (this.gop.length > 0) {
      if (this.gop.length >= GOP_MAX_PACKETS || this.gopBytes + data.byteLength > GOP_MAX_BYTES) {
        // Too long a group to replay: joiners wait for the next keyframe.
        this.clearGop()
        this.requestKeyframe()
      } else {
        this.gop.push(packet)
        this.gopBytes += data.byteLength
      }
    }
    this.emit(packet)
  }

  private configPacket(codec: string, format: 'avcc' | 'annexb', data: Uint8Array): void {
    this.config = { header: this.header('config', { codec, format }), data }
    this.clearGop()
    this.emit(this.config)
  }

  private jpegPacket(data: Uint8Array): void {
    const packet = { header: this.header('jpeg'), data }
    this.lastJpeg = packet
    this.emit(packet)
  }

  private sendScreen(clientId?: string): void {
    const extra: Partial<DeviceFrameHeader> = { screenGeneration: this.screenGeneration }
    if (this.screen) extra.screen = { ...this.screen }
    const packet = { header: this.header('screen', extra), data: new Uint8Array() }
    if (clientId) this.deps.channel.send(clientId, packet.header, packet.data)
    else this.emit(packet)
  }

  private screenChanged(screen: DeviceScreenConfig | null): void {
    this.screen = screen
    this.screenGeneration++
    // Pointers held against the old screen cannot be mapped any more.
    this.heldPointers.clear()
    this.sendScreen()
  }

  private requestKeyframe(): void {
    if (this.target.platform !== 'android') return
    const now = this.now()
    if (now - this.lastKeyframeRequest < KEYFRAME_REQUEST_INTERVAL_MS) return
    this.lastKeyframeRequest = now
    this.socket?.send(androidInput.resetVideo())
  }

  // ─── Upstreams ───

  private ensureVideo(): void {
    if (this.target.platform === 'android') {
      this.ensureControlSocket()
      return
    }
    if (this.videoAbort) return
    const abort = new AbortController()
    this.videoAbort = abort
    void this.readIosVideo(abort)
  }

  private async readIosVideo(abort: AbortController): Promise<void> {
    while (!abort.signal.aborted && !this.closed) {
      const demuxer = new AvccDemuxer()
      try {
        await this.deps.upstream.readBody(this.url(`/helper/${this.device}/stream.avcc`), abort.signal, (chunk) => {
          for (const envelope of demuxer.push(chunk)) {
            if (envelope.type === 'description') this.configPacket(avcCodecString(envelope.payload), 'avcc', envelope.payload)
            else if (envelope.type === 'seed') this.jpegPacket(envelope.payload)
            else this.videoPacket(envelope.type === 'keyframe' ? 'key' : 'delta', envelope.payload)
          }
        })
      } catch (error) {
        if (abort.signal.aborted) return
        log.debug('device_video_read_failed', { deviceId: this.target.deviceId, error: error instanceof Error ? error.message : String(error) })
      }
      if (abort.signal.aborted || this.closed) return
      // The upstream restarted: everything decodable before it is gone.
      this.streamGeneration = this.deps.nextGeneration()
      this.config = null
      this.clearGop()
      await this.delay(RETRY_DELAY_MS)
    }
  }

  private ensureJpeg(): void {
    if (this.jpegAbort) return
    const abort = new AbortController()
    this.jpegAbort = abort
    void (async () => {
      while (!abort.signal.aborted && !this.closed) {
        const splitter = new MjpegSplitter()
        try {
          await this.deps.upstream.readBody(this.url(`/helper/${this.device}/stream.mjpeg`), abort.signal, (chunk) => {
            for (const image of splitter.push(chunk)) this.jpegPacket(image)
          })
        } catch {
          // Retried below while someone still watches.
        }
        if (abort.signal.aborted || this.closed) return
        await this.delay(RETRY_DELAY_MS)
      }
    })()
  }

  /**
   * serve-sim's helper accepts HID and pushes screen config only once capture
   * runs, and the AVCC stream does not reliably start it. One short MJPEG read
   * does.
   */
  private async primeIosCapture(): Promise<void> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 2_000)
    try {
      await this.deps.upstream.readBody(this.url(`/helper/${this.device}/stream.mjpeg`), abort.signal, () => abort.abort())
    } catch {
      // A failed prime only means the socket may need a retry.
    } finally {
      clearTimeout(timer)
    }
  }

  private ensureControlSocket(): void {
    if (this.socket || this.closed) return
    const url = this.target.platform === 'ios'
      ? this.url(`/helper/ws?device=${this.device}`, 'ws')
      : this.url(`/ws?device=${this.device}&frame-meta=1`, 'ws')
    const open = () => {
      const socket = this.deps.upstream.openSocket(url, {
        onOpen: () => {
          if (this.socket !== socket) return
          this.socketOpen = true
          if (this.target.platform === 'ios') socket.send(iosInput.hardwareKeyboard(false))
          for (const resolve of this.socketWaiters.splice(0)) resolve()
        },
        onMessage: (data) => {
          if (this.socket !== socket) return
          if (this.target.platform === 'ios') this.iosControlMessage(data)
          else this.androidMessage(data)
        },
        onClose: () => {
          if (this.socket !== socket) return
          this.socket = null
          this.socketOpen = false
          if (this.target.platform === 'android') {
            this.config = null
            this.clearGop()
            this.streamGeneration = this.deps.nextGeneration()
          }
          if (this.closed || this.isIdle()) return
          void this.delay(RETRY_DELAY_MS).then(() => this.ensureControlSocket())
        },
      })
      this.socket = socket
    }
    if (this.target.platform === 'ios') {
      // Claim the slot before the asynchronous prime so a second caller waits.
      this.socket = { send: () => {}, close: () => {} }
      void this.primeIosCapture().then(() => {
        this.socket = null
        if (!this.closed && !this.isIdle()) open()
      })
    } else {
      open()
    }
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    this.socketOpen = false
    socket?.close()
  }

  private iosControlMessage(data: Uint8Array | string): void {
    if (!(data instanceof Uint8Array)) return
    const screen = parseIosHelperPacket(data)
    if (!screen) return
    const previous = this.screen
    if (previous && previous.width === screen.width && previous.height === screen.height
      && previous.orientation === screen.orientation && previous.screenId === screen.screenId) return
    this.screenChanged(screen)
  }

  private androidMessage(data: Uint8Array | string): void {
    if (!(data instanceof Uint8Array)) {
      // The encoder restarts at a new size when the device rotates; the next
      // keyframe carries a fresh SPS.
      if (isVideoSessionMessage(data)) {
        this.config = null
        this.clearGop()
        this.screenChanged(null)
        this.lastKeyframeRequest = Number.NEGATIVE_INFINITY
        this.requestKeyframe()
      }
      return
    }
    const packet = parseSemuPacket(data)
    const scanned = packet.isKey === null || (packet.isKey && !this.config) ? scanAccessUnit(packet.data) : null
    const isKey = packet.isKey ?? scanned?.isKey ?? false
    if (scanned?.sps) {
      const codec = avcCodecString(scanned.sps)
      if (this.config?.header.codec !== codec) this.configPacket(codec, 'annexb', new Uint8Array())
    }
    if (!this.config) {
      if (!isKey) this.requestKeyframe()
      return
    }
    this.videoPacket(isKey ? 'key' : 'delta', packet.data, packet.timestamp)
  }

  // ─── Input ───

  private async openSocket(): Promise<UpstreamSocket> {
    this.ensureControlSocket()
    if (!this.socketOpen) {
      await Promise.race([
        new Promise<void>((resolve) => this.socketWaiters.push(resolve)),
        this.delay(SOCKET_OPEN_TIMEOUT_MS),
      ])
    }
    if (!this.socket || !this.socketOpen) {
      throw new DeviceDomainError('request_failed', 'Input cannot reach the device right now. Reconnecting.')
    }
    return this.socket
  }

  /**
   * Forward validated input. Pointer coordinates are normalized against the
   * screen of `screenGeneration`; input from an older screen is refused.
   * Consecutive moves collapse to the last one; down, up and cancel are kept.
   */
  async input(clientId: string, inputs: DeviceInput[], screenGeneration: number): Promise<void> {
    const pointerLike = inputs.some((input) => input.kind === 'pointer' || input.kind === 'scroll')
    if (pointerLike && screenGeneration !== this.screenGeneration) {
      // The final up still has to reach the device, or a touch stays held.
      if (this.heldPointers.has(clientId)) await this.cancelInput(clientId)
      // Tell the client the current screen, so its next touch is accepted.
      if (this.subscribers.has(clientId)) this.sendScreen(clientId)
      throw new DeviceDomainError('stale_generation', 'The device screen changed. Try again.')
    }
    const socket = await this.openSocket()
    for (const message of this.messagesFor(clientId, coalesce(inputs))) socket.send(message)
  }

  /** Release a held pointer when a client disconnects or loses control. */
  async cancelInput(clientId: string): Promise<void> {
    const held = this.heldPointers.get(clientId)
    if (!held) return
    this.heldPointers.delete(clientId)
    if (!this.socket || !this.socketOpen) return
    this.socket.send(this.target.platform === 'ios'
      ? iosInput.touch('end', ...this.iosPoint(held.x, held.y))
      : androidInput.touch('up', held.x, held.y))
  }

  private iosPoint(x: number, y: number): [number, number] {
    const point = iosRawPoint(this.screen, x, y)
    return [point.x, point.y]
  }

  private touch(phase: 'down' | 'move' | 'up', x: number, y: number): string | Uint8Array {
    if (this.target.platform === 'ios') {
      return iosInput.touch(phase === 'down' ? 'begin' : phase === 'move' ? 'move' : 'end', ...this.iosPoint(x, y))
    }
    return androidInput.touch(phase, x, y)
  }

  private messagesFor(clientId: string, inputs: DeviceInput[]): UpstreamMessage[] {
    return inputs.flatMap((input) => this.messagesForOne(clientId, input))
  }

  private messagesForOne(clientId: string, input: DeviceInput): UpstreamMessage[] {
    switch (input.kind) {
      case 'pointer': return this.pointerMessages(clientId, input)
      case 'scroll': return this.scrollMessages(input)
      case 'text': return this.textMessages(input.text)
      case 'key': return this.keyMessages(input)
      case 'button': return [this.buttonMessage(input.button)]
      case 'rotate':
        if (this.target.platform !== 'ios') throw new DeviceDomainError('action_unsupported', 'Rotate Android emulators with the orientation control in Tools.')
        return [iosInput.orientation(nextOrientation(this.screen?.orientation ?? 'portrait'))]
    }
  }

  /** Track the held pointer so a disconnect can release it. Moves and ups without a down are dropped. */
  private pointerMessages(clientId: string, input: Extract<DeviceInput, { kind: 'pointer' }>): UpstreamMessage[] {
    if (input.phase === 'down') {
      this.heldPointers.set(clientId, { x: input.x, y: input.y })
      return [this.touch('down', input.x, input.y)]
    }
    if (!this.heldPointers.has(clientId)) return []
    if (input.phase === 'move') {
      this.heldPointers.set(clientId, { x: input.x, y: input.y })
      return [this.touch('move', input.x, input.y)]
    }
    this.heldPointers.delete(clientId)
    return [this.touch('up', input.x, input.y)]
  }

  /** Neither helper has a wheel event: a scroll is a short drag the other way. */
  private scrollMessages(input: Extract<DeviceInput, { kind: 'scroll' }>): UpstreamMessage[] {
    const clamp = (value: number) => Math.min(1, Math.max(0, value))
    const endX = clamp(input.x - input.deltaX)
    const endY = clamp(input.y - input.deltaY)
    const out: UpstreamMessage[] = [this.touch('down', input.x, input.y)]
    for (let step = 1; step <= 4; step++) {
      out.push(this.touch('move', input.x + ((endX - input.x) * step) / 4, input.y + ((endY - input.y) * step) / 4))
    }
    out.push(this.touch('up', endX, endY))
    return out
  }

  private textMessages(text: string): UpstreamMessage[] {
    if (this.target.platform !== 'ios') return [androidInput.text(text)]
    return iosTextKeys(text).flatMap((key) => [
      ...(key.shift ? [iosInput.key('down', 0xe1)] : []),
      iosInput.key('down', key.usage),
      iosInput.key('up', key.usage),
      ...(key.shift ? [iosInput.key('up', 0xe1)] : []),
    ])
  }

  private keyMessages(input: Extract<DeviceInput, { kind: 'key' }>): UpstreamMessage[] {
    if (this.target.platform === 'ios') {
      const usage = hidUsageForCode(input.code)
      return usage === null ? [] : [iosInput.key(input.phase, usage)]
    }
    if (input.phase !== 'down') return []
    const message = androidKeyMessage(input.key, input.hasModifier === true)
    return message ? [message] : []
  }

  private buttonMessage(button: DeviceButton): UpstreamMessage {
    if (this.target.platform !== 'ios') return androidInput.button(androidButtonName(button))
    const name = iosButtonName(button)
    if (!name) throw new DeviceDomainError('action_unsupported', `iOS Simulators have no ${button} button.`)
    return iosInput.button(name)
  }
}

/** Collapse runs of pointer moves to the last one. Never drops down, up or cancel. */
export function coalesce(inputs: DeviceInput[]): DeviceInput[] {
  const out: DeviceInput[] = []
  for (const input of inputs) {
    const previous = out.at(-1)
    if (input.kind === 'pointer' && input.phase === 'move' && previous?.kind === 'pointer' && previous.phase === 'move') {
      out[out.length - 1] = input
    } else {
      out.push(input)
    }
  }
  return out
}
