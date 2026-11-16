import type { DeviceScreenConfig } from '@solus/contracts/device-types'
import type { DeviceVideoPacket } from '@solus/client-core/device-hub-stream'

/**
 * Decodes one device's packets for one visible surface. H.264 goes through
 * WebCodecs, configured from the host's `config` packet; JPEG (the iOS
 * fallback and seed frames) goes through `createImageBitmap`. Nothing here
 * runs while the surface is hidden: the surface closes the decoder and the
 * host stops sending. Recovery follows T3 Code's stream client (MIT,
 * pingdotgg/t3code@43bd667, packages/client-runtime/src/device/stream.ts).
 */

export type DeviceVideoStatus =
  | { kind: 'connecting' }
  | { kind: 'streaming' }
  /** This client cannot decode the stream's H.264 profile. iOS falls back to JPEG. */
  | { kind: 'unsupported'; codec: string }
  | { kind: 'ended'; detail: string }

/** What a decoder hands the surface: a WebCodecs VideoFrame or an ImageBitmap in a browser. */
export type DrawableFrame = VideoFrameLike | ImageBitmapLike

export interface DeviceVideoEvents {
  present(source: DrawableFrame, width: number, height: number, kind: 'video' | 'jpeg' | 'seed'): void
  status(status: DeviceVideoStatus): void
  screen(screen: DeviceScreenConfig | null): void
  /** The decoder drops frames until a keyframe; the stream should ask for one. */
  needsKeyframe(): void
}

/** A canvas transform `[a, b, c, d, e, f]` that draws a raw frame upright. */
export type FrameTransform = [number, number, number, number, number, number]

/**
 * How to draw an iOS frame as the user sees the screen. serve-sim streams the
 * portrait framebuffer and only reports the new orientation, so a rotated
 * portrait-native device (an iPad turned to landscape) must be turned here.
 * A landscape-shaped screen is already upright. This is the inverse of the
 * host's `iosRawPoint`, so taps land where they are drawn.
 */
export interface DeviceFramePlacement { width: number; height: number; transform: FrameTransform }

export function framePlacement(screen: DeviceScreenConfig | null, width: number, height: number): DeviceFramePlacement {
  const upright: DeviceFramePlacement = { width, height, transform: [1, 0, 0, 1, 0, 0] }
  if (!screen || screen.width > screen.height) return upright
  switch (screen.orientation) {
    case 'landscape_left':
      return { width: height, height: width, transform: [0, 1, -1, 0, height, 0] }
    case 'landscape_right':
      return { width: height, height: width, transform: [0, -1, 1, 0, 0, width] }
    case 'portrait_upside_down':
      return { width, height, transform: [-1, 0, 0, -1, width, height] }
    default:
      return upright
  }
}

export interface DecoderConfig {
  codec: string
  description?: Uint8Array
  optimizeForLatency?: boolean
}

export interface EncodedChunkInit {
  type: 'key' | 'delta'
  timestamp: number
  data: Uint8Array
}

/** An encoded chunk as the decoder receives it. Opaque here. */
export interface EncodedChunkLike {
  readonly type: string
}

/** The WebCodecs surface this module uses; injected so tests run without a browser. */
export interface VideoCodecs {
  createDecoder(init: { output: (frame: VideoFrameLike) => void; error: (error: Error) => void }): VideoDecoderLike
  isConfigSupported(config: DecoderConfig): Promise<{ supported?: boolean }>
  createChunk(init: EncodedChunkInit): EncodedChunkLike
}

/** Turns a JPEG into something drawable. `createImageBitmap` in a browser. */
export type DecodeImage = (blob: Blob) => Promise<ImageBitmapLike>

export interface VideoFrameLike {
  displayWidth: number
  displayHeight: number
  close(): void
}

export interface ImageBitmapLike {
  width: number
  height: number
  close(): void
}

