import { afterAll, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VOICE_WARM_LEASE_MS } from '@solus/contracts/voice-stream'

const directory = mkdtempSync(join(tmpdir(), 'solus-voice-runtime-'))
mkdirSync(join(directory, 'build/transcription/bin'), { recursive: true })
writeFileSync(join(directory, 'build/transcription/bin', process.platform === 'win32' ? 'solus-transcription.exe' : 'solus-transcription'), '')
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const blockers = new Set<number>()
let nextBlocker = 1
mock.module('electron', () => ({
  app: { isPackaged: false, getAppPath: () => directory, once() {} },
  powerSaveBlocker: {
    start() { const id = nextBlocker++; blockers.add(id); return id },
    stop(id: number) { blockers.delete(id) },
    isStarted(id: number) { return blockers.has(id) },
  },
}))
mock.module('@solus/server/model-downloader', () => ({
  PARAKEET_MODEL_FILE: join(directory, 'model.gguf'),
  ensureParakeetModel: async () => directory,
  getVoiceModelStatus: () => ({ state: 'ready' }),
  isParakeetModelReady: async () => true,
}))
mock.module('@solus/server/otel', () => ({ recordOtelDuration() {} }))
mock.module('@solus/server/logger', () => ({ createLogger: () => ({ info() {}, warn() {} }) }))
const operations: string[] = []
let feedsHeld: (() => void) | null = null
const workers: FakeWorker[] = []
class FakeWorker {
  stopped = false
  constructor(_binary: string, _model: string, private onExit: () => void) { workers.push(this) }
  async request(operation: string) {
    operations.push(operation)
    if (operation === 'feed' && feedsHeld) await new Promise<void>(resolve => { feedsHeld = resolve })
    return { error: null, transcript: operation === 'finish' || operation === 'batch' ? 'complete' : null, stable: 'stable', tentative: ' tentative' }
  }
  stop() { this.stopped = true; this.onExit() }
}
mock.module('@solus/desktop-main/transcription/native-worker', () => ({ NativeVoiceWorker: FakeWorker }))

const voice = await import('@solus/desktop-main/transcription')

test('a stream belongs to its client, blocks batch inference, and holds power until finish', async () => {
  await voice.prepareTranscriptionModel()
  expect(workers).toHaveLength(0)
  let ended = 0
  const streamId = await voice.startVoiceStream('client-a', () => { ended++ })
  expect(blockers.size).toBe(1)
  expect(await voice.transcribeAudio(Float32Array.of(0))).toEqual({ error: 'Voice transcription is already in progress', transcript: null })
  await expect(voice.feedVoiceStream('client-b', streamId, Float32Array.of(0))).rejects.toThrow('no longer active')
  expect(await voice.feedVoiceStream('client-a', streamId, Float32Array.of(0))).toEqual({ stable: 'stable', tentative: ' tentative' })
  expect(await voice.finishVoiceStream('client-a', streamId)).toEqual({ error: null, transcript: 'complete' })
  expect(blockers.size).toBe(0)
  expect(ended).toBe(1)
  expect(operations).toEqual(['begin', 'feed', 'finish'])
  voice.disposeTranscription()
})

test('cancel releases power and prevents an old stream from reaching its successor', async () => {
  const first = await voice.startVoiceStream('client-a', () => {})
  voice.cancelVoiceStream('client-a', first)
  expect(blockers.size).toBe(0)
  const second = await voice.startVoiceStream('client-a', () => {})
  expect(second).not.toBe(first)
  expect(() => voice.cancelVoiceStream('client-a', first)).toThrow('no longer active')
  expect(blockers.size).toBe(1)
  voice.cancelVoiceStream('client-a', second)
  expect(blockers.size).toBe(0)
  voice.disposeTranscription()
})

test('a worker exit releases the active recording and calls its cleanup once', async () => {
  let ended = 0
  await voice.startVoiceStream('client-a', () => { ended++ })
  workers.at(-1)!.stop()
  expect(blockers.size).toBe(0)
  expect(ended).toBe(1)
  voice.disposeTranscription()
  expect(ended).toBe(1)
})

// Advance the host's timers directly: no real idle waits or polling.
function clock() {
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const tasks = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>()
  let now = 0
  globalThis.setTimeout = ((run: () => void, delay = 0) => {
    const timer = originalSet(() => {}, 1_000_000_000)
    tasks.set(timer, { at: now + delay, run })
    return timer
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    tasks.delete(timer)
    originalClear(timer)
  }) as typeof clearTimeout
  return {
    advance(ms: number) {
      const through = now + ms
      for (;;) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > through) break
        now = next[1].at
        tasks.delete(next[0])
        originalClear(next[0])
        next[1].run()
      }
      now = through
    },
    restore() {
      voice.disposeTranscription()
      for (const timer of tasks.keys()) originalClear(timer)
      globalThis.setTimeout = originalSet
      globalThis.clearTimeout = originalClear
    },
  }
}

test('voice mode retains one worker beyond normal idle without holding power', async () => {
  const time = clock()
  try {
    await voice.warmTranscription('client-a', { keepWarm: true })
    const current = workers.at(-1)!
    const count = workers.length
    for (let i = 0; i < 5; i++) {
      time.advance(60_000)
      await voice.warmTranscription('client-a', { keepWarm: true })
    }
    expect(current.stopped).toBe(false)
    expect(workers.length).toBe(count)
    expect(blockers.size).toBe(0)
    await voice.warmTranscription('client-a', { keepWarm: false })
    time.advance(voice.TRANSCRIPTION_WORKER_IDLE_MS - 1)
    expect(current.stopped).toBe(false)
    time.advance(1)
    expect(current.stopped).toBe(true)
  } finally { time.restore() }
})

test('releasing one client cannot remove another client voice-mode hold', async () => {
  const time = clock()
  try {
    await voice.warmTranscription('client-a', { keepWarm: true })
    await voice.warmTranscription('client-b', { keepWarm: true })
    const current = workers.at(-1)!
    await voice.warmTranscription('client-a', { keepWarm: false })
    for (let i = 0; i < 3; i++) {
      time.advance(60_000)
      await voice.warmTranscription('client-b', { keepWarm: true })
    }
    expect(current.stopped).toBe(false)
    // An abruptly lost client's last hold expires, then normal idle cleanup runs.
    time.advance(VOICE_WARM_LEASE_MS + voice.TRANSCRIPTION_WORKER_IDLE_MS)
    expect(current.stopped).toBe(true)
  } finally { time.restore() }
})

test('one-off warm requests retain the existing idle timeout', async () => {
  const time = clock()
  try {
    await voice.warmTranscription('client-a')
    const current = workers.at(-1)!
    time.advance(voice.TRANSCRIPTION_WORKER_IDLE_MS)
    expect(current.stopped).toBe(true)
  } finally { time.restore() }
})

test('concurrent preparation shares one request and active capture accepts renewals', async () => {
  const time = clock()
  try {
    const count = operations.length
    await Promise.all([
      voice.warmTranscription('client-a', { keepWarm: true }),
      voice.warmTranscription('client-b', { keepWarm: true }),
    ])
    expect(operations.slice(count)).toEqual(['warm'])
    const streamId = await voice.startVoiceStream('client-a', () => {})
    const during = operations.length
    await voice.warmTranscription('client-a', { keepWarm: true })
    expect(operations.length).toBe(during)
    await voice.finishVoiceStream('client-a', streamId)
    expect(blockers.size).toBe(0)
  } finally { time.restore() }
})
