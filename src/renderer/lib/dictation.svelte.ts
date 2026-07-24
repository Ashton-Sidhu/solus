import { VoiceRecorder, type VoiceErrorKind, type VoiceState } from './voice-recorder.svelte'

export type DictationTarget = HTMLInputElement | HTMLTextAreaElement

/** True when `el` is a plain text field we can dictate into at the caret. */
export function isDictationTarget(el: Element | null): el is DictationTarget {
  if (!el) return false
  if (el.tagName === 'TEXTAREA') {
    const t = el as HTMLTextAreaElement
    return !t.disabled && !t.readOnly
  }
  if (el.tagName === 'INPUT') {
    const t = el as HTMLInputElement
    if (t.disabled || t.readOnly) return false
    // Only text-like inputs hold prose and expose a caret selection.
    return ['text', 'search', 'url', 'email', ''].includes(t.type)
  }
  return false
}

/**
 * App-wide voice controller. Owns the single speech-to-text recorder (the mic
 * is single hardware) and routes its transcript by `mode`:
 *   - 'insert'  — dictation into a focused field at its caret, firing `input`
 *                 so Svelte `bind:value` updates; if the field opted into
 *                 auto-send, invokes its submit handler afterwards.
 *   - 'message' — conversational "voice mode" (InputBar): the transcript is
 *                 handed to the registered message handler to send + auto-loop.
 *
 * Only one mode records at a time; starting one yields the other (a queued
 * start waits for the recorder to settle to idle — see #requestStart / onIdle).
 */
