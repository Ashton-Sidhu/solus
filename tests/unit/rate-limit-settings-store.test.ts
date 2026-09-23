import { afterEach, expect, mock, test } from 'bun:test'
import type { HostConfigSnapshot, RateLimitBehavior } from '@solus/contracts/host-config'
import { DEFAULT_HOST_CONFIG } from '@solus/contracts/host-config'

const snapshot = (behavior: RateLimitBehavior): HostConfigSnapshot => ({
  seeded: true, config: { ...DEFAULT_HOST_CONFIG, rateLimitBehavior: behavior },
})
const values = new Map<string, RateLimitBehavior>()
const listeners = new Map<string, (snapshot: HostConfigSnapshot) => void>()
let statusListener: (hostId: string, status: string) => void
let read: (hostId: string) => Promise<HostConfigSnapshot> = async (hostId) => snapshot(values.get(hostId) ?? 'ask')
let write: (hostId: string, behavior: RateLimitBehavior) => Promise<HostConfigSnapshot> = async (hostId, behavior) => {
  values.set(hostId, behavior)
  return snapshot(behavior)
}

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    apiFor: (hostId: string) => ({
      configGet: () => read(hostId),
      configUpdate: (patch: { rateLimitBehavior: RateLimitBehavior }) => write(hostId, patch.rateLimitBehavior),
    }),
    eventsFor: (hostId: string) => ({
      subscribe: (_topic: string, listener: (snapshot: HostConfigSnapshot) => void) => {
        listeners.set(hostId, listener)
        return () => { listeners.delete(hostId) }
      },
    }),
    onStatusChange: (listener: typeof statusListener) => { statusListener = listener; return () => {} },
  },
}))
const { RateLimitSettingsStore } = await import('@solus/workspace-ui/components/settings/rate-limit-settings.store.svelte')

afterEach(() => {
  values.clear()
  listeners.clear()
  read = async (hostId) => snapshot(values.get(hostId) ?? 'ask')
  write = async (hostId, behavior) => { values.set(hostId, behavior); return snapshot(behavior) }
})

test('saves only to the selected host and receives other client changes', async () => {
  const store = new RateLimitSettingsStore()
  values.set('a', 'queue')
  values.set('b', 'stop')
  const stop = store.watch('a')
  await Promise.all([store.load('a'), store.load('b')])
  await store.save('b', 'continue')
  expect(store.states.get('a')?.behavior).toBe('queue')
  expect(values.get('a')).toBe('queue')
  expect(values.get('b')).toBe('continue')
  listeners.get('a')!(snapshot('ask'))
  expect(store.states.get('a')?.behavior).toBe('ask')
  expect(store.states.get('b')?.behavior).toBe('continue')
  stop()
})

test('a newer host event wins over an old read and an old save response', async () => {
  const store = new RateLimitSettingsStore()
  const stop = store.watch('a')
  await store.load('a')
  let resolveRead!: (value: HostConfigSnapshot) => void
  read = () => new Promise((resolve) => { resolveRead = resolve })
  const loading = store.load('a')
  listeners.get('a')!(snapshot('stop'))
  resolveRead(snapshot('ask'))
  await loading
  expect(store.states.get('a')?.behavior).toBe('stop')

  let resolveSave!: (value: HostConfigSnapshot) => void
  write = () => new Promise((resolve) => { resolveSave = resolve })
  const saving = store.save('a', 'queue')
  listeners.get('a')!(snapshot('continue'))
  resolveSave(snapshot('queue'))
  await saving
  expect(store.states.get('a')?.behavior).toBe('continue')
  expect(store.states.get('a')?.saving).toBe(false)
  stop()
})

test('disconnect clears stale values and reconnect reloads the host choice', async () => {
  const store = new RateLimitSettingsStore()
  const stop = store.watch('a')
  await store.load('a')
  statusListener('a', 'disconnected')
  expect(store.states.get('a')?.behavior).toBeNull()
  values.set('a', 'queue')
  statusListener('a', 'connected')
  await Promise.resolve()
  expect(store.states.get('a')?.behavior).toBe('queue')
  expect(store.states.get('a')?.error).toBe('')
  stop()
})

test('failed saves keep the confirmed choice and can recover with a reload', async () => {
  const store = new RateLimitSettingsStore()
  await store.load('a')
  write = async () => { throw new Error('offline') }
  await store.save('a', 'queue')
  expect(store.states.get('a')?.behavior).toBe('ask')
  expect(store.states.get('a')?.saving).toBe(false)
  expect(store.states.get('a')?.error).toContain('Could not save')
  await store.load('a')
  expect(store.states.get('a')?.error).toBe('')
})
