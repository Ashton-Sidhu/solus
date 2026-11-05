import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { cleanVoiceTranscript } from '@solus/server/transcription/clean-transcript'
import type { VoiceTranscript, VoicePartial } from '@solus/contracts/voice-stream'

export const NATIVE_OPERATIONS = { warm: 0, begin: 1, feed: 2, finish: 3, cancel: 4, batch: 5 } as const
export type NativeOperation = keyof typeof NATIVE_OPERATIONS
const responseSchema = z.object({
  id: z.number().int().nonnegative(),
  error: z.string().nullable(),
  transcript: z.string().nullable(),
  stable: z.string(),
  tentative: z.string(),
})
export type NativeResponse = VoiceTranscript & VoicePartial

export function nativeFrame(operation: NativeOperation, requestId: number, samples?: Float32Array): Buffer {
  const frame = Buffer.allocUnsafe(12 + (samples?.length ?? 0) * 4)
  frame.writeUInt32LE(NATIVE_OPERATIONS[operation], 0)
  frame.writeUInt32LE(requestId, 4)
  frame.writeUInt32LE(samples?.length ?? 0, 8)
  if (samples) for (let i = 0; i < samples.length; i++) frame.writeFloatLE(samples[i], 12 + i * 4)
  return frame
}

type Pending = {
  resolve: (response: NativeResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Owns exactly one child. A timeout retires that generation before a later
 * request can use it. Audio never passes through a shell or a temporary file. */
export class NativeVoiceWorker {
  readonly child: ChildProcessWithoutNullStreams
  #pending = new Map<number, Pending>()
  #nextRequestId = 1
  #stopped = false

  constructor(binaryPath: string, modelPath: string, onExit: () => void) {
    this.child = spawn(binaryPath, [modelPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    // Drain native diagnostics. Speech and audio are never logged here.
    this.child.stderr.resume()
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      let response: z.infer<typeof responseSchema>
      try { response = responseSchema.parse(JSON.parse(line)) }
      catch { this.stop('Invalid transcription worker response'); return }
      const pending = this.#pending.get(response.id)
      if (!pending) return
      this.#pending.delete(response.id)
      clearTimeout(pending.timer)
      if (response.transcript) response.transcript = cleanVoiceTranscript(response.transcript)
      pending.resolve(response)
    })
    this.child.once('error', error => this.stop(`Cannot start transcription worker: ${error.message}`))
    this.child.stdin.on('error', error => this.stop(`Transcription input failed: ${error.message}`))
    this.child.once('exit', () => {
      this.stop('Transcription worker stopped unexpectedly')
      lines.close()
      onExit()
    })
  }

  get stopped(): boolean { return this.#stopped }

  request(operation: NativeOperation, samples?: Float32Array, timeoutMs = 120_000): Promise<NativeResponse> {
    if (this.#stopped) return Promise.reject(new Error('Transcription worker is stopped'))
    const requestId = this.#nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop('Transcription timed out'), timeoutMs)
      timer.unref?.()
      this.#pending.set(requestId, { resolve, reject, timer })
      this.child.stdin.write(nativeFrame(operation, requestId, samples), error => {
        if (error) this.stop(`Transcription input failed: ${error.message}`)
      })
    })
  }

  stop(reason = 'Transcription cancelled'): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.#pending.clear()
    this.child.stdin.destroy()
    this.child.kill()
  }
}

