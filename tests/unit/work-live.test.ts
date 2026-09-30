import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { base64ToBytes, bytesToBase64, type WorkLiveOpenResult } from '@solus/contracts/work-live'
import { readDiagramFromY, writeDiagramToY } from '@solus/contracts/diagram-live'
import { DOCUMENT_SCHEMA_VERSION } from '@solus/document-model/schema'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { ResourceRole } from '@solus/contracts/sharing'
import type { Principal } from '@solus/server/admission/principal'
import { resetTestDatabase } from './helpers/test-db'

/**
 * Live editing on the host (docs/plans/work-review-and-live-editing.md, phase 3b):
 * an acknowledged push survives a restart and applies once; the room hears it;
 * a read sees it before the projection timer; and a writer outside the live doc
 * never overwrites edits it did not see.
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type Published = { clientIds: readonly string[]; type: keyof HostEventMap; payload: unknown }

let dataDir: string
const previousDataDir = process.env.SOLUS_DATA_DIR
let works: typeof import('@solus/server/data/works/works')
let workModule: typeof import('@solus/server/data/works/work')
let liveModule: typeof import('@solus/server/work-live/work-live-manager')
let codec: typeof import('@solus/server/work-live/live-codec')
let bridge: typeof import('@solus/server/data/works/work-live-bridge')
let uninstall: (() => void) | null = null

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-work-live-'))
  process.env.SOLUS_DATA_DIR = dataDir
  works = await import('@solus/server/data/works/works')
  workModule = await import('@solus/server/data/works/work')
  liveModule = await import('@solus/server/work-live/work-live-manager')
  codec = await import('@solus/server/work-live/live-codec')
  bridge = await import('@solus/server/data/works/work-live-bridge')
})

afterEach(async () => {
  uninstall?.()
  uninstall = null
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

/** A clock the test runs by hand, so projection timing is deterministic. */
function manualSchedule() {
  const timers = new Set<{ run: () => void }>()
  return {
    schedule: (run: () => void) => {
      const timer = { run }
      timers.add(timer)
      return () => { timers.delete(timer) }
    },
    fireAll: () => { for (const timer of [...timers]) { timers.delete(timer); timer.run() } },
  }
}

function manager() {
  const published: Published[] = []
  const clock = manualSchedule()
  const live = new liveModule.WorkLiveManager({
    publish: (clientIds, type, payload) => { published.push({ clientIds, type, payload }) },
    schedule: clock.schedule,
  })
  uninstall = bridge.installWorkLiveBridge(live.bridge())
  return { live, published, clock }
}

/** A client's copy of the live doc, opened on the host. */
async function openClient(live: InstanceType<typeof liveModule.WorkLiveManager>, clientId: string, workId: string, options: { canEdit?: boolean; schemaVersion?: number; principal?: Principal } = {}) {
  const doc = new Y.Doc()
  const result = await live.open({
    clientId, scope: 'local', canEdit: options.canEdit ?? true, principal: options.principal,
    request: { workId, clientKey: `key-${clientId}`, schemaVersion: options.schemaVersion ?? DOCUMENT_SCHEMA_VERSION, stateVector: bytesToBase64(Y.encodeStateVector(doc)) },
  })
  if (result.mode !== 'unsupported') Y.applyUpdate(doc, base64ToBytes(result.update))
  return { doc, result }
}

/** The update a client makes by changing its copy to `markdown`. */
function editTo(doc: Y.Doc, markdown: string): string {
  const updates: Uint8Array[] = []
  const listener = (update: Uint8Array) => updates.push(update)
  doc.on('update', listener)
  codec.absorbIntoLiveDoc('doc', doc, markdown, 'client')
  doc.off('update', listener)
  return bytesToBase64(Y.mergeUpdates(updates))
}

