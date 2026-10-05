import type { DeviceFrameHeader, DeviceScreenConfig } from '@solus/contracts/device-types'

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
  present(source: DrawableFrame, width: number, height: number): void
  status(status: DeviceVideoStatus): void
  screen(screen: DeviceScreenConfig | null, screenGeneration: number): void
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
  private closed = false
  private streaming = false
  private timestamp = 0
  private epoch = 0
  private jpegInFlight = false

  constructor(
    private readonly events: DeviceVideoEvents,
    private readonly codecs: VideoCodecs | null,
    private readonly decodeImage: DecodeImage,
  ) {
    events.status({ kind: 'connecting' })
  }

  push(header: DeviceFrameHeader, data: Uint8Array): void {
    if (this.closed) return
    if (header.streamGeneration !== this.generation) {
      // The host restarted its upstream: nothing decodable carries over.
      this.generation = header.streamGeneration
      this.awaitingKey = true
    }
    switch (header.kind) {
      case 'screen':
        this.events.screen(header.screen ?? null, header.screenGeneration ?? 0)
        return
      case 'ended':
        this.resetDecoder()
        this.streaming = false
        this.events.status({ kind: 'ended', detail: header.detail ?? 'The device stream ended.' })
        return
      case 'jpeg':
        this.paintJpeg(data)
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
    const codecs = this.codecs
    if (!codecs) {
      this.events.status({ kind: 'unsupported', codec })
      return
    }
    const epoch = ++this.epoch
    const config: DecoderConfig = { codec, optimizeForLatency: true }
    if (description) config.description = description
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
              if (this.decoder === decoder && !this.closed) this.presented(frame, frame.displayWidth, frame.displayHeight)
            } finally {
              frame.close()
            }
          },
          error: () => {
            if (this.decoder === decoder) this.resetDecoder()
          },
        })
        try {
          decoder.configure(config)
          this.decoder = decoder
          this.awaitingKey = true
        } catch {
          decoder.close()
          this.events.status({ kind: 'unsupported', codec })
        }
      })
      .finally(() => {
        if (epoch === this.epoch) this.configuring = null
      })
  }

  private decode(isKey: boolean, data: Uint8Array, timestamp: number | undefined): void {
    const decoder = this.decoder
    if (!decoder || decoder.state !== 'configured' || !this.codecs) return
    if (this.awaitingKey) {
      if (!isKey) return
      this.awaitingKey = false
    }
    if (decoder.decodeQueueSize > SOFT_DECODE_QUEUE) {
      // Falling behind: skip to the next keyframe instead of growing a queue.
      this.awaitingKey = true
      return
    }
    try {
      decoder.decode(this.codecs.createChunk({ type: isKey ? 'key' : 'delta', timestamp: timestamp ?? this.timestamp, data }))
      this.timestamp += FRAME_DURATION_US
    } catch {
      this.resetDecoder()
    }
  }

  private paintJpeg(data: Uint8Array): void {
    // Latest image wins: a frame that arrives while one decodes is skipped.
    if (this.jpegInFlight) return
    this.jpegInFlight = true
    void this.decodeImage(new Blob([new Uint8Array(data)], { type: 'image/jpeg' }))
      .then((bitmap) => {
        try {
          if (!this.closed) this.presented(bitmap, bitmap.width, bitmap.height)
        } finally {
          bitmap.close()
        }
      })
      .catch(() => {})
      .finally(() => { this.jpegInFlight = false })
  }

  private presented(source: DrawableFrame, width: number, height: number): void {
    this.events.present(source, width, height)
    if (!this.streaming) {
      this.streaming = true
      this.events.status({ kind: 'streaming' })
    }
  }

  private resetDecoder(): void {
    this.epoch++
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
    this.resetDecoder()
  }

  /** For tests: a pending configuration settles. */
  async settled(): Promise<void> {
    await this.configuring
  }
}
