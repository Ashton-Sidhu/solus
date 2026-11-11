import { expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'
import type { VoiceDictionary } from '@solus/contracts/voice-dictionary'

// Drive the real composer effects. No window, app process, or microphone is opened.
test('a desktop recording survives hiding; a browser retains its cancel-on-hide policy', async () => {
  const runes = new SvelteRunes()
  try {
    const harnessPath = runes.module('voice-harness', `
      export { flushSync } from 'svelte'
      export function mount(fn) { return $effect.root(fn) }
      export const shell = $state({ visible: true })
      export const hosts = $state({ device: {}, transcription: { voiceReady: true, transcribes: true } })
      export const dictation = $state({
        messageOwner: 'composer', mode: 'message', state: 'recording', starting: false,
        error: null, errorKind: null, focusedTarget: null, cancels: 0,
        cancel() { this.cancels++; this.state = 'idle' },
        claimMessageConsumer() { return true }, releaseMessageConsumer() {},
        startConversational() {}, toggleConversationalFor() {},
      })
      const theme = { voiceModeEnabled: false, autoSendVoiceTranscripts: false }
      export const getSettingsContext = () => theme
      export const getWorkspaceContext = () => ({ ui: { unifiedPickerOpen: false } })
      export const getClientShellContext = () => shell
      export const isDictationTarget = () => false
      export const useKeybinding = () => {}
      export const requestInputFocus = () => {}
      export const toasts = { error() {} }
      export class VoiceRetryTracker { reset() {} note() {} canRetry() { return true } }
    `)
    const source = runes.source('composer-voice', 'packages/workspace-ui/src/components/input/lib/composer-voice.svelte.ts', {
      '../../../contexts': harnessPath,
      '../../../lib/dictation.svelte': harnessPath,
      '../../../lib/keybindings/use-keybinding.svelte': harnessPath,
      '../../../lib/inputFocus': harnessPath,
      '../../../lib/toasts': harnessPath,
      './voice-retry.svelte': harnessPath,
    })
    const harness = await import(harnessPath)
    const { useComposerVoice } = await import(source)
    const dispose = harness.mount(() => useComposerVoice({
      ownerId: 'composer', active: () => true, isPrimary: () => true,
      isReadOnly: () => false, isConnecting: () => false, isBusy: () => false,
      text: () => '', editor: () => null, sendPrompt: () => false,
    }))
    harness.flushSync()
    harness.shell.visible = false
    harness.flushSync()
    expect(harness.dictation.state).toBe('recording')
    expect(harness.dictation.cancels).toBe(0)
    // Restore, then run the same visibility transition on a web client.
    harness.shell.visible = true
    harness.hosts.device = null
    harness.flushSync()
    harness.shell.visible = false
    harness.flushSync()
    expect(harness.dictation.state).toBe('idle')
    expect(harness.dictation.cancels).toBe(1)
    dispose()
  } finally { runes.dispose() }
})

test('streaming previews text before silence stops recording and commits only the final transcript', async () => {
  const runes = new SvelteRunes()
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const workletDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode')
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } } })
    Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class {} })
    const harnessPath = runes.module('capture-harness', `
      export const track = () => {}
      export const disposePcmCaptureResources = async () => {}
      export class PcmCapture {
        static current
        constructor(stream, onChunk, onLevel) { this.emit = onChunk; this.level = onLevel; PcmCapture.current = this }
        async start() {} stop() {}
      }
      export const calls = { fed: 0, finished: 0, offline: 0 }
      export function observePartial(recorder, notify) {
        return $effect.root(() => { $effect(() => notify(recorder.partialTranscript)) })
      }
      export const api = {
        async warmTranscription() {},
        async voiceStreamStart() { return { streamId: 'stream' } },
        async voiceStreamFeed(request) { calls.fed += request.samples.length; return { stable: 'kept ', tentative: 'record' } },
        async voiceStreamFinish() { calls.finished++; return { error: null, transcript: 'kept recording' } },
        async voiceStreamCancel() {},
        async transcribeAudio() { calls.offline++; return { error: null, transcript: 'offline' } },
        async logVoiceTranscription() {},
      }
      export const serverConnections = { apiFor() { return api } }
      export const hosts = { transcription: { id: 'device', capabilityRecord: { voiceStreaming: true } } }
    `)
    const source = runes.source('voice-recorder', 'packages/workspace-ui/src/lib/voice-recorder.svelte.ts', {
      '@solus/contracts/voice-dictionary': SvelteRunes.file('packages/contracts/src/voice-dictionary.ts'),
      '@solus/contracts/voice-audio': SvelteRunes.file('packages/contracts/src/voice-audio.ts'),
      './voice-stream': SvelteRunes.file('packages/workspace-ui/src/lib/voice-stream.ts'),
      './analytics': harnessPath,
      './pcm-capture': harnessPath,
      '@solus/client-core/server-connections': harnessPath,
      '../contexts/hosts/hosts.svelte': harnessPath,
      'zod': SvelteRunes.file('node_modules/zod/index.js'),
    })
    const harness = await import(harnessPath)
    const { VoiceRecorder } = await import(source)
    const recorder = new VoiceRecorder(() => 1500)
    let completed!: () => void
    const idle = new Promise<void>(resolve => { completed = resolve })
    const transcripts: string[] = []
    recorder.onTranscript = (text: string) => { transcripts.push(text) }
    recorder.onIdle = completed
    await recorder.start()
    expect(recorder.state).toBe('recording')
    const capture = harness.PcmCapture.current
    capture.level(0.05)
    expect(recorder.rmsRef.current).toBeCloseTo(6.4)
    let partialReceived!: () => void
    const partial = new Promise<void>(resolve => { partialReceived = resolve })
    const stopObserving = harness.observePartial(recorder, (value: { tentative: string }) => {
      if (value.tentative) partialReceived()
    })
    capture.emit({ samples: new Float32Array(4000).fill(0.1), rms: 0.1 })
    expect(recorder.rmsRef.current).toBeCloseTo(6.4)
    await partial
    stopObserving()
    expect(recorder.partialTranscript).toEqual({ stable: 'kept ', tentative: 'record' })
    expect(recorder.state).toBe('recording')
    expect(transcripts).toEqual([])
    for (let i = 0; i < 5; i++) capture.emit({ samples: new Float32Array(4000), rms: 0 })
    expect(recorder.state).toBe('recording')
    capture.emit({ samples: new Float32Array(4000), rms: 0 })
    await idle
    expect(recorder.state).toBe('idle')
    expect(recorder.rmsRef.current).toBe(0)
    capture.level(0.2)
    expect(recorder.rmsRef.current).toBe(0)
    expect(transcripts).toEqual(['kept recording'])
    expect(recorder.partialTranscript).toEqual({ stable: '', tentative: '' })
    expect(harness.calls).toEqual({ fed: 28_000, finished: 1, offline: 0 })
    recorder.dispose()
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else Reflect.deleteProperty(globalThis, 'navigator')
    if (workletDescriptor) Object.defineProperty(globalThis, 'AudioWorkletNode', workletDescriptor)
    else Reflect.deleteProperty(globalThis, 'AudioWorkletNode')
    runes.dispose()
  }
})

