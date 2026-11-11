import type { VoiceTranscriptionOptions } from '@solus/contracts/voice-dictionary'
import type { VoicePartial, VoiceTranscript, VoiceStreamFeedRequest, VoiceStreamRequest } from '@solus/contracts/voice-stream'

export interface VoiceStreamApi {
  voiceStreamStart(options?: VoiceTranscriptionOptions): Promise<{ streamId: string }>
  voiceStreamFeed(request: VoiceStreamFeedRequest): Promise<VoicePartial>
  voiceStreamFinish(request: VoiceStreamRequest): Promise<VoiceTranscript>
  voiceStreamCancel(request: VoiceStreamRequest): Promise<void>
}

/** Serial feeds with bounded buffering. Losing a stream never loses the
 * recorder's separate full clip, which remains available for an offline retry. */
export class VoiceStreamSession {
  #streamId: string | null = null
  #queued: Float32Array[] = []
  #queuedSamples = 0
  #draining: Promise<void> | null = null
  #started: Promise<void>
  #failed: Error | null = null
  #cancelled = false
  #finished = false
  #finishing = false
  #cancelRequest: Promise<void> | null = null
  #partial: VoicePartial = { stable: '', tentative: '' }

  constructor(private api: VoiceStreamApi, private onPartial?: (partial: VoicePartial) => void, options?: VoiceTranscriptionOptions) {
    this.#started = api.voiceStreamStart(options).then(({ streamId }) => {
      this.#streamId = streamId
      if (this.#cancelled) this.#cancelRequest = api.voiceStreamCancel({ streamId }).catch(() => {})
    }).catch(error => { this.#fail(error instanceof Error ? error : new Error(String(error))) })
  }

  feed(samples: Float32Array): void {
    if (this.#cancelled || this.#failed || this.#finished || this.#finishing) return
    // AudioWorklet capture emits 250 ms packets. Bound startup/slow-device
    // backlog to ten seconds instead of retaining unbounded RPC promises.
    if (samples.length > 16_000 || this.#queuedSamples + samples.length > 160_000) {
      this.#fail(new Error('Voice streaming could not keep up with recording'))
      return
    }
    if (!samples.length) return
    this.#queued.push(samples)
    this.#queuedSamples += samples.length
    this.#drain()
  }

  #drain(): void {
    if (this.#draining) return
    this.#draining = (async () => {
      await this.#started
      while (this.#queued.length && !this.#cancelled && !this.#failed) {
        const samples = this.#queued.shift()!
        this.#queuedSamples -= samples.length
        const partial = await this.api.voiceStreamFeed({ streamId: this.#streamId!, samples: Array.from(samples) })
        // A late reply must not restore text after cancellation or failure.
        if (!this.#cancelled && !this.#failed) this.#publishPartial(partial)
      }
    })().catch(error => { this.#fail(error instanceof Error ? error : new Error(String(error))) }).finally(() => {
      this.#draining = null
      // Capture can enqueue after the loop exits but before this promise
      // settles. Resume that audio, including when finish is waiting for it.
      if (this.#queued.length && !this.#cancelled && !this.#failed) this.#drain()
    })
  }

  async finish(): Promise<VoiceTranscript> {
    await this.#started
    while (this.#draining) await this.#draining
    if (this.#cancelRequest) await this.#cancelRequest
    if (this.#failed) throw this.#failed
    if (this.#cancelled || !this.#streamId) throw new Error('Voice stream was cancelled')
    this.#finishing = true
    try {
      const result = await this.api.voiceStreamFinish({ streamId: this.#streamId })
      this.#finished = true
      return result
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)))
      if (this.#cancelRequest) await this.#cancelRequest
      throw error
    }
  }

  cancel(): void {
    if (this.#cancelled || this.#finished) return
    this.#cancelled = true
    this.#queued = []
    this.#queuedSamples = 0
    this.#publishPartial({ stable: '', tentative: '' })
    if (this.#streamId) this.#cancelRequest = this.api.voiceStreamCancel({ streamId: this.#streamId }).catch(() => {})
  }

  #publishPartial(partial: VoicePartial): void {
    if (partial.stable === this.#partial.stable && partial.tentative === this.#partial.tentative) return
    this.#partial = partial
    this.onPartial?.(partial)
  }

  #fail(error: Error): void {
    this.#failed = error
    this.cancel()
  }
}