export interface VideoDecoderLike {
  state: string
  decodeQueueSize: number
  configure(config: DecoderConfig): void
  decode(chunk: EncodedChunkLike): void
  close(): void
}

const SOFT_DECODE_QUEUE = 8
const FRAME_DURATION_US = 16_667

/** WebCodecs exists only in secure contexts; plain-http remote origins lack it. */
export function browserVideoCodecs(): VideoCodecs | null {
  if (!('VideoDecoder' in globalThis) || !('EncodedVideoChunk' in globalThis)) return null
  return {
    createDecoder: (init) => new VideoDecoder(init),
    isConfigSupported: (config) => VideoDecoder.isConfigSupported(config),
    createChunk: (init) => new EncodedVideoChunk(init),
  }
}

export class DeviceVideoDecoder {
  private decoder: VideoDecoderLike | null = null
  private awaitingKey = true
  private generation = -1
  private configuring: Promise<void> | null = null
  private config: DecoderConfig | null = null
  private readonly pending: { isKey: boolean; data: Uint8Array; timestamp: number | undefined }[] = []
  private pendingOverflow = false
  private closed = false
  private streaming = false
  private timestamp = 0
  private epoch = 0
  private jpegInFlight = false
  private imageEpoch = 0
  private videoGeneration: number | null = null

  constructor(
    private readonly events: DeviceVideoEvents,
    private readonly codecs: VideoCodecs | null,
    private readonly decodeImage: DecodeImage,
  ) {
    events.status({ kind: 'connecting' })
  }

  push(header: DeviceVideoPacket, data: Uint8Array): void {
    if (this.closed) return
    if (header.streamGeneration !== this.generation) {
      // The host restarted its upstream: nothing decodable carries over.
      this.generation = header.streamGeneration
      this.videoGeneration = null
      this.resetImages()
      this.resetDecoder()
    }
    switch (header.kind) {
      case 'connecting':
        this.streaming = false
        this.events.status({ kind: 'connecting' })
        return
      case 'screen':
        this.events.screen(header.screen ?? null)
        return
      case 'ended':
        this.resetImages()
        this.resetDecoder()
        this.streaming = false
        this.events.status({ kind: 'ended', detail: header.detail ?? 'The device stream ended.' })
        return
      case 'jpeg':
      case 'seed':
        this.paintJpeg(data, header.kind === 'seed')
        return
      case 'config':
        this.configure(header.codec ?? 'avc1.42E01E', header.format === 'avcc' ? data : undefined)
        return
      case 'key':
      case 'delta':
        this.decode(header.kind === 'key', data, header.timestamp)
    }
  }

  private configure(codec: string, description: Uint8Array | undefined): void {
    this.resetDecoder()
    const config: DecoderConfig = { codec, optimizeForLatency: true }
    if (description) config.description = description
    this.config = config
    const codecs = this.codecs
    if (!codecs) {
      this.events.status({ kind: 'unsupported', codec })
      return
    }
    const epoch = ++this.epoch
    this.configuring = codecs.isConfigSupported(config)
      .catch(() => ({ supported: false }))
      .then((support) => {
        if (this.closed || epoch !== this.epoch) return
        if (!support.supported) {
          this.events.status({ kind: 'unsupported', codec })
          return
        }
        const decoder = codecs.createDecoder({
          output: (frame) => {
            try {
              if (this.decoder === decoder && !this.closed) {
                this.videoGeneration = this.generation
                this.presented(frame, frame.displayWidth, frame.displayHeight, 'video')
              }
            } finally {
              frame.close()
            }
          },
          error: () => {
            if (this.decoder !== decoder) return
            this.recover()
          },
        })
        try {
          decoder.configure(config)
          this.decoder = decoder
          this.awaitingKey = true
          const pending = this.pending.splice(0)
          const overflow = this.pendingOverflow
          this.pendingOverflow = false
          for (const frame of pending) {
            if (epoch !== this.epoch) break
            this.decode(frame.isKey, frame.data, frame.timestamp)
          }
          if (overflow) this.events.needsKeyframe()
        } catch {
          decoder.close()
          this.events.status({ kind: 'unsupported', codec })
        }
      })
      .finally(() => {
        if (epoch === this.epoch) {
          this.configuring = null
          this.pending.length = 0
        }
      })
  }