test('recordings and failed-clip retries retain their original hints and replacements', async () => {
  const runes = new SvelteRunes()
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const workletDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode')
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } } })
    Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class {} })
    const harnessPath = runes.module('retry-harness', `
      export const track = () => {}
      export const disposePcmCaptureResources = async () => {}
      export class PcmCapture {
        static current
        constructor(stream, onChunk) { this.emit = onChunk; PcmCapture.current = this }
        async start() {} stop() {}
      }
      export const started = []
      export const retries = []
      export const api = {
        async warmTranscription() {},
        async voiceStreamStart(options) { started.push(options); return { streamId: 'stream' } },
        async voiceStreamFeed() { return { stable: '', tentative: 'soul us' } },
        async voiceStreamFinish() { return { error: 'Stream lost', transcript: null } },
        async voiceStreamCancel() {},
        async transcribeAudio(samples, options) {
          retries.push(options)
          return retries.length === 1 ? { error: 'Offline', transcript: null } : { error: null, transcript: 'soul us' }
        },
        async logVoiceTranscription() {},
      }
      export const serverConnections = { apiFor() { return api } }
      export const hosts = { transcription: { id: 'device', capabilityRecord: { voiceStreaming: true } } }
    `)
    const source = runes.source('retry-recorder', 'packages/workspace-ui/src/lib/voice-recorder.svelte.ts', {
      '@solus/contracts/voice-dictionary': SvelteRunes.file('packages/contracts/src/voice-dictionary.ts'),
      '@solus/contracts/voice-audio': SvelteRunes.file('packages/contracts/src/voice-audio.ts'),
      './voice-stream': SvelteRunes.file('packages/workspace-ui/src/lib/voice-stream.ts'),
      './analytics': harnessPath, './pcm-capture': harnessPath,
      '@solus/client-core/server-connections': harnessPath,
      '../contexts/hosts/hosts.svelte': harnessPath,
      'zod': SvelteRunes.file('node_modules/zod/index.js'),
    })
    const harness = await import(harnessPath)
    const { VoiceRecorder } = await import(source)
    let dictionary: VoiceDictionary = [{ term: 'Solus', aliases: ['soul us'] }]
    const recorder = new VoiceRecorder(() => 1500, () => 0, () => dictionary)
    const transcripts: string[] = []
    recorder.onTranscript = (text: string) => transcripts.push(text)
    let settled!: () => void
    const idle = new Promise<void>(resolve => { settled = resolve })
    recorder.onIdle = settled
    await recorder.start()
    // Mutate the original list as well as replacing the settings object. Neither
    // change can reach the active capture or its later retry.
    dictionary[0].term = 'Changed'
    dictionary[0].aliases[0] = 'changed'
    dictionary = [{ term: 'New', aliases: ['soul us'] }]
    harness.PcmCapture.current.emit({ samples: new Float32Array(4000).fill(0.1), rms: 0.1 })
    recorder.stop()
    await idle
    expect(recorder.error).toBe('Offline')
    await recorder.start()
    expect(harness.started).toEqual([{ vocabulary: ['Solus'] }])
    expect(harness.retries).toEqual([{ vocabulary: ['Solus'] }, { vocabulary: ['Solus'] }])
    expect(transcripts).toEqual(['Solus'])
    recorder.dispose()
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    else Reflect.deleteProperty(globalThis, 'navigator')
    if (workletDescriptor) Object.defineProperty(globalThis, 'AudioWorkletNode', workletDescriptor)
    else Reflect.deleteProperty(globalThis, 'AudioWorkletNode')
    runes.dispose()
  }
})
