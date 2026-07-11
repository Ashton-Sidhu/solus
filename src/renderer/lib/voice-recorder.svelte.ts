import { analytics } from './analytics'
import { PcmCapture, type PcmChunk } from './pcm-capture'

// Hard ceiling on a single recording. Batch transcription decodes the whole
// utterance in one pass, so an unbounded buffer means an unbounded decode; this
// wall-clock backstop (a timeout, not the starvable VAD interval) bounds the
// captured audio so a stuck mic can never balloon the payload we transcribe.
const MAX_RECORDING_MS = 60_000
// Audio is held back from the buffer until a chunk crosses this rms — leading
// mic-onset noise/breath decodes as garbage punctuation (a stray "?"). Same
// threshold the worker uses for its speech gate.
const SPEECH_RMS_THRESHOLD = 0.003
// Onset detection scans each capture chunk in short frames instead of trusting
// its whole-chunk average: the first chunk of an utterance is mostly leading
// silence, which dilutes a soft first word below the gate. Averaging would
// discard that chunk and clip the start of the sentence, so instead a single
// speech-level frame keeps the whole chunk. 20ms @ 16kHz.
const ONSET_FRAME_SAMPLES = 320
// Tail of pre-speech audio buffered once speech starts, so a word onset that
// straddles the chunk boundary isn't clipped. 0.25s @ 16kHz.
const PRE_ROLL_SAMPLES = 4_000
const devVoiceSessionLogging = Boolean(import.meta.env.DEV)

type DevVoiceSessionStats = {
  firstStartedAtIso: string | null
  count: number
  totalListeningMs: number
}

const devVoiceSessionStats: DevVoiceSessionStats = {
  firstStartedAtIso: null,
  count: 0,
  totalListeningMs: 0,
}

type LegacyGetUserMedia = (
  constraints: MediaStreamConstraints,
  onSuccess: (stream: MediaStream) => void,
  onError: (error: unknown) => void,
) => void

type LegacyNavigator = Navigator & {
  getUserMedia?: LegacyGetUserMedia
  webkitGetUserMedia?: LegacyGetUserMedia
  mozGetUserMedia?: LegacyGetUserMedia
}

export type VoiceState = 'idle' | 'recording' | 'transcribing'
export type VoiceErrorKind = 'transient' | 'permission' | 'hardware' | 'unsupported' | null

export class VoiceRecorder {
  state = $state<VoiceState>('idle')
  error = $state<string | null>(null)
  errorKind = $state<VoiceErrorKind>(null)
  readonly rmsRef = { current: 0 }

  #cancelled = false
  #maxDurationTimeout: number | null = null
  #capture: PcmCapture | null = null
  #buffer: Float32Array[] = []
  #speechDetected = false
  #preRoll: Float32Array = new Float32Array()
  #finishing = false
  #recordingStartedAtMs: number | null = null
  #recordingStartedAtIso: string | null = null
  #startGeneration = 0
  // True during the async getUserMedia gap: `state` stays 'idle' until the
  // stream resolves.  Public + reactive so the UI can bridge the visual gap
  // when auto-voice re-arms (waveform stays visible while the mic opens).
  starting = $state(false)
  #getVadSilenceMs: () => number
  #getVadMinSpeechMs: () => number

  onTranscript: ((transcript: string) => void) | null = null
  // Fired whenever the recorder settles back to 'idle' (after a stop, cancel,
  // empty capture, or error). Lets an owner serialize a queued next recording —
  // e.g. cancel the current one, then start the next once this fires.
  onIdle: ((allowAutoRearm: boolean) => void) | null = null

  constructor(getVadSilenceMs: () => number, getVadMinSpeechMs: () => number = () => 0) {
    this.#getVadSilenceMs = getVadSilenceMs
    this.#getVadMinSpeechMs = getVadMinSpeechMs
  }

