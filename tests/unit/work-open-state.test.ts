import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Work } from '@solus/contracts/types'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import { singleHostServerConnections } from './helpers/server-connections-mock'

/**
 * One open-work state model on every host (docs/plans/work-editing-foundation.md
 * §5): one saved record per work, one subscription however many panes have it
 * open, and a draft per pane that accepts newer saved bodies when clean and
 * reports a conflict when dirty. Local and cloud hosts take the same path.
 */

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))

const stateShim = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value })
type RuneHost = typeof globalThis & { $state?: typeof stateShim }
const runeHost: RuneHost = globalThis
const previousState = runeHost.$state
beforeEach(() => { connections.reset(); runeHost.$state = stateShim })
afterEach(() => {
  connections.reset()
  if (previousState === undefined) delete runeHost.$state
  else runeHost.$state = previousState
})

const T0 = Date.parse('2026-09-29T00:00:00.000Z')
function version(n: number, overrides: Partial<Work> = {}): Work {
  return {
    id: 'doc', organizationId: 'local', title: 'Plan', preview: '', type: 'doc',
    content: `v${n}`, contentVersion: n, contentHash: `hash-${n}`, contentAuthor: { kind: 'unknown' },
    createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0 + n * 1000).toISOString(),
    sessionIds: [], agentProvider: 'claude-code', cwd: '/repo',
    ...overrides,
  }
}

