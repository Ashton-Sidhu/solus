import { expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'
import { VOICE_WARM_RENEW_MS, voiceWarmRequestSchema } from '@solus/contracts/voice-stream'

test('warm requests accept explicit acquisition and release only', () => {
  expect(voiceWarmRequestSchema.parse({ keepWarm: true })).toEqual({ keepWarm: true })
  expect(voiceWarmRequestSchema.parse({ keepWarm: false })).toEqual({ keepWarm: false })
  expect(voiceWarmRequestSchema.optional().parse(undefined)).toBeUndefined()
  for (const value of [{}, { keepWarm: 'false' }, { keepWarm: null }])
    expect(voiceWarmRequestSchema.safeParse(value).success).toBe(false)
})

test('one app-wide hold follows voice mode, model readiness, and the transcription host', async () => {
  const runes = new SvelteRunes()
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  const renewals = new Map<ReturnType<typeof setInterval>, () => void>()
  const delays: number[] = []
  globalThis.setInterval = ((run: () => void, delay: number) => {
    const timer = originalSet(() => {}, 1_000_000_000)
    renewals.set(timer, run)
    delays.push(delay)
    return timer
  }) as typeof setInterval
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    renewals.delete(timer)
    originalClear(timer)
  }) as typeof clearInterval
  let dispose: (() => void) | undefined
  try {
    const harnessPath = runes.module('warmth-harness', `
      export { flushSync } from 'svelte'
      export function mount(fn) { return $effect.root(fn) }
      export const settings = $state({ voiceModeEnabled: false })
      export const hosts = $state({ transcription: {
        id: 'device', voiceReady: true, capabilityRecord: { voiceStreaming: true },
      } })
      export const calls = []
      export let fail = false
      export function setFailure(value) { fail = value }
      export const serverConnections = { apiFor(hostId) { return {
        async warmTranscription(request) {
          calls.push({ hostId, ...request })
          if (fail) throw new Error('disconnected')
        },
      } } }
    `)
    const source = runes.source('voice-warmth', 'packages/workspace-ui/src/lib/voice-model-warmth.svelte.ts', {
      '@solus/client-core/server-connections': harnessPath,
      '@solus/contracts/voice-stream': SvelteRunes.file('packages/contracts/src/voice-stream.ts'),
      '../contexts/hosts/hosts.svelte': harnessPath,
    })
    const harness = await import(harnessPath)
    const { useVoiceModelWarmth } = await import(source)
    dispose = harness.mount(() => useVoiceModelWarmth(harness.settings))
    harness.flushSync()
    expect(harness.calls).toEqual([])
    harness.settings.voiceModeEnabled = true
    harness.flushSync()
    expect(harness.calls).toEqual([{ hostId: 'device', keepWarm: true }])
    expect(delays).toEqual([VOICE_WARM_RENEW_MS])
    await Promise.resolve()
    await Promise.resolve()
    for (const renew of renewals.values()) renew()
    expect(harness.calls.at(-1)).toEqual({ hostId: 'device', keepWarm: true })
    expect(harness.calls).toHaveLength(2)
    // A change of the selected transcription host releases the old host.
    harness.hosts.transcription = { id: 'remote', voiceReady: false, capabilityRecord: { voiceStreaming: true } }
    harness.flushSync()
    expect(harness.calls.at(-1)).toEqual({ hostId: 'device', keepWarm: false })
    expect(renewals.size).toBe(0)
    harness.hosts.transcription.voiceReady = true
    harness.flushSync()
    expect(harness.calls.at(-1)).toEqual({ hostId: 'remote', keepWarm: true })
    // A failed renewal is contained and retried on the next heartbeat.
    await Promise.resolve()
    await Promise.resolve()
    harness.setFailure(true)
    for (const renew of renewals.values()) renew()
    await Promise.resolve()
    await Promise.resolve()
    harness.setFailure(false)
    const count = harness.calls.length
    for (const renew of renewals.values()) renew()
    expect(harness.calls.length).toBe(count + 1)
    // Capability facts clear on disconnect. A reconnect must renew at once,
    // even when it returns to the same host and model.
    harness.hosts.transcription.capabilityRecord = undefined
    harness.flushSync()
    expect(harness.calls.at(-1)).toEqual({ hostId: 'remote', keepWarm: false })
    expect(renewals.size).toBe(0)
    harness.hosts.transcription.capabilityRecord = { voiceStreaming: true }
    harness.flushSync()
    expect(harness.calls.at(-1)).toEqual({ hostId: 'remote', keepWarm: true })
    harness.settings.voiceModeEnabled = false
    harness.flushSync()
    expect(harness.calls.at(-1)).toEqual({ hostId: 'remote', keepWarm: false })
    expect(renewals.size).toBe(0)
    harness.settings.voiceModeEnabled = true
    harness.flushSync()
    dispose()
    dispose = undefined
    expect(harness.calls.at(-1)).toEqual({ hostId: 'remote', keepWarm: false })
    expect(renewals.size).toBe(0)
  } finally {
    dispose?.()
    for (const timer of renewals.keys()) originalClear(timer)
    globalThis.setInterval = originalSet
    globalThis.clearInterval = originalClear
    runes.dispose()
  }
})
