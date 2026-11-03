import { expect, test } from 'bun:test'
import { VoiceStreamSession, type VoiceStreamApi } from '@solus/workspace-ui/lib/voice-stream'
import { voiceStreamFeedSchema } from '@solus/contracts/voice-stream'

const streamId = 'd69aff07-f085-4bca-8613-29bab2b4ad31'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('feeds stay ordered across model startup and finish waits for all audio', async () => {
  const started = deferred<{ streamId: string }>()
  const calls: string[] = []
  const firstFeed = deferred<{ stable: string; tentative: string }>()
  const feedStarted = deferred<void>()
  const api: VoiceStreamApi = {
    voiceStreamStart: () => started.promise,
    voiceStreamFeed: async request => {
      calls.push(`feed:${request.samples[0]}`)
      if (calls.length === 1) { feedStarted.resolve(); return firstFeed.promise }
      return { stable: '', tentative: '' }
    },
    voiceStreamFinish: async () => { calls.push('finish'); return { error: null, transcript: 'all audio' } },
    voiceStreamCancel: async () => { calls.push('cancel') },
  }
  const stream = new VoiceStreamSession(api)
  stream.feed(Float32Array.of(0.25))
  stream.feed(Float32Array.of(0.5))
  const result = stream.finish()
  expect(calls).toEqual([])
  started.resolve({ streamId })
  await feedStarted.promise
  expect(calls).toEqual(['feed:0.25'])
  firstFeed.resolve({ stable: 'all', tentative: ' audio' })
  expect(await result).toEqual({ error: null, transcript: 'all audio' })
  expect(calls).toEqual(['feed:0.25', 'feed:0.5', 'finish'])
})

test('cancelling during model startup cancels the eventual stream without sending audio', async () => {
  const started = deferred<{ streamId: string }>()
  const cancelled = deferred<string>()
  const stream = new VoiceStreamSession({
    voiceStreamStart: () => started.promise,
    voiceStreamFeed: async () => { throw new Error('Cancelled audio must never be sent') },
    voiceStreamFinish: async () => { throw new Error('Cancelled recording must never finish') },
    voiceStreamCancel: async request => { cancelled.resolve(request.streamId) },
  })
  stream.feed(Float32Array.of(0.25))
  stream.cancel()
  started.resolve({ streamId })
  expect(await cancelled.promise).toBe(streamId)
  await expect(stream.finish()).rejects.toThrow('cancelled')
})

test('a failed feed releases the stream before allowing the full-clip retry', async () => {
  const cancelled = deferred<void>()
  const cancellationStarted = deferred<void>()
  let finished = false
  const stream = new VoiceStreamSession({
    voiceStreamStart: async () => ({ streamId }),
    voiceStreamFeed: async () => { throw new Error('device failed') },
    voiceStreamFinish: async () => { throw new Error('Failed stream must not finalize') },
    voiceStreamCancel: async () => { cancellationStarted.resolve(); await cancelled.promise },
  })
  stream.feed(Float32Array.of(0.25))
  const result = stream.finish().catch(error => { finished = true; return error.message })
  await cancellationStarted.promise
  expect(finished).toBe(false)
  cancelled.resolve()
  expect(await result).toBe('device failed')
})

test('slow inference has bounded buffering and cancels instead of growing indefinitely', async () => {
  const started = deferred<{ streamId: string }>()
  const cancelled = deferred<void>()
  const stream = new VoiceStreamSession({
    voiceStreamStart: () => started.promise,
    voiceStreamFeed: async () => { throw new Error('Backlogged audio must not be sent') },
    voiceStreamFinish: async () => ({ error: null, transcript: 'unexpected' }),
    voiceStreamCancel: async () => { cancelled.resolve() },
  })
  for (let i = 0; i < 11; i++) stream.feed(new Float32Array(16_000))
  started.resolve({ streamId })
  await cancelled.promise
  await expect(stream.finish()).rejects.toThrow('could not keep up')
})

test('wire audio accepts bounded finite PCM only', () => {
  expect(voiceStreamFeedSchema.safeParse({ streamId, samples: [0, -1, 1] }).success).toBe(true)
  for (const samples of [[], [NaN], [Infinity], [1.1], new Array(16_001).fill(0)])
    expect(voiceStreamFeedSchema.safeParse({ streamId, samples }).success).toBe(false)
})