describe('pushes', () => {
  test('a push is stored before it is acknowledged, relayed to the room, and a resent push applies once', async () => {
    const work = await works.createWork('local', 'Spec', 'doc', '# Spec\n\nFirst.', '', undefined, 'claude-code')
    const { live, published } = manager()
    const alice = await openClient(live, 'alice', work.id)
    const bob = await openClient(live, 'bob', work.id)
    expect(codec.projectLiveDoc('doc', bob.doc)).toBe('# Spec\n\nFirst.')

    const update = editTo(alice.doc, '# Spec\n\nFirst, edited.')
    expect(await live.push({ clientId: 'alice', author: null, request: { workId: work.id, clientKey: 'key-alice', seq: 1, update } })).toEqual({ status: 'accepted', seq: 1 })
    const relayed = published.filter((event) => event.type === 'workLive.update')
    expect(relayed.map((event) => event.clientIds)).toEqual([['bob']])
    Y.applyUpdate(bob.doc, base64ToBytes((relayed[0]!.payload as HostEventMap['workLive.update']).update))
    expect(codec.projectLiveDoc('doc', bob.doc)).toBe('# Spec\n\nFirst, edited.')

    // A lost answer makes the client send again: the host applies it once.
    expect(await live.push({ clientId: 'alice', author: null, request: { workId: work.id, clientKey: 'key-alice', seq: 1, update } })).toEqual({ status: 'duplicate', seq: 1 })
    expect(published.filter((event) => event.type === 'workLive.update')).toHaveLength(1)

    // A restarted host has the edit and the receipt.
    const restarted = manager()
    const again = await openClient(restarted.live, 'alice', work.id)
    expect(codec.projectLiveDoc('doc', again.doc)).toBe('# Spec\n\nFirst, edited.')
    expect(again.result.mode !== 'unsupported' && again.result.lastSeq).toBe(1)
  })

  test('a reader cannot push, and a client with another schema opens read-only', async () => {
    const work = await works.createWork('local', 'Spec', 'doc', 'Text', '', undefined, 'claude-code')
    const { live } = manager()
    const viewer = await openClient(live, 'viewer', work.id, { canEdit: false })
    expect(viewer.result).toMatchObject({ mode: 'read', reason: 'role' })
    expect(await live.push({ clientId: 'viewer', author: null, request: { workId: work.id, clientKey: 'key-viewer', seq: 1, update: editTo(viewer.doc, 'Changed') } })).toEqual({ status: 'read-only' })
    const old = await openClient(live, 'old', work.id, { schemaVersion: DOCUMENT_SCHEMA_VERSION + 1 })
    expect(old.result).toMatchObject({ mode: 'read', reason: 'schema' })
    expect(await live.push({ clientId: 'stranger', author: null, request: { workId: work.id, clientKey: 'key-stranger', seq: 1, update: editTo(viewer.doc, 'x') } })).toEqual({ status: 'not-open' })
  })

  test('artifacts are not edited live', async () => {
    const work = await works.createWork('local', 'Chart', 'artifact', '<p>hi</p>', '', undefined, 'claude-code')
    const { live } = manager()
    expect((await openClient(live, 'alice', work.id)).result).toEqual({ mode: 'unsupported' } satisfies WorkLiveOpenResult)
  })
})

