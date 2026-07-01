import { blobToWavBase64 } from './audio-utils'
import { analytics } from './analytics'

const VAD_SILENCE_THRESHOLD = 8
// Hard ceiling on a single recording. The VAD silence-detector runs on the
// shared main thread and can be starved when many tabs are mounted, so it may
// fail to stop the recorder promptly. This wall-clock backstop (driven by a
// timeout, not the starvable VAD interval) bounds the captured audio so a stuck
// mic can never balloon the payload sent for transcription.
const MAX_RECORDING_MS = 60_000
const MEDIA_RECORDER_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
]
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

export class VoiceRecorder {
  state = $state<VoiceState>('idle')
  error = $state<string | null>(null)
  readonly rmsRef = { current: 0 }

  #recorder: MediaRecorder | null = null
  #cancelled = false
  #vadInterval: number | null = null
  #vadAudioCtx: AudioContext | null = null
  #maxDurationTimeout: number | null = null
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
    this.error = null
    this.#cancelled = false

    analytics.voiceRecordingStarted()

    let stream: MediaStream
    try {
      stream = await requestMicrophoneStream()
    } catch (err) {
      this.error = microphoneErrorMessage(err)
      this.starting = false
      return
    }

    let recorder: MediaRecorder
    try {
      const mimeType = supportedRecorderMimeType()
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      this.error = microphoneErrorMessage(err)
      this.starting = false
      return
    }

    const chunks: Blob[] = []

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    recorder.onstop = async () => {
      const recordingStartedAtMs = this.#recordingStartedAtMs
      const recordingStartedAtIso = this.#recordingStartedAtIso
      const listeningMs = recordingStartedAtMs === null
        ? null
        : Math.round(performance.now() - recordingStartedAtMs)
      this.#recordingStartedAtMs = null
      this.#recordingStartedAtIso = null
      if (this.#recorder === recorder) this.#recorder = null
      stream.getTracks().forEach((t) => t.stop())
      this.#cleanupVAD()
      this.#clearMaxDurationTimeout()

      if (this.#cancelled) {
        this.#toIdle()
        return
      }
      if (chunks.length === 0) {
        this.#toIdle()
        return
      }

      this.state = 'transcribing'
      const transcribeStartedAt = performance.now()
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType })
        const wavBase64 = await blobToWavBase64(blob)
        const result = await window.solus.transcribeAudio(wavBase64)
        this.#logDevTranscriptionSession({
          transcript: result.transcript,
          startedAtIso: recordingStartedAtIso,
          listeningMs,
          transcribeMs: Math.round(performance.now() - transcribeStartedAt),
          success: !result.error,
        })
        if (result.error) {
          this.error = result.error
        } else if (result.transcript) {
          this.onTranscript?.(result.transcript)
        }
      } catch (err: any) {
        if (!err.message?.includes('No voice detected'))
          this.error = `Voice failed: ${err.message}`
      }
      this.#toIdle()
    }

    recorder.onerror = () => {
      this.#recordingStartedAtMs = null
      this.#recordingStartedAtIso = null
      if (this.#recorder === recorder) this.#recorder = null
      stream.getTracks().forEach((t) => t.stop())
      this.#cleanupVAD()
      this.#clearMaxDurationTimeout()
      this.error = 'Recording failed.'
      this.#toIdle()
    }

    this.#recorder = recorder
    this.state = 'recording'
    this.starting = false
    recorder.start()
    this.#recordingStartedAtMs = performance.now()
    this.#recordingStartedAtIso = new Date().toISOString()
    if (!devVoiceSessionStats.firstStartedAtIso) {
      devVoiceSessionStats.firstStartedAtIso = this.#recordingStartedAtIso
    }
    this.#startVAD(stream)
    // Wall-clock backstop: a timeout can't be starved the way the VAD interval
    // can, so it reliably stops a runaway recording even under heavy main-thread
    // load. Treated as a normal stop, so whatever was captured still transcribes.
    this.#maxDurationTimeout = window.setTimeout(() => {
      this.#maxDurationTimeout = null
      this.stop()
    }, MAX_RECORDING_MS)
  }

  stop(): void {
    this.#cancelled = false
    if (this.#recorder?.state === 'recording') this.#recorder.stop()
  }

  cancel(): void {
    this.#cancelled = true
    this.#cleanupVAD()
    if (this.#recorder?.state === 'recording') this.#recorder.stop()
  }

  toggle(): void {
    if (this.state === 'recording') this.stop()
    else if (this.state === 'idle') void this.start()
  }

  #startVAD(stream: MediaStream): void {
    const audioCtx = new AudioContext()
    this.#vadAudioCtx = audioCtx
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    audioCtx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.frequencyBinCount)
    let silenceMs = 0,
      speechMs = 0
    // Credit each tick with the time that actually elapsed, not a flat 100ms.
    // The main thread is shared with every mounted tab's reactive work, so
    // under load `setInterval` ticks drift well past 100ms; assuming a fixed
    // 100ms under-counts silence and lets recordings run long (bigger
    // transcripts the more tabs are open).
    let lastTickAt = performance.now()

    this.#vadInterval = window.setInterval(() => {
      if (this.state !== 'recording') {
        this.#cleanupVAD()
        return
      }
      const now = performance.now()
      const deltaMs = now - lastTickAt
      lastTickAt = now
      analyser.getByteTimeDomainData(buf)
      const rms = Math.sqrt(
        buf.reduce((s, v) => s + (v - 128) ** 2, 0) / buf.length,
      )
      this.rmsRef.current = rms
      if (rms > VAD_SILENCE_THRESHOLD) {
        speechMs += deltaMs
        silenceMs = 0
      } else if (speechMs >= this.#getVadMinSpeechMs()) {
        silenceMs += deltaMs
        if (silenceMs >= this.#getVadSilenceMs()) {
          this.#cleanupVAD()
          this.stop()
        }
      }
    }, 100)
  }

  #cleanupVAD(): void {
    if (this.#vadInterval) {
      clearInterval(this.#vadInterval)
      this.#vadInterval = null
    }
    if (this.#vadAudioCtx) {
      void this.#vadAudioCtx.close()
      this.#vadAudioCtx = null
    }
  }

  #clearMaxDurationTimeout(): void {
    if (this.#maxDurationTimeout) {
      clearTimeout(this.#maxDurationTimeout)
      this.#maxDurationTimeout = null
    }
  }

  #toIdle(): void {
    this.state = 'idle'
    this.onIdle?.()
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

async function requestMicrophoneStream(): Promise<MediaStream> {
  const unsupportedMessage = microphoneUnsupportedMessage()
  if (unsupportedMessage) throw new Error(unsupportedMessage)

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

function supportedRecorderMimeType(): string | undefined {
  return MEDIA_RECORDER_MIME_TYPES.find((type) =>
    MediaRecorder.isTypeSupported(type),
  )
}

function microphoneErrorMessage(err: unknown): string {
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
      return 'Microphone permission denied.'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found.'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Microphone is already in use or unavailable.'
    case 'SecurityError':
      return 'Microphone access is blocked by browser security settings.'
    case 'NotSupportedError':
      return 'Audio recording is not supported in this browser.'
    default:
      if (message) return message
      return `Microphone error: ${String(err)}`
  }
}
