import { afterAll, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