describe('the readable body', () => {
  test('a read sees live edits before the projection timer, and the timer writes them too', async () => {
    const work = await works.createWork('local', 'Spec', 'doc', '# Spec\n\nFirst.', '', undefined, 'claude-code')
    const { live, clock } = manager()
    const alice = await openClient(live, 'alice', work.id)
    await live.push({ clientId: 'alice', author: { kind: 'system' }, request: { workId: work.id, clientKey: 'key-alice', seq: 1, update: editTo(alice.doc, '# Spec\n\nSecond.') } })
    const read = await works.loadWork('local', work.id)
    expect(read?.content).toBe('# Spec\n\nSecond.')
    expect(read?.contentVersion).toBe(2)
    // The timer finds nothing left to write.
    clock.fireAll()
    await Bun.sleep(0)
    expect((await works.loadWork('local', work.id))?.contentVersion).toBe(2)
  })

  test('when the last client leaves, the body is written and the doc leaves memory', async () => {
    const work = await works.createWork('local', 'Spec', 'doc', 'One', '', undefined, 'claude-code')
    const { live } = manager()
    const alice = await openClient(live, 'alice', work.id)
    await live.push({ clientId: 'alice', author: null, request: { workId: work.id, clientKey: 'key-alice', seq: 1, update: editTo(alice.doc, 'Two') } })
    live.disconnected('alice')
    await Bun.sleep(10)
    expect(live.clientsOf(work.id)).toEqual([])
    const stored = await workModule.Work.byId('local', work.id)
    expect(stored.content).toBe('Two')
  })

  test('a diagram is edited field by field and stored as its JSON', async () => {
    const work = await works.createWork('local', 'Map', 'diagram', JSON.stringify({ nodes: [{ id: 'a', label: 'A', position: { x: 0, y: 0 } }], edges: [] }), '', undefined, 'claude-code')
    const { live } = manager()
    const doc = new Y.Doc()
    const opened = await live.open({ clientId: 'alice', scope: 'local', canEdit: true, request: { workId: work.id, clientKey: 'key-alice', schemaVersion: 1, stateVector: bytesToBase64(Y.encodeStateVector(doc)) } })
    if (opened.mode === 'unsupported') throw new Error('diagram should open live')
    expect(opened.mode).toBe('edit')
    Y.applyUpdate(doc, base64ToBytes(opened.update))
    const updates: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => updates.push(update))
    const diagram = readDiagramFromY(doc)
    diagram.nodes[0]!.label = 'Gateway'
    doc.transact(() => writeDiagramToY(doc, diagram))
    await live.push({ clientId: 'alice', author: null, request: { workId: work.id, clientKey: 'key-alice', seq: 1, update: bytesToBase64(Y.mergeUpdates(updates)) } })
    expect(JSON.parse((await works.loadWork('local', work.id))!.content).nodes[0].label).toBe('Gateway')
  })
})

