import { expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'

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

test('streaming keeps the existing stop-on-silence threshold', async () => {
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
        constructor(stream, onChunk) { this.emit = onChunk; PcmCapture.current = this }
        async start() {} stop() {}
      }
      export const calls = { fed: 0, finished: 0, offline: 0 }
      export const api = {
        async warmTranscription() {},
        async voiceStreamStart() { return { streamId: 'stream' } },
        async voiceStreamFeed(request) { calls.fed += request.samples.length; return { stable: '', tentative: '' } },
        async voiceStreamFinish() { calls.finished++; return { error: null, transcript: 'kept recording' } },
        async voiceStreamCancel() {},
        async transcribeAudio() { calls.offline++; return { error: null, transcript: 'offline' } },
        async logVoiceTranscription() {},
      }
      export const serverConnections = { apiFor() { return api } }
      export const hosts = { transcription: { id: 'device', capabilityRecord: { voiceStreaming: true } } }
    `)
    const source = runes.source('voice-recorder', 'packages/workspace-ui/src/lib/voice-recorder.svelte.ts', {
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
    let transcript = ''
    recorder.onTranscript = (text: string) => { transcript = text }
    recorder.onIdle = completed
    await recorder.start()
    expect(recorder.state).toBe('recording')
    const capture = harness.PcmCapture.current
    capture.emit({ samples: new Float32Array(4000).fill(0.1), rms: 0.1 })
    for (let i = 0; i < 5; i++) capture.emit({ samples: new Float32Array(4000), rms: 0 })
    expect(recorder.state).toBe('recording')
    capture.emit({ samples: new Float32Array(4000), rms: 0 })
    await idle
    expect(recorder.state).toBe('idle')
    expect(transcript).toBe('kept recording')
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
