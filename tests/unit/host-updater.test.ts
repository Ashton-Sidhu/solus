import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { ServerUpdateOperation } from '@solus/contracts/server-update'
import { updateNoticeText, updateSummaryText } from '@solus/workspace-ui/contexts/updates/host-update-text'

// The updater takes its installers from the fixture; the real ones load the whole host setup.
mock.module('@solus/workspace-ui/components/servers/host-setup.store.svelte', () => ({ hostSetupStore: {} }))

declare global { var $state: <T>(value: T) => T }
const originalState = globalThis.$state
beforeEach(() => { globalThis.$state = <T>(value: T): T => value })
afterEach(() => { globalThis.$state = originalState })

async function fixture() {
  const { HostUpdater } = await import('@solus/workspace-ui/contexts/updates/host-updater.svelte')
  const calls: string[] = []
  const providerFailures = new Map<string, string>()
  const operations = new Map<string, ServerUpdateOperation>()
  const held: Array<() => void> = []
  let holdProviders = false
  const updater = new HostUpdater({
    installProvider: async (serverId, agent) => {
      calls.push(`${serverId}:${agent}`)
      if (holdProviders) await new Promise<void>((done) => { held.push(done) })
      return providerFailures.get(`${serverId}:${agent}`) ?? null
    },
    installSolus: async (serverId) => {
      calls.push(`${serverId}:solus`)
      operations.set(serverId, { operationId: `op-${serverId}`, version: '2.0.0', phase: 'waiting' })
      return null
    },
    cancelSolus: async () => null,
    operationFor: (serverId) => operations.get(serverId),
  })
  return {
    updater, calls, providerFailures, operations,
    hold: () => { holdProviders = true },
    releaseNext: async () => { held.shift()?.(); await settle() },
  }
}

/** Lets every queued promise step run. */
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve() }

test('a host updates its providers before Solus, because the Solus update restarts the host', async () => {
  const f = await fixture()
  f.hold()
  const running = f.updater.update([
    { serverId: 'mac', target: 'solus', version: '2.0.0' },
    { serverId: 'mac', target: 'claude', version: '1.2.0' },
  ])
  await settle()
  expect(f.calls).toEqual(['mac:claude'])
  await f.releaseNext()
  await running
  expect(f.calls).toEqual(['mac:claude', 'mac:solus'])
})

test('asking again for an update that is queued or running does not start it twice', async () => {
  // WHY: the notice, the palette, and a Settings row can all ask for the same
  // release; a second install of one CLI on one host only fights the first.
  const f = await fixture()
  f.hold()
  const claude = { serverId: 'mac', target: 'claude', version: '1.2.0' } as const
  const first = f.updater.update([claude, claude])
  const second = f.updater.update([claude])
  await settle()
  await f.releaseNext()
  await Promise.all([first, second])
  expect(f.calls).toEqual(['mac:claude'])
  expect(f.updater.items).toHaveLength(1)
})

test('updates asked for separately on one host still run one at a time', async () => {
  // WHY: two provider CLIs can share an installer. Two Settings rows pressed in
  // turn must not run two installs on the host at once.
  const f = await fixture()
  f.hold()
  const claude = f.updater.update([{ serverId: 'mac', target: 'claude', version: '1.2.0' }])
  const codex = f.updater.update([{ serverId: 'mac', target: 'codex', version: '0.9.0' }])
  const otherHost = f.updater.update([{ serverId: 'box', target: 'codex', version: '0.9.0' }])
  await settle()
  expect(f.calls).toEqual(['mac:claude', 'box:codex'])
  await f.releaseNext()
  await f.releaseNext()
  expect(f.calls).toEqual(['mac:claude', 'box:codex', 'mac:codex'])
  await f.releaseNext()
  await Promise.all([claude, codex, otherHost])
})

test('nothing more starts on a host while Solus updates it', async () => {
  const f = await fixture()
  await f.updater.update([{ serverId: 'mac', target: 'solus', version: '2.0.0' }])
  await f.updater.update([
    { serverId: 'mac', target: 'solus', version: '2.0.0' },
    { serverId: 'mac', target: 'codex', version: '0.9.0' },
  ])
  expect(f.calls).toEqual(['mac:solus'])
  f.operations.set('mac', { operationId: 'op-mac', version: '2.0.0', phase: 'succeeded' })
  await f.updater.update([{ serverId: 'mac', target: 'codex', version: '0.9.0' }])
  expect(f.calls).toEqual(['mac:solus', 'mac:codex'])
})

test('the batch is not settled until the Solus update finishes after its restart', async () => {
  // WHY: the host accepts the request long before it has updated; a result at
  // the request would claim an update that may still fail.
  const f = await fixture()
  await f.updater.update([{ serverId: 'mac', target: 'solus', version: '2.0.0' }])
  expect(f.updater.isSettled).toBe(false)
  expect(f.updater.isUpdating('mac', 'solus')).toBe(true)
  f.operations.set('mac', { operationId: 'op-mac', version: '2.0.0', phase: 'restarting' })
  expect(f.updater.isSettled).toBe(false)
  f.operations.set('mac', { operationId: 'op-mac', version: '2.0.0', phase: 'failed', message: 'Disk full' })
  expect(f.updater.isSettled).toBe(true)
  expect(f.updater.outcomeOf(f.updater.items[0])).toEqual({ phase: 'failed', error: 'Disk full' })
})

test('one failure does not stop the others, and the batch ends only when reported', async () => {
  const f = await fixture()
  f.providerFailures.set('mac:claude', 'npm exited with 1')
  await f.updater.update([
    { serverId: 'mac', target: 'claude', version: '1.2.0' },
    { serverId: 'mac', target: 'codex', version: '0.9.0' },
    { serverId: 'box', target: 'codex', version: '0.9.0' },
  ])
  expect(f.updater.items.map((item) => f.updater.outcomeOf(item).phase)).toEqual(['failed', 'succeeded', 'succeeded'])
  expect(f.updater.isSettled).toBe(true)
  f.updater.finish()
  expect(f.updater.items).toEqual([])
})

test('several pending updates read as one notice that names each of them', () => {
  expect(updateNoticeText([{ target: 'claude', version: '1.2.0', host: 'Mac' }])).toEqual({ message: 'Claude Code 1.2.0 on Mac is available' })
  expect(updateNoticeText([
    { target: 'solus', version: '2.0.0', host: 'Box' },
    { target: 'codex', version: '0.9.0', host: 'Mac' },
  ])).toEqual({ message: '2 updates available', description: 'Solus 2.0.0 on Box · Codex 0.9.0 on Mac' })
})

test('the result counts successes and names every failure', () => {
  const ok = { phase: 'succeeded' } as const
  expect(updateSummaryText([
    { target: 'claude', version: '1.2.0', host: 'Mac', outcome: ok },
    { target: 'codex', version: '0.9.0', host: 'Mac', outcome: ok },
  ])).toEqual({ hasFailed: false, message: '2 updates installed' })
  expect(updateSummaryText([
    { target: 'claude', version: '1.2.0', host: 'Mac', outcome: ok },
    { target: 'solus', version: '2.0.0', host: 'Box', outcome: { phase: 'failed', error: 'Cancelled.' } },
  ])).toEqual({ hasFailed: true, message: '1 of 2 updates failed', description: 'Solus on Box: Cancelled.' })
})
