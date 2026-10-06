import type {
  DeviceButton,
  DeviceInput,
  DevicePlatform,
  DeviceScreenConfig,
} from '@solus/contracts/device-types'
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
import { iosTextKeys } from './device-text-keys'
import { MjpegSplitter, webUpstream, type DeviceUpstream, type UpstreamSocket } from './device-upstream'

/**
 * One client's view of one device, read straight from the hub through the
 * host's signed proxy (docs/plans/native-devices.md, D2). Protocol handling
 * follows T3 Code's stream client (MIT, pingdotgg/t3code@43bd667,
 * packages/client-runtime/src/device/stream.ts).
 *
 * - iOS: video is the `video.avcc` body (or `video.mjpeg` without WebCodecs);
 *   input and screen config ride the helper socket.
 * - Android: one socket carries SEMU video and JSON input.
 *
 * Touches are mapped against the newest screen the helper reported. A screen
 * change ends a held touch, so no finger stays pressed after a rotation.
 */

const RETRY_DELAY_MS = 1_000
const SOCKET_OPEN_TIMEOUT_MS = 5_000
const KEYFRAME_REQUEST_INTERVAL_MS = 2_000
const PRIME_TIMEOUT_MS = 2_000
/** A signed URL opens connections for a minute; reuse it for half of that. */
const URL_REUSE_MS = 30_000
/** A wheel burst is one finger drag; the finger lifts when the wheel stops for this long. Well under iOS's long press. */
const WHEEL_GESTURE_END_MS = 150
/** Wheel travel, as a fraction of the screen, before the finger goes down. Less would reach the device as a tap. */
const MIN_WHEEL_TRAVEL = 0.02

export type DeviceVideoFormat = 'h264' | 'jpeg'

/**
 * One unit for the decoder.
 *
 * - `config`: decoder configuration. `format: 'avcc'` carries the avcC record
 *   as bytes; `annexb` carries no bytes (parameter sets ride in keyframes).
 * - `key` / `delta`: one encoded access unit.
 * - `jpeg`: one whole image (MJPEG fallback and iOS seed frames).
 * - `screen`: no bytes; the device screen changed.
 * - `ended`: no bytes; the stream cannot continue (reason in `detail`).
 */
export interface DeviceVideoPacket {
  kind: 'config' | 'key' | 'delta' | 'jpeg' | 'screen' | 'ended'
  /** Increases whenever the hub stream restarts: nothing decodable carries over. */
  streamGeneration: number
  codec?: string
  format?: 'avcc' | 'annexb'
  /** Microseconds, when the source provides them. */
  timestamp?: number
  screen?: DeviceScreenConfig | null
  detail?: string
}

export interface DeviceHubStreamOptions {
  platform: DevicePlatform
  format: DeviceVideoFormat
  /** A fresh absolute URL from `deviceStreamUrl`. Rejects with `DeviceStreamEnded` when the host refused; any other failure is retried. */
  openUrl: () => Promise<string>
  onPacket: (packet: DeviceVideoPacket, data: Uint8Array) => void
  upstream?: DeviceUpstream
  now?: () => number
  delay?: (ms: number) => Promise<void>
  /** Runs a callback after a pause and returns its cancel. Tests pass their own clock. */
  setTimer?: (callback: () => void, ms: number) => () => void
}

/** One message to the hub's input socket: tagged binary for iOS, JSON text for Android. */
type UpstreamMessage = string | Uint8Array

/** The host will not stream this device: the stream stops and says why. */
export class DeviceStreamEnded extends Error {}

export class DeviceHubStream {
  private closed = false
  private streamGeneration = 0
  private screen: DeviceScreenConfig | null = null
  private heldPointer: { x: number; y: number } | null = null
  /** The finger a wheel burst moves: down where the burst began, lifted when it stops. */
  private wheel: { originX: number; originY: number; x: number; y: number; isDown: boolean; cancelEnd: () => void } | null = null
  private hasConfig = false
  private codec: string | null = null
  private socket: UpstreamSocket | null = null
  private socketOpen = false
  private socketWaiters: (() => void)[] = []
  private lastKeyframeRequest = Number.NEGATIVE_INFINITY
  /** The AVCC or MJPEG body being read, so a keyframe request can restart it. */
  private videoRead: AbortController | null = null
  private restartVideo = false
  private readonly aborts = new Set<AbortController>()
  private url: { value: string; at: number } | null = null
  private readonly upstream: DeviceUpstream
  private readonly now: () => number
  private readonly delay: (ms: number) => Promise<void>
  private readonly setTimer: (callback: () => void, ms: number) => () => void

