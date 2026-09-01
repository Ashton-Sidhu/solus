import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { HostApi } from '@solus/client-core/host-api'
import type { HostCapabilities, VoiceModelStatus } from '@solus/contracts/types'

// VoiceModelStore is a runes class; outside the Svelte compiler `$state` and
// `$derived` are identity functions (same shim as the PrsStore tests).
interface RuneGlobals {
  $state?: unknown
  $derived?: unknown
}
const previousState = (globalThis as unknown as RuneGlobals).$state
const previousDerived = (globalThis as unknown as RuneGlobals).$derived

let capabilities: HostCapabilities = {}

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    defaultServerId: () => 'host',
    capabilitiesFor: async () => capabilities,
  },
}))

beforeEach(() => {
  ;(globalThis as unknown as RuneGlobals).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  ;(globalThis as unknown as RuneGlobals).$derived = Object.assign(
    <T>(value: T) => value,
    { by: <T>(fn: () => T) => fn() },
  )
})

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as RuneGlobals).$state
  else (globalThis as unknown as RuneGlobals).$state = previousState
  if (previousDerived === undefined) delete (globalThis as unknown as RuneGlobals).$derived
  else (globalThis as unknown as RuneGlobals).$derived = previousDerived
})

function statusApi(status: VoiceModelStatus): Pick<HostApi, 'voiceModelStatus'> {
  return { voiceModelStatus: async () => status }
}

describe('VoiceModelStore support', () => {
  // Only the desktop main process registers `voiceModelStatus`, so a client
  // talking to a standalone server can never transcribe. The mic must be absent
  // there, not a disabled button blaming a download that never started.
  test('marks a host without the voiceModel capability unsupported', async () => {
    capabilities = { voiceModel: false }
    const { VoiceModelStore } = await import('@solus/workspace-ui/contexts/app/voice-model.store.svelte')
    const store = new VoiceModelStore()

    await store.refreshFor('host', statusApi({ state: 'ready' }))

    expect(store.supported).toBe(false)
    expect(store.supportedFor('host')).toBe(false)
  })

  // A model that is still downloading or failed is a different state: the host
  // can transcribe, so the mic stays and explains itself.
  test('keeps a capable host supported even while its model is not ready', async () => {
    capabilities = { voiceModel: true }
    const { VoiceModelStore } = await import('@solus/workspace-ui/contexts/app/voice-model.store.svelte')
    const store = new VoiceModelStore()

    await store.refreshFor('host', statusApi({ state: 'downloading', receivedBytes: 1, totalBytes: 4 }))

    expect(store.supported).toBe(true)
    expect(store.status.state).toBe('downloading')
  })

  // Before any host has answered, assume support: flashing the mic out of a
  // desktop composer on every boot is worse than the rare late hide.
  test('assumes support for a host that has not reported yet', async () => {
    const { VoiceModelStore } = await import('@solus/workspace-ui/contexts/app/voice-model.store.svelte')
    const store = new VoiceModelStore()

    expect(store.supported).toBe(true)
    expect(store.supportedFor('unknown-host')).toBe(true)
  })
})
