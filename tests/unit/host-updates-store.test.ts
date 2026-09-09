import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import type { ServerConnections } from '@solus/client-core/server-connections'
import type { ConnectionStatus } from '@solus/client-core/ws-transport'

declare global { var $state: <T>(value: T) => T }
const originalState = globalThis.$state
beforeEach(() => { globalThis.$state = <T>(value: T): T => value })
afterEach(() => { globalThis.$state = originalState })

function status(version: string | null): HostUpdateStatus {
  return { currentVersion: '1.0.0', install: 'tarball', remediation: null, releaseUrl: null,
    check: version ? { kind: 'available', latestVersion: version, checkedAt: 0 } : { kind: 'up-to-date', checkedAt: 0 }, providers: [] }
}

async function fixture() {
  const { HostUpdatesStore } = await import('@solus/workspace-ui/contexts/updates/host-updates.store.svelte')
  let current = status('2.0.0')
  let connected: ConnectionStatus = 'connected'
  let supports = true
  let listener: Parameters<ServerConnections['onStatusChange']>[0] = () => {}
  let read = async () => current
  const store = new HostUpdatesStore({
    resolveId: (id) => id, statusFor: () => connected, capabilitiesFor: async () => ({ hostUpdates: supports }),
    apiFor: () => ({ hostUpdateStatus: () => read(), hostCheckForUpdates: () => read() }),
    connectedServerIds: () => ['host'], onConnectionCreated: () => () => {},
    onStatusChange: (callback) => { listener = callback; return () => {} },
  })
  return { store, set: (next: HostUpdateStatus) => { current = next }, read: (next: typeof read) => { read = next },
    disconnect: () => { connected = 'reconnecting'; listener('host', connected, 1) },
    reconnect: () => { connected = 'connected'; listener('host', connected, 2) },
    unsupported: () => { supports = false },
  }
}

test('repeated broadcasts never re-arm a notice, but a newer release does', async () => {
  const { store } = await fixture()
  store.applyStatus('host', status('2.0.0'))
  const notice = store.pendingNoticeFor('host')!
  store.markNoticeShown('host', notice)
  store.applyStatus('host', status('2.0.0'))
  expect(store.pendingNoticeFor('host')).toBeNull()
  store.applyStatus('host', status('3.0.0'))
  expect(store.pendingNoticeFor('host')?.version).toBe('3.0.0')
  store.applyStatus('host', status(null))
  expect(store.pendingCountFor('host')).toBe(0)
  expect(store.pendingNoticeFor('host')).toBeNull()
})

test('only a user check earns a result notice', async () => {
  const f = await fixture()
  f.set(status(null))
  await f.store.load('host')
  expect(f.store.manualCheckOutcomeFor('host')).toBeNull()
  await f.store.check('host')
  expect(f.store.manualCheckOutcomeFor('host')).toBe('up-to-date')
  f.store.markManualCheckReported('host')
  expect(f.store.manualCheckOutcomeFor('host')).toBeNull()
})

test('a late snapshot cannot overwrite a newer broadcast', async () => {
  const f = await fixture()
  let resolve!: (value: HostUpdateStatus) => void
  f.read(() => new Promise((done) => { resolve = done }))
  const loading = f.store.load('host')
  await Promise.resolve()
  f.store.applyStatus('host', status('3.0.0'))
  resolve(status('2.0.0'))
  await loading
  expect(f.store.hostUpdateFor('host')?.check).toMatchObject({ latestVersion: '3.0.0' })
})

test('reconnect clears status and rejects a reply from the prior connection', async () => {
  const f = await fixture()
  f.store.start()
  await f.store.load('host')
  expect(f.store.hostUpdateFor('host')).toBeDefined()
  let resolve!: (value: HostUpdateStatus) => void
  f.read(() => new Promise((done) => { resolve = done }))
  const check = f.store.check('host')
  await Promise.resolve()
  f.disconnect()
  expect(f.store.hostUpdateFor('host')).toBeUndefined()
  resolve(status('2.0.0'))
  await check
  expect(f.store.hostUpdateFor('host')).toBeUndefined()
  f.read(async () => status('3.0.0'))
  f.reconnect()
  await f.store.load('host')
  expect(f.store.hostUpdateFor('host')?.check).toMatchObject({ latestVersion: '3.0.0' })
})

test('an older host is not queried for a method it does not support', async () => {
  const f = await fixture()
  f.unsupported()
  f.read(async () => { throw new Error('must not call') })
  await f.store.load('host')
  await f.store.check('host')
  expect(f.store.hostUpdateFor('host')).toBeUndefined()
  expect(f.store.errors.size).toBe(0)
})

test('a manual response cannot restore an update removed by a newer event', async () => {
  const f = await fixture()
  f.store.applyStatus('host', status('2.0.0'))
  let resolve!: (value: HostUpdateStatus) => void
  f.read(() => new Promise((done) => { resolve = done }))
  const checking = f.store.check('host')
  await Promise.resolve()
  f.store.applyStatus('host', status(null))
  resolve(status('2.0.0'))
  await checking
  expect(f.store.pendingCountFor('host')).toBe(0)
  expect(f.store.manualCheckOutcomeFor('host')).toBe('up-to-date')
})
