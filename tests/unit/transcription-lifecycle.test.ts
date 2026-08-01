import { describe, expect, jest, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { MAX_VOICE_SAMPLES } from '../../src/shared/voice-audio'

const posted: unknown[] = []
let forkCount = 0
let noteFork: (() => void) | null = null

class FakeUtilityProcess extends EventEmitter {
  emitExitOnKill = true
  killResult = true

  postMessage(message: unknown): void {
    posted.push({ worker: this, message })
  }

  kill(): boolean {
    if (this.killResult && this.emitExitOnKill) this.emit('exit', 0)
    return this.killResult
  }
}

const workers: FakeUtilityProcess[] = []

mock.module('electron', () => ({
  utilityProcess: {
    fork: () => {
      forkCount++
      noteFork?.()
      const worker = new FakeUtilityProcess()
      workers.push(worker)
      return worker
    },
  },
}))

mock.module('../../src/main/model-downloader', () => ({
  ensureParakeetModel: async () => '/tmp/model',
  getVoiceModelStatus: () => ({ state: 'ready' as const }),
  isParakeetModelReady: async () => true,
}))

mock.module('../../src/main/logger', () => ({
  createLogger: () => ({
    debug() {}, info() {}, warn() {}, error() {}, metric() {}, child() { return this },
  }),
}))

describe('transcription worker lifecycle', () => {
  test('model preparation stays process-free and concurrent inference is rejected', async () => {
    jest.useFakeTimers()
    const {
      prepareTranscriptionModel,
      transcribeAudio,
      transcriptionRequestTimeoutMs,
    } = await import('../../src/main/transcription')

    await prepareTranscriptionModel()
    expect(forkCount).toBe(0)

    expect(await transcribeAudio({ length: MAX_VOICE_SAMPLES + 1 } as Float32Array)).toEqual({
      error: 'Voice recording exceeds the 60 minute limit',
      transcript: null,
    })
    expect(forkCount).toBe(0)

    const forked = new Promise<void>((resolve) => { noteFork = resolve })
    const first = transcribeAudio(new Float32Array(16))
    await forked
    expect(forkCount).toBe(1)
    expect(posted).toHaveLength(1)

    expect(await transcribeAudio(new Float32Array(16))).toEqual({
      error: 'Voice transcription is already in progress',
      transcript: null,
    })

    const firstPost = posted[0] as { worker: FakeUtilityProcess; message: { id: number } }
    firstPost.worker.emit('message', {
      id: firstPost.message.id,
      type: 'result',
      transcript: 'bounded',
      phaseMs: {},
    })
    expect(await first).toEqual({ error: null, transcript: 'bounded' })

    // An idle generation can take time to emit `exit`. Its late exit must not
    // reject a request already assigned to the successor worker.
    firstPost.worker.emitExitOnKill = false
    jest.advanceTimersByTime(120_000)
    const secondForked = new Promise<void>((resolve) => { noteFork = resolve })
    const second = transcribeAudio(new Float32Array(16))
    await secondForked
    expect(forkCount).toBe(2)
    const secondPost = posted[1] as { worker: FakeUtilityProcess; message: { id: number } }
    firstPost.worker.emit('exit', 0)
    secondPost.worker.emit('message', {
      id: secondPost.message.id,
      type: 'result',
      transcript: 'successor',
      phaseMs: {},
    })
    expect(await second).toEqual({ error: null, transcript: 'successor' })

    // A refused kill keeps the existing generation attached rather than
    // allowing a second model process to be forked alongside it.
    secondPost.worker.killResult = false
    jest.advanceTimersByTime(120_000)
    const third = transcribeAudio(new Float32Array(16))
    await Promise.resolve()
    await Promise.resolve()
    expect(forkCount).toBe(2)
    const thirdPost = posted[2] as { worker: FakeUtilityProcess; message: { id: number } }
    expect(thirdPost.worker).toBe(secondPost.worker)
    thirdPost.worker.emit('message', {
      id: thirdPost.message.id,
      type: 'result',
      transcript: 'retained',
      phaseMs: {},
    })
    expect(await third).toEqual({ error: null, transcript: 'retained' })

    secondPost.worker.killResult = true
    secondPost.worker.emitExitOnKill = true
    const timedOut = transcribeAudio(new Float32Array(16))
    await Promise.resolve()
    await Promise.resolve()
    jest.advanceTimersByTime(transcriptionRequestTimeoutMs(16))
    expect(await timedOut).toEqual({ error: 'Transcription timed out', transcript: null })

    const replacementForked = new Promise<void>((resolve) => { noteFork = resolve })
    const replacement = transcribeAudio(new Float32Array(16))
    await replacementForked
    expect(forkCount).toBe(3)
    const replacementPost = posted[4] as { worker: FakeUtilityProcess; message: { id: number } }
    replacementPost.worker.emit('message', {
      id: replacementPost.message.id,
      type: 'result',
      transcript: 'replacement',
      phaseMs: {},
    })
    expect(await replacement).toEqual({ error: null, transcript: 'replacement' })
    jest.useRealTimers()
  })
})
