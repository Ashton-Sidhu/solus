import { expect, test, spyOn } from 'bun:test'
import { UpdateStatusService } from '@solus/server/updates/update-status-service'
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'

function fixture() {
  let now = 0
  let installed = '1.0.0'
  let failClaude = false
  const calls: string[] = []
  const published: HostUpdateStatus[] = []
  const service = new UpdateStatusService({
    currentVersion: '1.0.0', install: 'managed', now: () => now,
    latest: async (target) => {
      calls.push(target)
      if (target === 'claude' && failClaude) throw new Error('Registry unavailable')
      return { version: '2.0.0', url: 'https://example.com/release' }
    },
    providerVersion: async () => installed,
    publish: (status) => { published.push(status) },
  })
  return { service, calls, published, advance: () => { now += 60_000 }, upgrade: () => { installed = '2.0.0' }, fail: () => { failClaude = true } }
}

test('one client cannot trigger repeated registry requests inside one minute', async () => {
  const f = fixture()
  await Promise.all([f.service.check(), f.service.check()])
  await f.service.check()
  expect(f.calls).toHaveLength(3)
  f.advance()
  await f.service.check()
  expect(f.calls).toHaveLength(6)
  expect(f.published[0]?.check.kind).toBe('checking')
  expect(f.service.status.check.kind).toBe('available')
})

test('a failed registry keeps its last release and does not block the other checks', async () => {
  const f = fixture()
  await f.service.check()
  f.fail()
  f.advance()
  await f.service.check()
  expect(f.service.status.providers[0]?.check).toMatchObject({ kind: 'error', latestVersion: '2.0.0' })
  expect(f.service.status.providers[1]?.check.kind).toBe('available')
  expect(f.service.status.check.kind).toBe('available')
})

test('install completion bypasses the manual limit and removes the update action', async () => {
  const f = fixture()
  await f.service.check()
  f.upgrade()
  await f.service.providerInstalled('claude')
  expect(f.service.status.providers[0]?.installedVersion).toBe('2.0.0')
  expect(f.service.status.providers[0]?.check.kind).toBe('up-to-date')
  expect(f.calls).toHaveLength(4)
})

test('desktop and source installs do not ask for a separate Solus update', async () => {
  for (const install of ['desktop', 'source'] as const) {
    const calls: string[] = []
    const service = new UpdateStatusService({ currentVersion: '1.0.0', install,
      latest: async (target) => { calls.push(target); return { version: '2.0.0', url: 'https://example.com' } },
      providerVersion: async () => null, publish: () => {},
    })
    await service.check()
    expect(calls).toEqual([])
    expect(service.status.check.kind).toBe('idle')
    expect(service.status.providers[0]?.check).toEqual({ kind: 'idle', reason: 'Not installed' })
  }
})

test('version read failures settle as errors without blocking other providers', async () => {
  const service = new UpdateStatusService({ currentVersion: '1.0.0', install: 'source',
    latest: async () => ({ version: '2.0.0', url: 'https://example.com' }),
    providerVersion: async (agent) => { if (agent === 'claude') throw new Error('Version read timed out'); return '2.0.0' },
    publish: () => {},
  })
  await service.check()
  expect(service.status.providers[0]?.check).toMatchObject({ kind: 'error', message: 'Version read timed out' })
  expect(service.status.providers[1]?.check.kind).toBe('up-to-date')
})

test('checks start after ten seconds, repeat every four hours, and stop with the host', () => {
  const first = spyOn(globalThis, 'setTimeout')
  const interval = spyOn(globalThis, 'setInterval')
  const clearFirst = spyOn(globalThis, 'clearTimeout')
  const clearIntervalTimer = spyOn(globalThis, 'clearInterval')
  const f = fixture()
  try {
    f.service.start()
    f.service.start()
    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith(expect.any(Function), 10_000)
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 4 * 60 * 60 * 1_000)
    expect(first.mock.results[0]?.value.hasRef()).toBe(false)
    expect(interval.mock.results[0]?.value.hasRef()).toBe(false)
    f.service.stop()
    expect(clearFirst).toHaveBeenCalledWith(first.mock.results[0]?.value)
    expect(clearIntervalTimer).toHaveBeenCalledWith(interval.mock.results[0]?.value)
  } finally {
    f.service.stop()
    first.mockRestore()
    interval.mockRestore()
    clearFirst.mockRestore()
    clearIntervalTimer.mockRestore()
  }
})

test('an install finishing during a check gets a new version read after that check', async () => {
  let finishOldRead!: (version: string) => void
  let reads = 0
  const service = new UpdateStatusService({ currentVersion: '1.0.0', install: 'source',
    latest: async () => ({ version: '2.0.0', url: 'https://example.com' }),
    providerVersion: async (agent) => {
      if (agent === 'codex') return null
      reads += 1
      if (reads === 1) return new Promise((resolve) => { finishOldRead = resolve })
      return '2.0.0'
    }, publish: () => {},
  })
  const checking = service.check()
  const installed = service.providerInstalled('claude')
  finishOldRead('1.0.0')
  await Promise.all([checking, installed])
  expect(reads).toBe(2)
  expect(service.status.providers[0]?.installedVersion).toBe('2.0.0')
  expect(service.status.providers[0]?.check.kind).toBe('up-to-date')
})
