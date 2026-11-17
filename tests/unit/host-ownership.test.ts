import { afterEach, describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'
import { HOST_LIST_MAX_ENTRIES } from '@solus/contracts/host-list'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { MachineForward } from '@solus/server/remote-machines/wsl'
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { ForwardedHosts } = await import('@solus/server/remote-machines/forwarded-hosts')
const { IntroducedHosts } = await import('@solus/server/execution/orchestration/introduced-hosts')
const { readHostList, readHostRecords, saveHostConnection, hostCredential, removeHostListing, putHostListing } = await import('@solus/server/host/host-list')
const { secretStore } = await import('@solus/server/platform/secrets')
const { dataDir } = await import('@solus/server/platform/paths')
const { getDb } = await import('@solus/server/db')

const KEY = 'rwYrck6nBUw4mf9XOsblvbvv90Mz16mQW65CFiARkXM'
const BOX = { installationId: 'box', label: 'Box', target: { destination: 'ada@box' }, remotePort: 3000, identityKey: KEY, sessionToken: 'forward-token', startedBySolus: true }
const cleanups: Array<() => void> = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve() }
function harness(options: { port?: Promise<number>; open?: Promise<MachineForward> } = {}) {
  let opens = 0
  let closes = 0
  const exit = deferred<number | null>()
  const forward: MachineForward = { localPort: 50000, remotePort: 3000, exited: exit.promise, close: () => { closes++; exit.resolve(0) } }
  const timers: Array<() => void> = []
  const hosts = new ForwardedHosts({
    ssh: { forward: async () => { opens++; return options.open ?? forward } },
    remotePort: () => options.port ?? Promise.resolve(3000),
    selfInstallationId: () => 'self', onChange: () => {},
    setTimeoutFn: ((run: () => void) => { timers.push(run); return timers.length }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
  })
  cleanups.push(() => hosts.closeAll())
  return { hosts, forward, exit, timers, opens: () => opens, closes: () => closes }
}
afterEach(() => {
  for (const record of readHostRecords()) removeHostListing(record.listing.installationId)
  for (const cleanup of cleanups.splice(0)) cleanup()
  getDb().exec('DELETE FROM host_list')
})

describe('one host record owns its connections', () => {
  test('forget removes both credentials, revokes the introduction, and stops the forward across restart', async () => {
    const h = harness()
    await h.hosts.add(BOX)
    const revoked: string[] = []
    const introductions = new IntroducedHosts(fetch, Date.now, {
      installationId: () => 'self', name: () => 'Self', urls: async () => [],
      issueToken: () => ({ token: 'unused', deviceId: 'unused' }),
      revokeDevice: (deviceId) => revoked.push(deviceId), identityKey: () => KEY,
    })
    cleanups.push(() => introductions.dispose())
    saveHostConnection({ ...readHostList()[0]!, label: 'Box', routes: [] }, {
      kind: 'introduction', settings: { url: 'https://box.example', introducedAt: 1, refreshedAt: 1, grantedDeviceId: 'box-device' }, token: 'introduction-token',
    })
    expect(readHostRecords()).toHaveLength(1)
    expect(readHostRecords()[0]).toMatchObject({ forward: { remotePort: 3000 }, introduction: { grantedDeviceId: 'box-device' } })
    expect(JSON.stringify(readHostRecords())).not.toContain('-token')
    expect(JSON.stringify(readHostList())).not.toContain('sshTarget')
    // A client label update must keep both connections.
    putHostListing({ ...readHostList()[0]!, id: 'account-box', label: 'My box' })
    expect(readHostRecords()).toHaveLength(1)
    expect(getDb().prepare('SELECT id FROM host_list').get()).toMatchObject({ id: 'box' })
    expect(h.hosts.list()[0]?.label).toBe('My box')
    expect(introductions.list().hosts[0]?.label).toBe('My box')
    expect(removeHostListing('box')).toBe(true)
    expect(removeHostListing('box')).toBe(false)
    expect(h.closes()).toBe(1)
    expect(revoked).toEqual(['box-device'])
    expect(hostCredential('box', 'forward')).toBeNull()
    expect(hostCredential('box', 'introduction')).toBeNull()
    expect(readHostList()).toEqual([])
    expect(introductions.list().refused).toEqual([{ installationId: 'box', label: 'My box' }])
    const restart = harness()
    restart.hosts.start()
    await settle()
    expect(restart.opens()).toBe(0)
    expect(h.timers).toEqual([])
  })

  test('forget while the remote port is being read prevents the SSH process from starting', async () => {
    const port = deferred<number>()
    const h = harness({ port: port.promise })
    const added = h.hosts.add(BOX)
    const outcome = added.then(() => null, (error: Error) => error)
    removeHostListing('box')
    port.resolve(3000)
    expect(await outcome).toBeInstanceOf(Error)
    expect(h.opens()).toBe(0)
    expect(h.timers).toEqual([])
  })

  test('forget while the forward opens closes the late process and never restores the record', async () => {
    const open = deferred<MachineForward>()
    const h = harness({ open: open.promise })
    const added = h.hosts.add(BOX)
    const outcome = added.then(() => null, (error: Error) => error)
    await settle()
    expect(h.opens()).toBe(1)
    removeHostListing('box')
    open.resolve(h.forward)
    expect(await outcome).toBeInstanceOf(Error)
    expect(h.closes()).toBe(1)
    expect(readHostList()).toEqual([])
    expect(h.timers).toEqual([])
  })

  test('forget frees a catalog slot while its refusal still prevents restoration', () => {
    for (let index = 0; index < HOST_LIST_MAX_ENTRIES; index++) {
      const id = `host-${index}`
      putHostListing({ id, installationId: id, label: id, routes: [], lastConnected: 1 })
    }
    const extra = { id: 'extra', installationId: 'extra', label: 'Extra', routes: [], lastConnected: 1 }
    expect(() => putHostListing(extra)).toThrow('Remove one first')
    removeHostListing('host-0')
    putHostListing(extra)
    expect(readHostList()).toHaveLength(HOST_LIST_MAX_ENTRIES)
    expect(readHostRecords().find((record) => record.listing.id === 'host-0')?.forgotten).toBe(true)
  })

  test('orphaned old SSH records cannot start a connection', async () => {
    secretStore().saveJson('forwarded-hosts', join(dataDir(), 'forwarded-hosts.bin'), { hosts: [{ ...BOX, sshTarget: 'omarchy' }] })
    const h = harness()
    h.hosts.start()
    await settle()
    expect(h.opens()).toBe(0)
    expect(h.hosts.list()).toEqual([])
    expect(readHostList()).toEqual([])
    secretStore().remove('forwarded-hosts', join(dataDir(), 'forwarded-hosts.bin'))
  })
})