  private decode(isKey: boolean, data: Uint8Array, timestamp: number | undefined): void {
    if (this.configuring && !this.decoder) {
      // A description and its keyframe can arrive in the same network read.
      // Keep their order while the asynchronous codec check completes.
      if (isKey) {
        this.pending.length = 0
        this.pendingOverflow = false
      }
      if (!isKey && this.pending.length === 0) return
      if (this.pending.length >= SOFT_DECODE_QUEUE) {
        this.pending.length = 0
        this.pendingOverflow = true
        return
      }
      this.pending.push({ isKey, data, timestamp })
      return
    }
    const decoder = this.decoder
    if (!decoder || decoder.state !== 'configured' || !this.codecs) return
    if (this.awaitingKey) {
      if (!isKey) {
        this.events.needsKeyframe()
        return
      }
      this.awaitingKey = false
    }
    if (decoder.decodeQueueSize > SOFT_DECODE_QUEUE) {
      // Falling behind: skip to the next keyframe instead of growing a queue.
      // iOS sends one only when its stream starts, so ask for it.
      this.recover()
      return
    }
    try {
      decoder.decode(this.codecs.createChunk({ type: isKey ? 'key' : 'delta', timestamp: timestamp ?? this.timestamp, data }))
      this.timestamp += FRAME_DURATION_US
    } catch {
      this.recover()
    }
  }

  private recover(): void {
    const config = this.config
    // Android can send the next keyframe without repeating its codec config.
    if (config) this.configure(config.codec, config.description)
    else this.resetDecoder()
    this.streaming = false
    this.events.status({ kind: 'connecting' })
    this.events.needsKeyframe()
  }

  private paintJpeg(data: Uint8Array, seed: boolean): void {
    if (seed && this.videoGeneration === this.generation) return
    // Latest image wins: a frame that arrives while one decodes is skipped.
    if (this.jpegInFlight) return
    this.jpegInFlight = true
    const imageEpoch = this.imageEpoch
    void this.decodeImage(new Blob([new Uint8Array(data)], { type: 'image/jpeg' }))
      .then((bitmap) => {
        try {
          // A cached bootstrap image can finish after live video or after a reconnect.
          // It must never replace the newer screen, even when that screen is idle.
          if (!this.closed && imageEpoch === this.imageEpoch && (!seed || this.videoGeneration !== this.generation)) {
            this.presented(bitmap, bitmap.width, bitmap.height, seed ? 'seed' : 'jpeg')
          }
        } finally {
          bitmap.close()
        }
      })
      .catch(() => {})
      .finally(() => { if (imageEpoch === this.imageEpoch) this.jpegInFlight = false })
  }

  private presented(source: DrawableFrame, width: number, height: number, kind: 'video' | 'jpeg' | 'seed'): void {
    this.events.present(source, width, height, kind)
    if (!this.streaming) {
      this.streaming = true
      this.events.status({ kind: 'streaming' })
    }
  }

  private resetImages(): void {
    this.imageEpoch++
    this.jpegInFlight = false
  }

  private resetDecoder(): void {
    this.epoch++
    this.configuring = null
    this.pending.length = 0
    this.pendingOverflow = false
    try {
      this.decoder?.close()
    } catch {
      // Already closed.
    }
    this.decoder = null
    this.awaitingKey = true
  }

  /** Release the decoder and every frame. The surface calls this when hidden. */
  close(): void {
    this.closed = true
    this.resetImages()
    this.resetDecoder()
  }

  /** For tests: a pending configuration settles. */
  async settled(): Promise<void> {
    await this.configuring
  }
}