  async start(): Promise<void> {
    if (this.state !== 'idle' || this.starting) return
    const generation = ++this.#startGeneration
    this.starting = true
    this.#setError(null, null)
    this.#cancelled = false

    analytics.voiceRecordingStarted()

    let stream: MediaStream
    try {
      stream = await requestMicrophoneStream()
    } catch (err) {
      if (generation !== this.#startGeneration) return
      const info = microphoneErrorInfo(err)
      this.#setError(info.message, info.kind)
      this.starting = false
      this.#toIdle(false)
      return
    }

    if (generation !== this.#startGeneration || this.#cancelled) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }

    if (!supportsBatchTranscription()) {
      stream.getTracks().forEach((track) => track.stop())
      this.#setError('Voice input is not supported in this environment.', 'unsupported')
      this.starting = false
      this.#toIdle(false)
      return
    }

    await this.#startCapture(stream, generation)
  }

  stop(): void {
    this.#cancelled = false
    if (this.starting) {
      this.cancel()
      return
    }
    if (this.#capture) {
      void this.#finish(false)
      return
    }
  }

  cancel(): void {
    this.#cancelled = true
    this.#startGeneration++
    if (this.starting) this.starting = false
    if (this.#capture) {
      void this.#finish(true)
      return
    }
    this.#toIdle(false)
  }

  toggle(): void {
    if (this.state === 'recording') this.stop()
    else if (this.state === 'idle') void this.start()
  }

  clearError(): void {
    this.#setError(null, null)
  }

  async #startCapture(stream: MediaStream, generation: number): Promise<void> {
    this.#buffer = []
    this.#speechDetected = false
    this.#preRoll = new Float32Array()
    this.#finishing = false

    let silenceMs = 0
    let speechMs = 0
    const capture = new PcmCapture(stream, (chunk) => {
      if (this.state !== 'recording' || this.#capture !== capture) return
      const hasSpeech = this.#handleChunk(chunk)
      if (hasSpeech) {
        speechMs += chunk.samples.length / 16
        silenceMs = 0
      } else if (this.#speechDetected && speechMs >= this.#getVadMinSpeechMs()) {
        silenceMs += chunk.samples.length / 16
        if (silenceMs >= this.#getVadSilenceMs()) this.stop()
      }
    })
    this.#capture = capture

    try {
      await capture.start()
    } catch (err: any) {
      if (generation !== this.#startGeneration) {
        capture.stop()
        return
      }
      this.#cleanup()
      stream.getTracks().forEach((track) => track.stop())
      this.#setError(`Voice failed: ${err.message ?? String(err)}`, 'transient')
      this.starting = false
      this.#toIdle(false)
      return
    }
    if (generation !== this.#startGeneration || this.#capture !== capture || this.#cancelled) {
      capture.stop()
      return
    }

    this.state = 'recording'
    this.starting = false
    this.#recordingStartedAtMs = performance.now()
    this.#recordingStartedAtIso = new Date().toISOString()
    if (!devVoiceSessionStats.firstStartedAtIso) {
      devVoiceSessionStats.firstStartedAtIso = this.#recordingStartedAtIso
    }
    this.#maxDurationTimeout = window.setTimeout(() => {
      this.#maxDurationTimeout = null
      this.stop()
    }, MAX_RECORDING_MS)
  }

  // Buffer a capture chunk, gating leading silence so a stray onset mark never
  // opens the transcript. Returns whether the chunk carried speech (drives VAD).
  #handleChunk(chunk: PcmChunk): boolean {
    this.rmsRef.current = chunk.rms * 128
    const hasSpeech = containsSpeech(chunk.samples)
    if (!this.#speechDetected) {
      if (!hasSpeech) {
        this.#preRoll = keepTail(this.#preRoll, chunk.samples, PRE_ROLL_SAMPLES)
        return false
      }
      this.#speechDetected = true
      if (this.#preRoll.length > 0) {
        this.#buffer.push(this.#preRoll)
        this.#preRoll = new Float32Array()
      }
    }
    this.#buffer.push(chunk.samples)
    return hasSpeech
  }

