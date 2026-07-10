import { analytics } from './analytics'
import { PcmCapture, type PcmChunk } from './pcm-capture'

const VAD_SILENCE_THRESHOLD = 8
const STREAM_MAX_RECORDING_MS = 10 * 60_000
// When the live partial already ends in sentence-final punctuation the utterance
// is very likely complete, so we can end-point after this shorter silence.
const EARLY_ENDPOINT_SILENCE_MS = 1000
// Terminal punctuation, trailing whitespace tolerated.
const TERMINAL_PUNCTUATION = /[.!?]\s*$/
// Audio is held back from the transcriber until a chunk crosses this rms —
// leading mic-onset noise/breath decodes as garbage punctuation (a stray "?").
// Same threshold as #streamSpeechDetected, so gating feeds exactly the
// recordings that were going to be transcribed anyway.
const SPEECH_RMS_THRESHOLD = 0.003
// Onset detection scans each 500ms capture chunk in short frames instead of
// trusting its whole-chunk average: the first chunk of an utterance is mostly
// leading silence, which dilutes a soft first word below the gate. Averaging
// would discard that chunk and clip the start of the sentence, so instead a
// single speech-level frame keeps the whole chunk. 20ms @ 16kHz.
const ONSET_FRAME_SAMPLES = 320
// Tail of pre-speech audio fed once speech starts, so a word onset that
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
  partialText = $state('')
  readonly rmsRef = { current: 0 }

  #cancelled = false
  #maxDurationTimeout: number | null = null
  #streamCapture: PcmCapture | null = null
  #streamId: string | null = null
  #streamPartialUnsub: (() => void) | null = null
  #streamSpeechDetected = false
  #streamPreRoll: Float32Array = new Float32Array()
  #streamFinishing = false
  #recordingStartedAtMs: number | null = null
  #recordingStartedAtIso: string | null = null
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
  onIdle: (() => void) | null = null

  constructor(getVadSilenceMs: () => number, getVadMinSpeechMs: () => number = () => 0) {
    this.#getVadSilenceMs = getVadSilenceMs
    this.#getVadMinSpeechMs = getVadMinSpeechMs
  }

  async start(): Promise<void> {
    if (this.state !== 'idle' || this.starting) return
    this.starting = true
    this.#setError(null, null)
    this.#cancelled = false

    analytics.voiceRecordingStarted()

    let stream: MediaStream
    try {
      stream = await requestMicrophoneStream()
    } catch (err) {
      const info = microphoneErrorInfo(err)
      this.#setError(info.message, info.kind)
      this.starting = false
      return
    }

    if (!supportsStreamingTranscription()) {
      stream.getTracks().forEach((track) => track.stop())
      this.#setError('Streaming voice input is not supported in this environment.', 'unsupported')
      this.starting = false
      return
    }

    await this.#startStreaming(stream)
  }

  stop(): void {
    this.#cancelled = false
    if (this.#streamId) {
      void this.#finishStreaming(false)
      return
    }
  }

  cancel(): void {
    this.#cancelled = true
    if (this.#streamId) {
      void this.#finishStreaming(true)
      return
    }
  }

  toggle(): void {
    if (this.state === 'recording') this.stop()
    else if (this.state === 'idle') void this.start()
  }

  clearError(): void {
    this.#setError(null, null)
  }

  async #startStreaming(stream: MediaStream): Promise<void> {
    let streamId: string
    try {
      const started = await window.solus.voiceStreamStart()
      streamId = started.streamId
    } catch (err: any) {
      stream.getTracks().forEach((track) => track.stop())
      this.#setError(`Voice failed: ${err.message ?? String(err)}`, 'transient')
      this.starting = false
      return
    }

    this.#streamId = streamId
    this.#streamFinishing = false
    this.partialText = ''
    this.#streamSpeechDetected = false
    this.#streamPreRoll = new Float32Array()
    this.#streamPartialUnsub = window.solus.onVoicePartial((event) => {
      if (event.streamId !== this.#streamId) return
      if (event.error) {
        this.#setError(`Voice failed: ${event.error}`, 'transient')
        return
      }
      this.partialText = event.fullText
    })

    let silenceMs = 0
    let speechMs = 0
    const capture = new PcmCapture(stream, (chunk) => {
      if (this.state !== 'recording' || this.#streamId !== streamId) return
      this.#handleStreamChunk(streamId, chunk)
      const rmsForVad = chunk.rms * 128
      if (rmsForVad > VAD_SILENCE_THRESHOLD) {
        speechMs += chunk.samples.length / 16
        silenceMs = 0
      } else if (speechMs >= this.#getVadMinSpeechMs()) {
        silenceMs += chunk.samples.length / 16
        // partialText lags the audio by up to one decode pass, so the
        // punctuation gate is what keeps us from cutting on a mid-sentence
        // pause: only a completed-looking sentence earns the shorter silence.
        const vadSilenceMs = this.#getVadSilenceMs()
        const threshold = TERMINAL_PUNCTUATION.test(this.partialText)
          ? Math.min(vadSilenceMs, EARLY_ENDPOINT_SILENCE_MS)
          : vadSilenceMs
        if (silenceMs >= threshold) this.stop()
      }
    })
    this.#streamCapture = capture

    try {
      await capture.start()
    } catch (err: any) {
      window.solus.voiceStreamCancel(streamId)
      this.#cleanupStreaming()
      stream.getTracks().forEach((track) => track.stop())
      this.#setError(`Voice failed: ${err.message ?? String(err)}`, 'transient')
      this.starting = false
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
    }, STREAM_MAX_RECORDING_MS)
  }

  #handleStreamChunk(streamId: string, chunk: PcmChunk): void {
    this.rmsRef.current = chunk.rms * 128
    if (!this.#streamSpeechDetected) {
      if (!containsSpeech(chunk.samples)) {
        this.#streamPreRoll = keepTail(this.#streamPreRoll, chunk.samples, PRE_ROLL_SAMPLES)
        return
      }
      this.#streamSpeechDetected = true
      if (this.#streamPreRoll.length > 0) {
        window.solus.voiceStreamAudio(streamId, this.#streamPreRoll)
        this.#streamPreRoll = new Float32Array()
      }
    }
    window.solus.voiceStreamAudio(streamId, chunk.samples)
  }

  async #finishStreaming(cancelled: boolean): Promise<void> {
    const streamId = this.#streamId
    if (!streamId || this.#streamFinishing) return
    this.#streamFinishing = true
    const recordingStartedAtMs = this.#recordingStartedAtMs
    const recordingStartedAtIso = this.#recordingStartedAtIso
    const listeningMs = recordingStartedAtMs === null
      ? null
      : Math.round(performance.now() - recordingStartedAtMs)
    const hadSpeech = this.#streamSpeechDetected
    this.#recordingStartedAtMs = null
    this.#recordingStartedAtIso = null
    this.#clearMaxDurationTimeout()
    this.#streamCapture?.stop()
    this.#streamCapture = null

    if (cancelled || !hadSpeech) {
      window.solus.voiceStreamCancel(streamId)
      this.#cleanupStreaming()
      this.#toIdle()
      return
    }

    this.state = 'transcribing'
    const transcribeStartedAt = performance.now()
    try {
      const result = await window.solus.voiceStreamEnd(streamId)
      this.#logDevTranscriptionSession({
        transcript: result.transcript,
        startedAtIso: recordingStartedAtIso,
        listeningMs,
        transcribeMs: Math.round(performance.now() - transcribeStartedAt),
        success: !result.error,
      })
      if (result.error) {
        this.#setError(`Voice failed: ${result.error}`, 'transient')
      } else if (result.transcript) {
        this.#setError(null, null)
        this.onTranscript?.(result.transcript)
      }
    } catch (err: any) {
      this.#setError(`Voice failed: ${err.message ?? String(err)}`, 'transient')
    } finally {
      this.#cleanupStreaming()
      this.#toIdle()
    }
  }

  #clearMaxDurationTimeout(): void {
    if (this.#maxDurationTimeout) {
      clearTimeout(this.#maxDurationTimeout)
      this.#maxDurationTimeout = null
    }
  }

  #cleanupStreaming(): void {
    this.#streamPartialUnsub?.()
    this.#streamPartialUnsub = null
    this.#streamId = null
    this.#streamCapture = null
    this.#streamSpeechDetected = false
    this.#streamPreRoll = new Float32Array()
    this.#streamFinishing = false
    this.partialText = ''
  }

  #toIdle(): void {
    this.state = 'idle'
    this.onIdle?.()
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

async function requestMicrophoneStream(): Promise<MediaStream> {
  const unsupportedMessage = microphoneUnsupportedMessage()
  if (unsupportedMessage) throw new MicrophoneUnsupportedError(unsupportedMessage)

  const modernGetUserMedia =
    navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
  if (modernGetUserMedia) return modernGetUserMedia({ audio: true })

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
  if (typeof MediaRecorder === 'undefined') {
    return 'Audio recording is not supported in this browser.'
  }

  return null
}

function supportsStreamingTranscription(): boolean {
  return typeof window.solus.voiceStreamStart === 'function' &&
    typeof window.solus.voiceStreamAudio === 'function' &&
    typeof window.solus.voiceStreamEnd === 'function' &&
    typeof window.solus.voiceStreamCancel === 'function' &&
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
