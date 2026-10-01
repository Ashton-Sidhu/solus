import { afterEach, expect, mock, test } from 'bun:test'
import type { HostConfig, HostConfigPatch, HostConfigSnapshot } from '@solus/contracts/host-config'
import { DEFAULT_HOST_CONFIG } from '@solus/contracts/host-config'

const configs = new Map<string, HostConfig>()
const listeners = new Map<string, (snapshot: HostConfigSnapshot) => void>()
const configOf = (hostId: string): HostConfig => configs.get(hostId) ?? DEFAULT_HOST_CONFIG
let read: (hostId: string) => Promise<HostConfigSnapshot> = async (hostId) => ({ seeded: true, config: configOf(hostId) })
type LeadPatch = Pick<HostConfigPatch, 'leadInstructions' | 'workerModel'>
const saved = (hostId: string, patch: LeadPatch): HostConfigSnapshot => {
  const current = configOf(hostId)
  configs.set(hostId, {
    ...current,
    leadInstructions: patch.leadInstructions ?? current.leadInstructions,
    workerModel: patch.workerModel === undefined ? current.workerModel : patch.workerModel,
  })
  return { seeded: true, config: configOf(hostId) }
}
let write: (hostId: string, patch: LeadPatch) => Promise<HostConfigSnapshot> = async (hostId, patch) => saved(hostId, patch)

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    apiFor: (hostId: string) => ({
      configGet: () => read(hostId),
      configUpdate: (patch: LeadPatch) => write(hostId, patch),
    }),
    eventsFor: (hostId: string) => ({
      subscribe: (_topic: string, listener: (snapshot: HostConfigSnapshot) => void) => {
        listeners.set(hostId, listener)
        return () => { listeners.delete(hostId) }
      },
    }),
    onStatusChange: () => () => {},
  },
}))
const { TaskLeadSettingsStore } = await import('@solus/workspace-ui/components/settings/task-lead-settings.store.svelte')

afterEach(() => {
  configs.clear()
  listeners.clear()
  read = async (hostId) => ({ seeded: true, config: configOf(hostId) })
  write = async (hostId, patch) => saved(hostId, patch)
})

test('lead settings save to the selected host only', async () => {
  // WHY: the execution host reads its own lead settings when it builds a
  // lead's packet, so a setting saved for one host must not reach another.
  const store = new TaskLeadSettingsStore()
  await Promise.all([store.load('a'), store.load('b')])
  await store.save('b', { leadInstructions: 'Route UI work to Claude.', workerModel: { provider: 'codex', model: 'gpt-6', reasoningEffort: 'low' } })
  expect(configOf('a').leadInstructions).toBe('')
  expect(store.states.get('a')?.settings).toEqual({ leadInstructions: '', workerModel: null })
  expect(store.states.get('b')?.settings).toEqual({ leadInstructions: 'Route UI work to Claude.', workerModel: { provider: 'codex', model: 'gpt-6', reasoningEffort: 'low' } })
})

test('a failed save restores the saved value and says so', async () => {
  const store = new TaskLeadSettingsStore()
  await store.load('a')
  write = async () => { throw new Error('offline') }
  await store.save('a', { leadInstructions: 'lost' })
  expect(store.states.get('a')?.settings?.leadInstructions).toBe('')
  expect(store.states.get('a')?.error).toBe('Could not save task lead settings.')
})

test('a change from another client wins over an older read', async () => {
  const store = new TaskLeadSettingsStore()
  const stop = store.watch('a')
  await store.load('a')
  let resolveRead!: (value: HostConfigSnapshot) => void
  read = () => new Promise((resolve) => { resolveRead = resolve })
  const loading = store.load('a')
  listeners.get('a')!({ seeded: true, config: { ...DEFAULT_HOST_CONFIG, leadInstructions: 'newer' } })
  resolveRead({ seeded: true, config: DEFAULT_HOST_CONFIG })
  await loading
  expect(store.states.get('a')?.settings?.leadInstructions).toBe('newer')
  stop()
})

test('a host without lead settings says it needs an update', async () => {
  const store = new TaskLeadSettingsStore()
  const { leadInstructions: _instructions, workerModel: _worker, ...older } = DEFAULT_HOST_CONFIG
  // SAFETY: an older host's config omits keys this build's type requires.
  read = async () => ({ seeded: true, config: older as HostConfig })
  await store.load('a')
  expect(store.states.get('a')?.settings).toBeNull()
  expect(store.states.get('a')?.error).toBe('Update this host to configure task leads.')
})