describe('writes from outside the live doc', () => {
  test('an agent that read before a person typed is refused; one that read after is folded into the doc for everyone', async () => {
    const work = await works.createWork('local', 'Spec', 'doc', '# Spec\n\nFirst.', '', undefined, 'claude-code')
    const { live, published } = manager()
    const alice = await openClient(live, 'alice', work.id)
    const agentRead = await works.loadWork('local', work.id)
    await live.push({ clientId: 'alice', author: null, request: { workId: work.id, clientKey: 'key-alice', seq: 1, update: editTo(alice.doc, '# Spec\n\nFirst.\n\nAlice typed this.') } })

    // Rule 12: the person's edit reached the host after the agent's read.
    const stale = workModule.Work.byId('local', work.id).then((w) => w.updateContent({ content: '# Spec\n\nAgent rewrite.', expectedContentVersion: agentRead!.contentVersion, author: { kind: 'agent', sessionId: 's1' }, reason: 'agent' }))
    await expect(stale).rejects.toMatchObject({ precondition: 'content' })
    expect(codec.projectLiveDoc('doc', alice.doc)).toContain('Alice typed this.')

    const fresh = await works.loadWork('local', work.id)
    const agentBody = '# Spec\n\nFirst.\n\nAlice typed this.\n\nThe agent added this.'
    await (await workModule.Work.byId('local', work.id)).updateContent({ content: agentBody, expectedContentVersion: fresh!.contentVersion, author: { kind: 'agent', sessionId: 's1' }, reason: 'agent' })
    const locks = published.filter((event) => event.type === 'workLive.state').map((event) => (event.payload as HostEventMap['workLive.state']).lock)
    // Each write, the refused one too, held the work and let it go.
    const agentLock = { by: { kind: 'agent', sessionId: 's1' } }
    expect(locks).toEqual([agentLock, null, agentLock, null])
    for (const event of published.filter((event) => event.type === 'workLive.update' && event.clientIds.includes('alice'))) {
      Y.applyUpdate(alice.doc, base64ToBytes((event.payload as HostEventMap['workLive.update']).update))
    }
    expect(codec.projectLiveDoc('doc', alice.doc)).toBe(agentBody)
    expect((await works.loadWork('local', work.id))?.content).toBe(agentBody)
  })

  test('a push during the agent edit lock is refused as locked, and succeeds after it', async () => {
    const work = await works.createWork('local', 'Spec', 'doc', 'Base', '', undefined, 'claude-code')
    const { live } = manager()
    const alice = await openClient(live, 'alice', work.id)
    const update = editTo(alice.doc, 'Base and more')
    let pushedDuringLock: unknown = null
    const current = await workModule.Work.byId('local', work.id)
    await live.bridge().write(work.id, { kind: 'agent', sessionId: 's1' }, async () => {
      pushedDuringLock = await live.push({ clientId: 'alice', author: null, request: { workId: work.id, clientKey: 'key-alice', seq: 1, update } })
      return (await current.updateContent({ content: 'Agent body', expectedContentVersion: current.contentVersion, author: null, reason: 'agent' })).content
    })
    expect(pushedDuringLock).toEqual({ status: 'locked' })
    expect(await live.push({ clientId: 'alice', author: null, request: { workId: work.id, clientKey: 'key-alice', seq: 1, update } })).toEqual({ status: 'accepted', seq: 1 })
  })

  test('a restore into a work with a stored live doc and no room updates the stored doc', async () => {
    const work = await works.createWork('local', 'Spec', 'doc', 'One', '', undefined, 'claude-code')
    const { live } = manager()
    const alice = await openClient(live, 'alice', work.id)
    await live.push({ clientId: 'alice', author: null, request: { workId: work.id, clientKey: 'key-alice', seq: 1, update: editTo(alice.doc, 'Two') } })
    live.disconnected('alice')
    await Bun.sleep(10)
    const saved = await workModule.Work.byId('local', work.id)
    await saved.updateContent({ content: 'Three', expectedContentVersion: saved.contentVersion, author: null, reason: 'agent' })
    const reopened = await openClient(live, 'bob', work.id)
    expect(codec.projectLiveDoc('doc', reopened.doc)).toBe('Three')
  })
})

describe('access changes', () => {
  const member = (userId: string): Principal => ({
    kind: 'org-member', userId, organizationId: 'local', organizationRole: 'member', teamIds: [], hostKind: 'managed',
    displayName: userId, deviceId: `${userId}-device`, expiresAt: Date.now() + 300_000, deviceLabel: 'Browser',
  })

  test('a share change drops who can no longer open the work and makes read-only who can no longer edit', async () => {
    // WHY: room events skip the per-event share check once a member passed it,
    // so the room itself must let go of whoever lost access.
    const work = await works.createWork('local', 'Spec', 'doc', 'Base', '', undefined, 'claude-code')
    const { live, published } = manager()
    const alice = await openClient(live, 'alice', work.id, { principal: member('alice') })
    const bob = await openClient(live, 'bob', work.id, { principal: member('bob') })
    const roles: Record<string, ResourceRole> = { alice: 'none', bob: 'viewer' }
    await live.revalidate(async (principal) => (principal.kind === 'org-member' ? roles[principal.userId] ?? 'none' : 'none'))

    expect(live.clientsOf(work.id)).toEqual(['bob'])
    expect(published.some((event) => event.type === 'workLive.awareness' && (event.payload as HostEventMap['workLive.awareness']).clientId === 'alice')).toBe(true)
    expect(await live.push({ clientId: 'alice', author: null, request: { workId: work.id, clientKey: 'key-alice', seq: 1, update: editTo(alice.doc, 'Changed') } })).toEqual({ status: 'not-open' })
    expect(await live.push({ clientId: 'bob', author: null, request: { workId: work.id, clientKey: 'key-bob', seq: 1, update: editTo(bob.doc, 'Changed') } })).toEqual({ status: 'read-only' })
  })
})