  constructor(private readonly options: DeviceHubStreamOptions) {
    this.upstream = options.upstream ?? webUpstream
    this.now = options.now ?? Date.now
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    })
  }

  start(): void {
    void this.connectSocket()
    if (this.options.platform === 'ios') void this.readVideo(this.options.format === 'jpeg' ? 'video.mjpeg' : 'video.avcc')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.wheel?.cancelEnd()
    this.wheel = null
    for (const abort of this.aborts) abort.abort()
    this.aborts.clear()
    const socket = this.socket
    this.socket = null
    this.socketOpen = false
    socket?.close()
  }

  private emit(packet: Omit<DeviceVideoPacket, 'streamGeneration'>, data: Uint8Array = new Uint8Array()): void {
    if (!this.closed) this.options.onPacket({ ...packet, streamGeneration: this.streamGeneration }, data)
  }

  /** The device cannot be shown any more: say why and stop retrying. */
  private end(reason: DeviceStreamEnded): void {
    if (this.closed) return
    this.emit({ kind: 'ended', detail: reason.message })
    this.close()
  }

  private async base(): Promise<string> {
    if (this.url && this.now() - this.url.at < URL_REUSE_MS) return this.url.value
    const value = await this.options.openUrl()
    this.url = { value, at: this.now() }
    return value
  }

  /** Read one long-lived body until it ends, the stream closes, or `onChunk` stops it. */
  private async read(route: string, onChunk: (chunk: Uint8Array, stop: () => void) => void, timeoutMs?: number, onStart?: (abort: AbortController) => void): Promise<void> {
    const abort = new AbortController()
    this.aborts.add(abort)
    onStart?.(abort)
    const timer = timeoutMs === undefined ? null : setTimeout(() => abort.abort(), timeoutMs)
    try {
      await this.upstream.readBody(`${await this.base()}/${route}`, abort.signal, (chunk) => onChunk(chunk, () => abort.abort()))
    } finally {
      if (timer) clearTimeout(timer)
      this.aborts.delete(abort)
    }
  }

  // ─── Video ───

  private async readVideo(route: 'video.avcc' | 'video.mjpeg'): Promise<void> {
    while (!this.closed) {
      try {
        if (route === 'video.mjpeg') {
          const splitter = new MjpegSplitter()
          await this.read(route, (chunk) => {
            for (const image of splitter.push(chunk)) this.emit({ kind: 'jpeg' }, image)
          })
        } else {
          const demuxer = new AvccDemuxer()
          await this.read(route, (chunk) => {
            for (const envelope of demuxer.push(chunk)) {
              if (envelope.type === 'description') this.emit({ kind: 'config', codec: avcCodecString(envelope.payload), format: 'avcc' }, envelope.payload)
              else if (envelope.type === 'seed') this.emit({ kind: 'jpeg' }, envelope.payload)
              else this.emit({ kind: envelope.type === 'keyframe' ? 'key' : 'delta' }, envelope.payload)
            }
          }, undefined, (abort) => { this.videoRead = abort })
        }
      } catch (error) {
        if (error instanceof DeviceStreamEnded) return this.end(error)
      }
      this.videoRead = null
      if (this.closed) return
      // The hub stream restarted: everything decodable before it is gone.
      this.streamGeneration++
      // A keyframe request ended the read on purpose: read again at once.
      if (this.restartVideo) {
        this.restartVideo = false
        continue
      }
      await this.delay(RETRY_DELAY_MS)
    }
  }

  // ─── Socket ───

  /**
   * serve-sim's helper accepts HID and pushes screen config only once capture
   * runs, and the AVCC stream does not reliably start it. One short MJPEG read
   * does.
   */
  private async primeIosCapture(): Promise<void> {
    try {
      // Stop at the first bytes: capture has started.
      await this.read('video.mjpeg', (_chunk, stop) => stop(), PRIME_TIMEOUT_MS)
    } catch (error) {
      // A failed prime only means the socket may need a retry.
      if (error instanceof DeviceStreamEnded) throw error
    }
  }

  private async connectSocket(): Promise<void> {
    while (!this.closed) {
      let url: string
      try {
        if (this.options.platform === 'ios') await this.primeIosCapture()
        url = `${(await this.base()).replace(/^http/, 'ws')}/socket`
      } catch (error) {
        if (error instanceof DeviceStreamEnded) return this.end(error)
        await this.delay(RETRY_DELAY_MS)
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => this.openSocket(url, resolve))
      if (this.closed) return
      await this.delay(RETRY_DELAY_MS)
    }
  }

  /** Open one socket; `onEnd` runs when it closes. */
  private openSocket(url: string, onEnd: () => void): void {
    const socket = this.upstream.openSocket(url, {
      onOpen: () => {
        if (this.socket !== socket) return
        this.socketOpen = true
        if (this.options.platform === 'ios') socket.send(iosInput.hardwareKeyboard(false))
        for (const resolve of this.socketWaiters.splice(0)) resolve()
      },
      onMessage: (data) => {
        if (this.socket !== socket) return
        if (this.options.platform === 'ios') this.iosMessage(data)
        else this.androidMessage(data)
      },
      onClose: () => {
        if (this.socket !== socket) return
        this.socket = null
        this.socketOpen = false
        this.heldPointer = null
        this.wheel?.cancelEnd()
        this.wheel = null
        if (this.options.platform === 'android') {
          this.hasConfig = false
          this.codec = null
          this.streamGeneration++
        }
        onEnd()
      },
    })
    this.socket = socket
  }

  private iosMessage(data: Uint8Array | string): void {
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
        this.hasConfig = false
        this.codec = null
        this.screenChanged(null)
        this.lastKeyframeRequest = Number.NEGATIVE_INFINITY
        this.requestKeyframe()
      }
      return
    }
    const packet = parseSemuPacket(data)
    const scanned = packet.isKey === null || (packet.isKey && !this.hasConfig) ? scanAccessUnit(packet.data) : null
    const isKey = packet.isKey ?? scanned?.isKey ?? false
    if (scanned?.sps) {
      const codec = avcCodecString(scanned.sps)
      if (this.codec !== codec) {
        this.codec = codec
        this.hasConfig = true
        this.emit({ kind: 'config', codec, format: 'annexb' })
      }
    }
    if (!this.hasConfig) {
      if (!isKey) this.requestKeyframe()
      return
    }
    this.emit(packet.timestamp == null ? { kind: isKey ? 'key' : 'delta' } : { kind: isKey ? 'key' : 'delta', timestamp: packet.timestamp }, packet.data)
  }

  /**
   * Ask for a keyframe, at most once per interval. Android's encoder takes a
   * reset. serve-sim sends an iOS keyframe only when its AVCC stream starts
   * (measured: none after the first two), so the AVCC read starts again.
   */
  requestKeyframe(): void {
    const now = this.now()
    if (now - this.lastKeyframeRequest < KEYFRAME_REQUEST_INTERVAL_MS) return
    this.lastKeyframeRequest = now
    if (this.options.platform !== 'ios') {
      this.socket?.send(androidInput.resetVideo())
      return
    }
    if (this.options.format !== 'h264' || !this.videoRead) return
    this.restartVideo = true
    this.videoRead.abort()
  }

  private screenChanged(screen: DeviceScreenConfig | null): void {
    // A touch held against the old screen cannot be mapped any more: end it
    // on the device while the old screen still maps it.
    this.wheel?.cancelEnd()
    this.wheel = null
    const held = this.heldPointer
    if (held) {
      this.heldPointer = null
      this.socket?.send(this.touch('up', held.x, held.y))
    }
    this.screen = screen
    this.emit({ kind: 'screen', screen })
  }

  // ─── Input ───

  private async openedSocket(): Promise<UpstreamSocket> {
    if (!this.socketOpen) {
      await Promise.race([
        new Promise<void>((resolve) => this.socketWaiters.push(resolve)),
        this.delay(SOCKET_OPEN_TIMEOUT_MS),
      ])
    }
    if (!this.socket || !this.socketOpen) throw new Error('Input cannot reach the device right now. Reconnecting.')
    return this.socket
  }

  /** Send input in order. Consecutive moves collapse to the last one; down, up and cancel are kept. */
  async send(inputs: DeviceInput[]): Promise<void> {
    const messages = coalesce(inputs).flatMap((input) => this.messagesFor(input))
    const socket = await this.openedSocket()
    for (const message of messages) socket.send(message)
  }

  private touch(phase: 'down' | 'move' | 'up', x: number, y: number): UpstreamMessage {
    if (this.options.platform !== 'ios') return androidInput.touch(phase, x, y)
    const point = iosRawPoint(this.screen, x, y)
    return iosInput.touch(phase === 'down' ? 'begin' : phase === 'move' ? 'move' : 'end', point.x, point.y)
  }

  private messagesFor(input: DeviceInput): UpstreamMessage[] {
    switch (input.kind) {
      case 'pointer': return this.pointerMessages(input)
      case 'scroll': return this.scrollMessages(input)
      case 'text': return this.textMessages(input.text)
      case 'key': return this.keyMessages(input)
      case 'button': return [this.buttonMessage(input.button)]
      case 'rotate':
        if (this.options.platform !== 'ios') throw new Error('Rotate Android emulators with the orientation control in Tools.')
        return [iosInput.orientation(nextOrientation(this.screen?.orientation ?? 'portrait'))]
    }
  }

  /** Moves and ups without a held touch are dropped: a screen change already ended that gesture. */
  private pointerMessages(input: Extract<DeviceInput, { kind: 'pointer' }>): UpstreamMessage[] {
    if (input.phase === 'down') {
      // A click ends a wheel drag first, so the two never share one finger.
      const lifted = this.liftWheel()
      this.heldPointer = { x: input.x, y: input.y }
      return [...lifted, this.touch('down', input.x, input.y)]
    }
    if (!this.heldPointer) return []
    if (input.phase === 'move') {
      this.heldPointer = { x: input.x, y: input.y }
      return [this.touch('move', input.x, input.y)]
    }
    this.heldPointer = null
    return [this.touch('up', input.x, input.y)]
  }

  /**
   * Neither helper has a wheel event, so a wheel burst is one finger drag the
   * other way: down where the burst began, a move per wheel batch, and up
   * when the wheel stops or the finger reaches the screen edge. A finger put
   * down and lifted at once for each wheel event would reach the device as
   * taps at one spot, which iOS reads as double and triple taps that select.
   */
  private scrollMessages(input: Extract<DeviceInput, { kind: 'scroll' }>): UpstreamMessage[] {
    if (this.heldPointer && !this.wheel?.isDown) return []
    const clamp = (value: number) => Math.min(1, Math.max(0, value))
    const wheel = this.wheel ?? { originX: input.x, originY: input.y, x: input.x, y: input.y, isDown: false, cancelEnd: () => {} }
    this.wheel = wheel
    wheel.x = clamp(wheel.x - input.deltaX)
    wheel.y = clamp(wheel.y - input.deltaY)
    wheel.cancelEnd()
    wheel.cancelEnd = this.setTimer(() => {
      for (const message of this.liftWheel()) this.socket?.send(message)
    }, WHEEL_GESTURE_END_MS)
    const out: UpstreamMessage[] = []
    if (!wheel.isDown) {
      if (Math.hypot(wheel.x - wheel.originX, wheel.y - wheel.originY) < MIN_WHEEL_TRAVEL) return out
      wheel.isDown = true
      out.push(this.touch('down', wheel.originX, wheel.originY))
    }
    this.heldPointer = { x: wheel.x, y: wheel.y }
    out.push(this.touch('move', wheel.x, wheel.y))
    // A finger at the edge cannot move further: lift it, and the next wheel event starts a new drag.
    if (wheel.x === 0 || wheel.x === 1 || wheel.y === 0 || wheel.y === 1) out.push(...this.liftWheel())
    return out
  }

  /** End the wheel drag: the finger lifts where it is. Nothing to send when it never went down. */
  private liftWheel(): UpstreamMessage[] {
    const wheel = this.wheel
    if (!wheel) return []
    wheel.cancelEnd()
    this.wheel = null
    if (!wheel.isDown) return []
    this.heldPointer = null
    return [this.touch('up', wheel.x, wheel.y)]
  }

  private textMessages(text: string): UpstreamMessage[] {
    if (this.options.platform !== 'ios') return [androidInput.text(text)]
    return iosTextKeys(text).flatMap((key) => [
      ...(key.shift ? [iosInput.key('down', 0xe1)] : []),
      iosInput.key('down', key.usage),
      iosInput.key('up', key.usage),
      ...(key.shift ? [iosInput.key('up', 0xe1)] : []),
    ])
  }

  private keyMessages(input: Extract<DeviceInput, { kind: 'key' }>): UpstreamMessage[] {
    if (this.options.platform === 'ios') {
      const usage = hidUsageForCode(input.code)
      return usage === null ? [] : [iosInput.key(input.phase, usage)]
    }
    if (input.phase !== 'down') return []
    const message = androidKeyMessage(input.key, input.hasModifier === true)
    return message ? [message] : []
  }

  private buttonMessage(button: DeviceButton): UpstreamMessage {
    if (this.options.platform !== 'ios') return androidInput.button(androidButtonName(button))
    const name = iosButtonName(button)
    if (!name) throw new Error(`iOS Simulators have no ${button} button.`)
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