/** A host whose reads resolve only when the test says so, in order. */
function scriptedHost(serverId: string) {
  const reads: ((answer: Work | null | Error) => void)[] = []
  const saves: { updates: Partial<Work>; base: Pick<Work, 'updatedAt' | 'contentVersion'>; answer: (answer: Work | Error) => void }[] = []
  connections.registerHost(serverId, {
    loadWork: () => new Promise<Work | null>((resolve, reject) => {
      reads.push((answer) => (answer instanceof Error ? reject(answer) : resolve(answer)))
    }),
    saveWork: (_id: string, updates: Partial<Work>, base: Pick<Work, 'updatedAt' | 'contentVersion'>) => new Promise<Work>((resolve, reject) => {
      saves.push({ updates, base, answer: (answer) => (answer instanceof Error ? reject(answer) : resolve(answer)) })
    }),
  })
  return {
    reads,
    saves,
    /** Answer the oldest pending read and let the store apply it. */
    async answer(value: Work | null | Error) {
      const next = reads.shift()
      if (!next) throw new Error(`no read pending on ${serverId}`)
      next(value)
      await settle()
    },
    changed(work: Work, extra: { deleted?: true } = {}) {
      connections.emit(serverId, 'works.changed', { workId: work.id, version: work.updatedAt, contentVersion: work.contentVersion, ...extra })
    },
  }
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function modules() {
  const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
  const { holdWorkForPane } = await import('@solus/workspace-ui/components/work/lib/work-draft.svelte')
  const store = new WorksStore()
  let accepted = 0
  const pane = (serverIdHint?: string) => holdWorkForPane(store, 'doc', serverIdHint, () => { accepted++ })
  return { store, pane, accepted: () => accepted }
}

describe('two panes on one work', () => {
  test('share one subscription and one read; each keeps its own draft', async () => {
    const host = scriptedHost('machine')
    const { store, pane, accepted } = await modules()
    const first = pane('machine')
    const second = pane('machine')
    expect(first.work).toBe(second.work)
    expect(host.reads).toHaveLength(1)
    await host.answer(version(1))
    expect(first.draft.content).toBe('v1')
    expect(second.draft.content).toBe('v1')

    // Another writer saves: one read, both clean panes accept it.
    second.draft.setDirty(true)
    host.changed(version(2))
    host.changed(version(2))
    expect(host.reads).toHaveLength(1)
    await host.answer(version(2))
    expect(first.draft.content).toBe('v2')
    expect(accepted()).toBe(1)
    // The dirty pane keeps its edits and says the saved body moved.
    expect(second.draft.content).toBe('v1')
    expect(second.draft.conflict).toBe(true)
    expect(store.savedWork('doc')!.contentVersion).toBe(2)
  })

  test('an event for the version already held is harmless: no read, no accept', async () => {
    const host = scriptedHost('machine')
    const { pane, accepted } = await modules()
    pane('machine')
    await host.answer(version(3))
    host.changed(version(3))
    host.changed(version(2))
    expect(host.reads).toHaveLength(0)
    expect(accepted()).toBe(0)
  })

  test('a session report and works.changed for one agent write accept it once', async () => {
    const host = scriptedHost('machine')
    const { store, pane, accepted } = await modules()
    pane('machine')
    await host.answer(version(1))
    host.changed(version(2))
    store.applyRemoteUpdate('doc', 'Plan', 'v2', version(2).updatedAt, 'machine')
    expect(host.reads).toHaveLength(1)
    await host.answer(version(2))
    expect(accepted()).toBe(1)
    store.applyRemoteUpdate('doc', 'Plan', 'v2', version(2).updatedAt, 'machine')
    expect(host.reads).toHaveLength(0)
  })
})

describe('event and read races', () => {
  test('a change heard during the first read is read again after it, never lost', async () => {
    // WHY: the subscription starts before the first read, so a write that
    // commits while that read is in flight is announced to this reader.
    const host = scriptedHost('machine')
    const { store, pane } = await modules()
    const opened = pane('machine')
    host.changed(version(2))
    expect(host.reads).toHaveLength(1)
    await host.answer(version(1))
    expect(host.reads).toHaveLength(1)
    await host.answer(version(2))
    expect(opened.draft.content).toBe('v2')
    expect(store.savedWork('doc')!.contentVersion).toBe(2)
  })

  test('a late, older answer cannot replace a newer saved record', async () => {
    const host = scriptedHost('machine')
    const { store, pane } = await modules()
    pane('machine')
    await host.answer(version(4))
    store.acceptSaved(version(3), 'machine')
    expect(store.savedWork('doc')!.content).toBe('v4')
  })
})

describe('saves and edits', () => {
  test('a save names the draft\'s base; the echo of the pane\'s own save is not a conflict', async () => {
    const host = scriptedHost('machine')
    const { store, pane, accepted } = await modules()
    const opened = pane('machine')
    await host.answer(version(1))
    opened.draft.setDirty(true)
    const saving = opened.draft.save({ content: 'mine' }, (updates, expected) => store.save('doc', updates, expected))
    await settle()
    expect(host.saves[0].base).toEqual({ updatedAt: version(1).updatedAt, contentVersion: version(1).contentVersion })
    // The host commits and announces before the save's answer arrives.
    host.changed(version(2, { content: 'mine' }))
    await host.answer(version(2, { content: 'mine' }))
    expect(opened.draft.conflict).toBe(false)
    host.saves[0].answer(version(2, { content: 'mine' }))
    await saving
    expect(opened.draft.baseContentVersion).toBe(2)
    expect(opened.draft.conflict).toBe(false)
    // The editor already shows its own text; the pane never pushes it back.
    expect(accepted()).toBe(0)
  })

  test('an edit made during a save stays dirty; a newer body then is a conflict', async () => {
    const host = scriptedHost('machine')
    const { store, pane } = await modules()
    const opened = pane('machine')
    await host.answer(version(1))
    opened.draft.setDirty(true)
    const saving = opened.draft.save({ content: 'first' }, (updates, expected) => store.save('doc', updates, expected))
    await settle()
    host.saves[0].answer(version(2, { content: 'first' }))
    await saving
    // The shell reports clean only when no edit arrived meanwhile; it did.
    expect(opened.draft.dirty).toBe(true)
    host.changed(version(3))
    await host.answer(version(3))
    expect(opened.draft.conflict).toBe(true)
    expect(opened.draft.content).toBe('v1')
  })

  test('a stale save keeps the draft, reports the conflict, and refuses the next save without a request', async () => {
    const host = scriptedHost('machine')
    const { store, pane } = await modules()
    const opened = pane('machine')
    await host.answer(version(1))
    opened.draft.setDirty(true)
    const saving = opened.draft.save({ content: 'mine' }, (updates, expected) => store.save('doc', updates, expected))
    await settle()
    host.saves[0].answer(new WorkspaceRequestError(412, 'STALE_VERSION', 'changed'))
    await expect(saving).rejects.toThrow('changed since you started editing')
    expect(opened.draft.conflict).toBe(true)
    expect(host.reads).toHaveLength(1)
    await expect(opened.draft.save({ content: 'again' }, (updates, expected) => store.save('doc', updates, expected))).rejects.toThrow()
    expect(host.saves).toHaveLength(1)
    // Discarding takes the saved body and clears the conflict.
    await host.answer(version(2))
    opened.draft.discard()
    expect(opened.draft.content).toBe('v2')
    expect(opened.draft.conflict).toBe(false)
  })

  test('a rename moves only the record version: the other pane\'s draft still saves', async () => {
    const host = scriptedHost('machine')
    const { store, pane } = await modules()
    const first = pane('machine')
    const second = pane('machine')
    await host.answer(version(1))
    const renaming = first.draft.save({ title: 'Renamed' }, (updates, expected) => store.save('doc', updates, expected))
    await settle()
    const renamed = version(1, { title: 'Renamed', updatedAt: new Date(T0 + 1500).toISOString() })
    host.saves[0].answer(renamed)
    await renaming
    second.draft.setDirty(true)
    const saving = second.draft.save({ content: 'edit' }, (updates, expected) => store.save('doc', updates, expected))
    await settle()
    expect(host.saves[1].base).toEqual({ updatedAt: renamed.updatedAt, contentVersion: renamed.contentVersion })
    host.saves[1].answer(version(2, { content: 'edit' }))
    await saving
    expect(second.draft.conflict).toBe(false)
  })
})

describe('connection and access', () => {
  test('a reconnect reads the saved record again; a failed read keeps the draft and says so', async () => {
    const host = scriptedHost('machine')
    const { pane } = await modules()
    const opened = pane('machine')
    await host.answer(version(1))
    opened.draft.setDirty(true)
    connections.emitPhase('machine', 'reconnecting')
    expect(opened.work.reconnecting).toBe(true)
    expect(host.reads).toHaveLength(0)
    connections.emitPhase('machine', 'connected')
    expect(opened.work.reconnecting).toBe(false)
    await host.answer(new Error('offline'))
    expect(opened.work.status).toBe('ready')
    expect(opened.work.error).toBe('offline')
    expect(opened.draft.content).toBe('v1')
    opened.work.retry()
    await host.answer(version(2))
    expect(opened.work.error).toBeNull()
    expect(opened.draft.conflict).toBe(true)
  })

  test('removed access stops the subscription and shows unavailable; the draft stays', async () => {
    const host = scriptedHost('machine')
    const { pane } = await modules()
    const opened = pane('machine')
    await host.answer(version(1))
    opened.draft.setDirty(true)
    connections.emit('machine', 'share.changed', {
      resource: { kind: 'work', id: 'doc' }, ownerUserId: 'owner', changedBy: { id: { kind: 'account', accountId: 'owner' }, displayName: 'Owner' }, removedUserIds: ['me'],
    })
    await host.answer(new WorkspaceRequestError(403, 'FORBIDDEN', 'no'))
    expect(opened.work.status).toBe('unavailable')
    expect(opened.work.unavailableReason).toBe('no-access')
    expect(opened.draft.content).toBe('v1')
    expect(opened.draft.dirty).toBe(true)
    host.changed(version(2))
    expect(host.reads).toHaveLength(0)
  })

  test('a delete is shown at once, without a read', async () => {
    const host = scriptedHost('machine')
    const { store, pane } = await modules()
    const opened = pane('machine')
    await host.answer(version(1))
    host.changed(version(1), { deleted: true })
    expect(opened.work.status).toBe('unavailable')
    expect(opened.work.unavailableReason).toBe('deleted')
    expect(host.reads).toHaveLength(0)
    // The pane still holds what it showed.
    expect(store.savedWork('doc')!.content).toBe('v1')
  })
})

describe('Share and cleanup', () => {
  test('Share releases the machine and subscribes on the service under the same id; the draft carries over', async () => {
    const machine = scriptedHost('machine')
    const cloud = scriptedHost('cloud')
    const { store, pane } = await modules()
    const opened = pane('machine')
    await machine.answer(version(3))
    opened.draft.setDirty(true)

    store.markPublished('doc', 'org-a', 'cloud')
    expect(cloud.reads).toHaveLength(1)
    // The machine's removal of its copy is not this reader's concern any more.
    machine.changed(version(3), { deleted: true })
    expect(opened.work.status).not.toBe('unavailable')
    // The service holds the same body under its own versions.
    const published = version(1, { organizationId: 'org-a', content: 'v3', contentHash: 'hash-3', updatedAt: new Date(T0 + 9000).toISOString() })
    await cloud.answer(published)
    expect(opened.draft.conflict).toBe(false)
    const saving = opened.draft.save({ content: 'after share' }, (updates, expected) => store.save('doc', updates, expected))
    await settle()
    expect(machine.saves).toHaveLength(0)
    expect(cloud.saves[0].base).toEqual({ updatedAt: published.updatedAt, contentVersion: published.contentVersion })
    cloud.saves[0].answer(version(2, { organizationId: 'org-a', content: 'after share' }))
    await saving
    // A pane opened later with the machine in its route still binds to the service.
    const later = pane('machine')
    expect(later.work).toBe(opened.work)
    expect(opened.work.serverId).toBe('cloud')
  })

  test('the last release stops listening; a provisional work is never read', async () => {
    const host = scriptedHost('machine')
    const { store, pane } = await modules()
    const first = pane('machine')
    const second = pane('machine')
    await host.answer(version(1))
    first.close()
    host.changed(version(2))
    expect(host.reads).toHaveLength(1)
    await host.answer(version(2))
    second.close()
    host.changed(version(3))
    expect(host.reads).toHaveLength(0)

    const tempId = store.addProvisional('claude-code', '/repo', 'machine')
    const { holdWorkForPane } = await import('@solus/workspace-ui/components/work/lib/work-draft.svelte')
    const generating = holdWorkForPane(store, tempId, 'machine', () => {})
    expect(host.reads).toHaveLength(0)
    expect(generating.work.status).toBe('loading')
    generating.close()
  })
})
