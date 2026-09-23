import { afterAll, expect, mock, test } from 'bun:test'
import type { BrowserRuntimeStatus } from '@solus/contracts/browser-runtime'

// Store tests exercise host routing and stale replies. Svelte compiles the
// proxy in the client build; these tests need only the underlying values.
const originalState = Object.getOwnPropertyDescriptor(globalThis, '$state')
Object.defineProperty(globalThis, '$state', { configurable: true, value: <T>(value: T): T => value })
afterAll(() => {
  if (originalState) Object.defineProperty(globalThis, '$state', originalState)
  else Reflect.deleteProperty(globalThis, '$state')
})

const ready: BrowserRuntimeStatus = { phase: 'ready', message: 'Ready' }
let read: (hostId: string) => Promise<BrowserRuntimeStatus> = async () => ready
const installs: string[] = []
let connectionChanged: (hostId: string, status: string) => void
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    apiFor: (hostId: string) => ({
      browserRuntimeStatus: () => read(hostId),
      browserRuntimeInstall: async () => { installs.push(hostId); return ready },
    }),
    onStatusChange: (listener: typeof connectionChanged) => { connectionChanged = listener; return () => {} },
  },
}))
const { BrowserRuntimeStore } = await import('@solus/workspace-ui/components/connections/browser-runtime.store.svelte')

test('installation is addressed to the selected host', async () => {
  const store = new BrowserRuntimeStore()
  await store.refresh('remote-host', true)
  expect(installs).toEqual(['remote-host'])
  expect(store.entries.get('remote-host')?.status?.phase).toBe('ready')
  expect(store.entries.has('local')).toBe(false)
})

test('disconnect invalidates an old status reply and reconnect reads current host state', async () => {
  const store = new BrowserRuntimeStore()
  const stop = store.watch('remote-host')
  await store.refresh('remote-host')
  let resolve!: (status: BrowserRuntimeStatus) => void
  read = () => new Promise((done) => { resolve = done })
  const pending = store.refresh('remote-host')
  connectionChanged('remote-host', 'disconnected')
  resolve({ phase: 'installing', message: 'Old reply' })
  await pending
  expect(store.entries.get('remote-host')?.error).toContain('disconnected')
  expect(store.entries.get('remote-host')?.status?.phase).toBe('ready')
  read = async () => ready
  connectionChanged('remote-host', 'connected')
  await Promise.resolve()
  expect(store.entries.get('remote-host')?.error).toBe('')
  stop()
})

test('leaving host settings rejects a late reply', async () => {
  const store = new BrowserRuntimeStore()
  let resolve!: (status: BrowserRuntimeStatus) => void
  read = () => new Promise((done) => { resolve = done })
  const stop = store.watch('host')
  stop()
  resolve(ready)
  await Promise.resolve()
  expect(store.entries.get('host')?.status).toBeNull()
  read = async () => ready
})