  async #finish(cancelled: boolean): Promise<void> {
    if (!this.#capture || this.#finishing) return
    this.#finishing = true
    const recordingStartedAtMs = this.#recordingStartedAtMs
    const recordingStartedAtIso = this.#recordingStartedAtIso
    const listeningMs = recordingStartedAtMs === null
      ? null
      : Math.round(performance.now() - recordingStartedAtMs)
    const hadSpeech = this.#speechDetected
    this.#recordingStartedAtMs = null
    this.#recordingStartedAtIso = null
    this.#clearMaxDurationTimeout()
    // stop() flushes the trailing partial chunk through onChunk (buffering it)
    // and stops the mic tracks before we read the buffer.
    this.#capture.stop()
    const samples = concatSamples(this.#buffer)
    this.#capture = null

    if (cancelled || !hadSpeech || samples.length === 0) {
      this.#cleanup()
      this.#toIdle(!cancelled)
      return
    }

    this.state = 'transcribing'
    const transcribeStartedAt = performance.now()
    let allowAutoRearm = false
    try {
      const result = await window.solus.transcribeAudio(samples)
      this.#logDevTranscriptionSession({
        transcript: result.transcript,
        startedAtIso: recordingStartedAtIso,
        listeningMs,
        transcribeMs: Math.round(performance.now() - transcribeStartedAt),
        success: !result.error,
      })
      if (result.error) {
        this.#setError(`Voice failed: ${result.error}`, 'transient')
      } else {
        allowAutoRearm = true
        if (result.transcript) {
          this.#setError(null, null)
          this.onTranscript?.(result.transcript)
        }
      }
    } catch (err: any) {
      this.#setError(`Voice failed: ${err.message ?? String(err)}`, 'transient')
    } finally {
      this.#cleanup()
      this.#toIdle(allowAutoRearm)
    }
  }

  #clearMaxDurationTimeout(): void {
    if (this.#maxDurationTimeout) {
      clearTimeout(this.#maxDurationTimeout)
      this.#maxDurationTimeout = null
    }
  }

  #cleanup(): void {
    this.#capture?.stop()
    this.#capture = null
    this.#buffer = []
    this.#speechDetected = false
    this.#preRoll = new Float32Array()
    this.#finishing = false
  }

  #toIdle(allowAutoRearm: boolean): void {
    this.state = 'idle'
    this.onIdle?.(allowAutoRearm)
  }

  #setError(message: string | null, kind: VoiceErrorKind): void {
    this.error = message
    this.errorKind = message ? kind : null
  }

  #logDevTranscriptionSession(args: {
    transcript: string | null
    startedAtIso: string | null
    listeningMs: number | null
    transcribeMs: number
    success: boolean
  }): void {
    if (!devVoiceSessionLogging) return

    const text = args.transcript?.trim() ?? ''
    const wordCount = text ? text.split(/\s+/).length : 0
    const listeningMs = args.listeningMs ?? 0
    devVoiceSessionStats.count += 1
    devVoiceSessionStats.totalListeningMs += listeningMs
    const row = {
      sessionIndex: devVoiceSessionStats.count,
      firstStartedAt: devVoiceSessionStats.firstStartedAtIso,
      startedAt: args.startedAtIso,
      listeningMs: args.listeningMs,
      transcribeMs: args.transcribeMs,
      prompt: text,
      promptChars: text.length,
      promptWords: wordCount,
      totalListeningMs: devVoiceSessionStats.totalListeningMs,
      success: args.success,
    }

    console.debug('[Solus][VoiceTranscription]', row)
    void window.solus.logVoiceTranscription(row)
  }
}