class Dictation {
  target = $state<DictationTarget | null>(null)
  /**
   * The dictation-capable field that currently has focus, or null. Set by the
   * `Input` component on focus/blur. When non-null, auto voice mode is "owned"
   * by that field — the conversational voice recorder yields the mic so the two
   * never record at once.
   */
  focusedTarget = $state<DictationTarget | null>(null)
  /**
   * Routing of the active (or most recent) recording. 'insert' inserts the
   * transcript at a field's caret; 'message' hands it to the conversational
   * consumer (InputBar) to send. The mic is single hardware, so only one mode
   * records at a time — both InputBar and plain fields drive this one recorder.
   */
  mode = $state<'insert' | 'message'>('insert')
  /** InputBar currently routing conversational transcripts. */
  messageOwner = $state<string | null>(null)
  #onMessage: ((transcript: string) => void) | null = null
  #pendingMessageConsumer: {
    owner: string
    onMessage: (transcript: string) => void
    autoRearm: () => boolean
  } | null = null
  // A recording queued behind one we just cancelled; started when the recorder
  // settles to idle (via the recorder's onIdle hook). Serializes mic handoff.
  #pendingStart: DictationTarget | 'message' | null = null
  #submitHandlers = new WeakMap<DictationTarget, () => void>()
  #vadMinSpeechMsMap = new WeakMap<DictationTarget, number>()
  #getVadSilenceMs = () => 1500
  #getAutoEnabled = () => false
  #getVoiceReady = () => true
  // Set right before our own post-transcript `el.focus()` so the synthetic
  // focus event it fires doesn't immediately re-arm dictation in a loop.
  #justInserted = false
  // When set, called synchronously from onIdle to decide whether to re-arm
  // the mic immediately (before any Svelte render), eliminating the frame gap.
  #autoRearmFn: (() => boolean) | null = null
  #voice = new VoiceRecorder(
    () => this.#getVadSilenceMs(),
    () => this.#vadMinSpeechMsMap.get(this.target!) ?? 0,
  )

  constructor() {
    this.#voice.onTranscript = (t) => {
      if (this.mode === 'message') this.#onMessage?.(t)
      else this.#insert(t)
    }
    this.#voice.onIdle = (allowAutoRearm) => {
      const nextConsumer = this.#pendingMessageConsumer
      this.#pendingMessageConsumer = null
      if (nextConsumer) this.#applyMessageConsumer(nextConsumer)
      const pending = this.#pendingStart
      this.#pendingStart = null
      if (pending) {
        this.#applyStart(pending)
      } else if (allowAutoRearm && this.mode === 'message' && this.#autoRearmFn?.()) {
        void this.#voice.start()
      }
    }
  }

  /** Wire settings (VAD silence + auto voice mode) from the app root. */
  configure(getVadSilenceMs: () => number, getAutoEnabled: () => boolean, getVoiceReady: () => boolean = () => true): void {
    this.#getVadSilenceMs = getVadSilenceMs
    this.#getAutoEnabled = getAutoEnabled
    this.#getVoiceReady = getVoiceReady
  }

  /** True when auto voice mode is enabled (the global voice-mode setting). */
  get autoEnabled(): boolean {
    return this.#getAutoEnabled()
  }

  get state(): VoiceState {
    return this.#voice.state
  }

  get starting(): boolean {
    return this.#voice.starting
  }

  get error(): string | null {
    return this.#voice.error
  }

  get errorKind(): VoiceErrorKind {
    return this.#voice.errorKind
  }

  get rmsRef() {
    return this.#voice.rmsRef
  }

  setAutoRearm(fn: (() => boolean) | null): void {
    this.#autoRearmFn = fn
  }

  /** Set the minimum ms of speech required before the silence timer starts for `el`. */
  registerVadMinSpeechMs(el: DictationTarget, ms: number): void {
    if (ms > 0) this.#vadMinSpeechMsMap.set(el, ms)
    else this.#vadMinSpeechMsMap.delete(el)
  }

  /** Opt a field into auto-send: its handler fires after a transcript inserts. */
  registerSubmit(el: DictationTarget, onSubmit: (() => void) | undefined): void {
    if (onSubmit) this.#submitHandlers.set(el, onSubmit)
    else this.#submitHandlers.delete(el)
  }

  unregisterSubmit(el: DictationTarget): void {
    this.#submitHandlers.delete(el)
  }

  /** Start/stop dictation into `el`. */
  toggleInto(el: DictationTarget): void {
    if ((this.#voice.state === 'recording' || this.#voice.starting) && this.mode === 'insert' && this.target === el) {
      this.#voice.stop()
    } else {
      this.#requestStart(el)
    }
  }

  /** Start dictation into `el` (no-op if already recording into it). */
  startInto(el: DictationTarget): void {
    if ((this.#voice.state === 'recording' || this.#voice.starting) && this.mode === 'insert' && this.target === el) return
    this.#requestStart(el)
  }

  /** Register the active conversational consumer's transcript→message handler. */
  setMessageHandler(fn: ((transcript: string) => void) | null): void {
    this.#onMessage = fn
  }

  /**
   * Point conversational transcripts and auto-rearm at one composer. Focus may
   * move between the primary and split bars while both stay mounted, so a new
   * owner only takes over once the previous recording is idle.
   */
  claimMessageConsumer(
    owner: string,
    onMessage: (transcript: string) => void,
    autoRearm: () => boolean,
  ): boolean {
    const consumer = { owner, onMessage, autoRearm }
    const messageInFlight =
      this.mode === 'message' &&
      (this.#voice.state !== 'idle' || this.#voice.starting)
    if (messageInFlight && this.messageOwner !== null && this.messageOwner !== owner) {
      this.#pendingMessageConsumer = consumer
      return false
    }
    this.#pendingMessageConsumer = null
    this.#applyMessageConsumer(consumer)
    return true
  }

  releaseMessageConsumer(owner: string): void {
    if (this.#pendingMessageConsumer?.owner === owner) this.#pendingMessageConsumer = null
    if (this.messageOwner !== owner) return
    if (this.mode === 'message' && (this.#voice.state === 'recording' || this.#voice.starting)) {
      this.#voice.cancel()
    }
    this.messageOwner = null
    this.#onMessage = null
    this.#autoRearmFn = null
  }

  /** Start/confirm voice input for a specific composer, transferring the mic
   *  from another composer by cancelling its in-progress capture first. */
  toggleConversationalFor(
    owner: string,
    onMessage: (transcript: string) => void,
    autoRearm: () => boolean,
  ): void {
    const sameOwner = this.messageOwner === owner
    const consumer = { owner, onMessage, autoRearm }
    const recordingMessage =
      this.mode === 'message' &&
      (this.#voice.state === 'recording' || this.#voice.starting)
    if (sameOwner && recordingMessage) {
      this.#voice.stop()
      return
    }
    // Let the previous owner's transcription finish instead of rerouting its
    // result to the newly focused composer.
    if (!sameOwner && this.mode === 'message' && this.#voice.state === 'transcribing') {
      this.#pendingMessageConsumer = consumer
      this.#pendingStart = 'message'
      return
    }
    if (!sameOwner && recordingMessage) this.#voice.cancel()
    this.#pendingMessageConsumer = null
    this.#applyMessageConsumer(consumer)
    this.#requestStart('message')
  }

  #applyMessageConsumer(consumer: {
    owner: string
    onMessage: (transcript: string) => void
    autoRearm: () => boolean
  }): void {
    this.messageOwner = consumer.owner
    this.#onMessage = consumer.onMessage
    this.#autoRearmFn = consumer.autoRearm
  }

  /**
   * Start conversational recording: the transcript is handed to the message
   * handler (sent as a message) rather than inserted at a caret. Yields any
   * in-progress dictation first.
   */
  startConversational(): void {
    if ((this.#voice.state === 'recording' || this.#voice.starting) && this.mode === 'message') return
    this.#requestStart('message')
  }

  /** Toggle conversational recording (confirm if already recording). */
  toggleConversational(): void {
    if ((this.#voice.state === 'recording' || this.#voice.starting) && this.mode === 'message') this.#voice.stop()
    else this.startConversational()
  }

  #applyStart(next: DictationTarget | 'message'): void {
    if (next === 'message') {
      this.mode = 'message'
      this.target = null
    } else {
      this.mode = 'insert'
      this.target = next
    }
    void this.#voice.start()
  }

  /** Start `next` now if idle, otherwise wind down the current recording and
   *  start it once the recorder reaches idle (via onIdle → #pendingStart). */
  #requestStart(next: DictationTarget | 'message'): void {
    if (this.#voice.state === 'idle' && !this.#voice.starting) {
      this.#pendingStart = null
      this.#applyStart(next)
    } else {
      this.#pendingStart = next
      // 'transcribing' will reach idle on its own; recording/setup need a nudge.
      if (this.#voice.state === 'recording' || this.#voice.starting) this.#voice.cancel()
    }
  }

  /**
   * `el` gained focus. Tracks it as the focused dictation field and, when auto
   * voice mode is on, starts dictation so the user can just talk. Ignores the
   * synthetic focus our own post-transcript refocus fires (avoids a re-arm loop).
   */
  focusGained(el: DictationTarget): void {
    this.focusedTarget = el
    if (this.#justInserted) {
      this.#justInserted = false
      return
    }
    if (!this.autoEnabled || !this.#getVoiceReady() || !isDictationTarget(el) || this.#voice.error) return
    // Idle → start dictating. If the conversational recorder is live, yield the
    // mic to this field instead (startInto cancels it and queues the insert).
    if (this.#voice.state === 'idle' || this.mode === 'message') this.startInto(el)
  }

  /**
   * `el` lost focus. Clears the focused-field tracking unless this is the blur
   * caused by our own recording UI hiding the input mid-capture (in which case
   * the field is still logically "the one we're dictating into").
   */
  focusLost(el: DictationTarget): void {
    if (this.#voice.state === 'recording' && this.target === el) return
    if (this.focusedTarget === el) this.focusedTarget = null
  }

  /** Stop recording and transcribe (same as confirming). */
  stop(): void {
    this.#voice.stop()
  }

  /** Cancel recording, discarding any audio captured. */
  cancel(): void {
    this.#voice.cancel()
  }

  clearError(): void {
    this.#voice.clearError()
  }

  /** Release the app-wide recorder before this renderer is discarded. */
  dispose(): void {
    this.#pendingStart = null
    this.#pendingMessageConsumer = null
    this.messageOwner = null
    this.#autoRearmFn = null
    this.#onMessage = null
    this.#voice.dispose()
  }

  /** Cancel recording + drop focus tracking if `el` is ours (call on unmount). */
  releaseTarget(el: DictationTarget): void {
    if (this.target === el) this.#voice.cancel()
    if (this.focusedTarget === el) this.focusedTarget = null
  }

  #insert(transcript: string): void {
    const text = transcript.trim()
    const el = this.target
    if (!text || !el || !el.isConnected || el.disabled || el.readOnly) return

    let start: number | null
    let end: number | null
    try {
      start = el.selectionStart
      end = el.selectionEnd
    } catch {
      start = end = null
    }

    if (start === null || end === null) {
      el.value = `${el.value}${text}`
    } else {
      el.setRangeText(text, start, end, 'end')
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    this.#justInserted = true
    el.focus({ preventScroll: true })
    this.#submitHandlers.get(el)?.()
  }
}

export const dictation = new Dictation()