// True if any short frame within the chunk reaches speech level. Frame-level
// detection catches a word onset that the chunk-wide average would miss when
// most of the chunk is the silence that preceded the first word.
function containsSpeech(samples: Float32Array): boolean {
  for (let start = 0; start < samples.length; start += ONSET_FRAME_SAMPLES) {
    const end = Math.min(start + ONSET_FRAME_SAMPLES, samples.length)
    let sumSq = 0
    for (let i = start; i < end; i++) sumSq += samples[i] * samples[i]
    if (Math.sqrt(sumSq / (end - start)) >= SPEECH_RMS_THRESHOLD) return true
  }
  return false
}

function keepTail(existing: Float32Array, incoming: Float32Array, maxLength: number): Float32Array {
  if (incoming.length >= maxLength) return incoming.slice(incoming.length - maxLength)
  const merged = new Float32Array(existing.length + incoming.length)
  merged.set(existing)
  merged.set(incoming, existing.length)
  return merged.length <= maxLength ? merged : merged.slice(merged.length - maxLength)
}

function concatSamples(chunks: Float32Array[]): Float32Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

async function requestMicrophoneStream(): Promise<MediaStream> {
  const unsupportedMessage = microphoneUnsupportedMessage()
  if (unsupportedMessage) throw new MicrophoneUnsupportedError(unsupportedMessage)

  const modernGetUserMedia =
    navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
  if (modernGetUserMedia) {
    return modernGetUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
  }

  const legacyNavigator = navigator as LegacyNavigator
  const legacyGetUserMedia =
    legacyNavigator.getUserMedia ??
    legacyNavigator.webkitGetUserMedia ??
    legacyNavigator.mozGetUserMedia
  if (!legacyGetUserMedia) {
    throw new Error('Microphone input is not supported in this browser.')
  }

  return new Promise((resolve, reject) => {
    legacyGetUserMedia.call(
      legacyNavigator,
      { audio: true },
      resolve,
      reject,
    )
  })
}

function microphoneUnsupportedMessage(): string | null {
  if (typeof navigator === 'undefined') {
    return 'Microphone input is not available in this environment.'
  }
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'Microphone access requires a secure connection. Open Solus over HTTPS or localhost.'
  }

  const legacyNavigator = navigator as LegacyNavigator
  const hasGetUserMedia =
    typeof navigator.mediaDevices?.getUserMedia === 'function' ||
    typeof legacyNavigator.getUserMedia === 'function' ||
    typeof legacyNavigator.webkitGetUserMedia === 'function' ||
    typeof legacyNavigator.mozGetUserMedia === 'function'
  if (!hasGetUserMedia) {
    return 'Microphone input is not supported in this browser.'
  }
  return null
}

function supportsBatchTranscription(): boolean {
  return typeof window.solus.transcribeAudio === 'function' &&
    typeof AudioWorkletNode !== 'undefined'
}

class MicrophoneUnsupportedError extends Error {
  name = 'MicrophoneUnsupportedError'
}

function microphoneErrorInfo(err: unknown): { message: string; kind: NonNullable<VoiceErrorKind> } {
  const errorLike =
    typeof err === 'object' && err !== null
      ? (err as { name?: unknown; message?: unknown })
      : null
  const name = typeof errorLike?.name === 'string' ? errorLike.name : ''
  const message =
    typeof errorLike?.message === 'string' ? errorLike.message : ''

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return { message: 'Microphone permission denied.', kind: 'permission' }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { message: 'No microphone was found.', kind: 'hardware' }
    case 'NotReadableError':
    case 'TrackStartError':
      return { message: 'Microphone is already in use or unavailable.', kind: 'transient' }
    case 'SecurityError':
      return { message: 'Microphone access is blocked by browser security settings.', kind: 'unsupported' }
    case 'NotSupportedError':
    case 'MicrophoneUnsupportedError':
      return { message: message || 'Audio recording is not supported in this browser.', kind: 'unsupported' }
    default:
      if (message) return { message, kind: 'transient' }
      return { message: `Microphone error: ${String(err)}`, kind: 'transient' }
  }
}
