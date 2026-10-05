import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { DocReadHints, DocRef, NormalizedDoc, WorkExternalLink } from '@solus/contracts/docs'
import type { Attribution } from '@solus/contracts/user'
import type { WorkUpdateOpPayload } from '@solus/contracts/outbox-types'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import { resetTestDatabase } from './helpers/test-db'
import { installTestWorkspaceTools } from './helpers/workspace-tools'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'

/**
 * Every content writer names the version it read, and a writer that read an
 * older body is refused instead of overwriting a newer one
 * (docs/plans/work-editing-foundation.md §2). Temporary fixture databases only.
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/** The provider a pull reads. `read` waits on `gate`, so a test can act while the pull is in flight. */
const upstream = {
  markdown: '# From upstream',
  title: 'Upstream title',
  gate: null as Promise<void> | null,
  entered: null as (() => void) | null,
}
const adapter = {
  id: 'confluence' as const,
  status: async () => ({ provider: 'confluence' as const, connected: true }),
  destinations: async () => [],
  search: async () => [],
  read: async (ref: DocRef, _hints?: DocReadHints): Promise<NormalizedDoc> => {
    upstream.entered?.()
    await upstream.gate
    return { ref, title: upstream.title, markdown: upstream.markdown, version: '9', updatedAt: '2026-09-29T00:00:00.000Z' }
  },
  resolveUrl: () => null,
}
const actualRegistry = await import('@solus/server/docs/registry')
mock.module('@solus/server/docs/registry', () => ({ ...actualRegistry, docProviderAdapter: () => adapter }))

const PERSON: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice' } }
const LINK: WorkExternalLink = { provider: 'confluence', externalId: '1', externalKey: 'site/ENG', scope: 'ENG', url: 'https://example.atlassian.net/wiki/1', syncState: 'ok' }

const principal = { kind: 'org-member', userId: 'alice', organizationId: 'A', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Alice', deviceId: 'alice-device', deviceLabel: 'Browser', expiresAt: Date.now() + 300000 } as const
const person: WorkspaceRequestContext = { principal, home: { kind: 'organization', organizationId: 'A', serviceId: 'api' }, scopes: ['works:read', 'works:write'] }
const agent: WorkspaceRequestContext = { ...person, actingAgent: { sessionId: 'agent-session', organizationId: 'A' } }

let dataDir: string
let works: typeof import('@solus/server/data/works/works')
let workModule: typeof import('@solus/server/data/works/work')
let workSync: typeof import('@solus/server/data/works/work-sync')
let workTools: typeof import('@solus/server/execution/agents/tools/work-tools')
let outbox: typeof import('@solus/server/sync/outbox/outbox-store')
let operations: import('@solus/server/data/workspace/operations').WorkspaceOperations
let SolusServer: typeof import('@solus/server/transport/server').SolusServer
let registerFolioHandlers: typeof import('@solus/server/transport/handlers/folio-handlers').registerFolioHandlers
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-work-write-paths-'))
  process.env.SOLUS_DATA_DIR = dataDir
  works = await import('@solus/server/data/works/works')
  workModule = await import('@solus/server/data/works/work')
  workSync = await import('@solus/server/data/works/work-sync')
  workTools = await import('@solus/server/execution/agents/tools/work-tools')
  outbox = await import('@solus/server/sync/outbox/outbox-store')
  ;({ SolusServer } = await import('@solus/server/transport/server'))
  ;({ registerFolioHandlers } = await import('@solus/server/transport/handlers/folio-handlers'))
  ;(await import('@solus/server/data/works/work-applier')).registerWorkOutboxApplier()
})

beforeEach(async () => {
  await installTestWorkspaceTools()
  const [{ getDatabase }, { ShareManager }, { createWorkspaceOperations }] = await Promise.all([
    import('@solus/server/db/database'), import('@solus/server/sharing/share-manager'), import('@solus/server/data/workspace/service'),
  ])
  operations = createWorkspaceOperations(new ShareManager({ db: getDatabase() }))
  upstream.gate = null
  upstream.entered = null
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function readVersion(text: string): number {
  return Number(/content_version: (\d+)/.exec(text)?.[1])
}

async function personEdit(organizationId: string, workId: string, content: string) {
  const work = await workModule.Work.byId(organizationId, workId)
  return work.updateContent({ content, expectedContentVersion: work.contentVersion, author: PERSON, reason: 'edit' })
}

describe('agent tools', () => {
  test('update_work from a read that a person edited after is refused, and nothing is reread for it', async () => {
    // WHY: the tool used to fetch a fresh record version at write time, so a
    // person's edit made after the agent's read was silently overwritten.
    const work = await works.createWork('local', 'Spec', 'doc', '# Draft', '', undefined, 'claude-code')
    const read = await workTools.executeWorkTool('read_work', { work_id: work.id })
    const seen = readVersion(read.text)
    expect(seen).toBe(1)
    await personEdit('local', work.id, '# Person edit')

    const stale = await workTools.executeWorkTool('update_work', { work_id: work.id, content: '# Agent from old read', expected_content_version: seen })
    expect(stale.ok).toBe(false)
    expect(stale.text).toStartWith('Stale write:')
    expect(stale.text).toContain('read_work again')
    const kept = await workModule.Work.byId('local', work.id)
    expect(kept.content).toBe('# Person edit')
    expect((await kept.revisions()).map(revision => revision.reason)).toEqual(['baseline'])

    const reread = readVersion((await workTools.executeWorkTool('read_work', { work_id: work.id })).text)
    expect(reread).toBe(2)
    const updates: Array<{ contentVersion: number }> = []
    const saved = await workTools.executeWorkTool('update_work', { work_id: work.id, content: '# Agent revision', expected_content_version: reread }, { onWorkUpdated: (work) => updates.push(work) })
    expect(saved.ok).toBe(true)
    // The prefix transcripts project from is unchanged; the new version follows it.
    expect(saved.text).toStartWith('Updated "Spec".')
    expect(readVersion(saved.text)).toBe(3)
    expect(updates.map((work) => work.contentVersion)).toEqual([3])
    expect((await works.loadWork('local', work.id))?.content).toBe('# Agent revision')
  })

  test('update_work requires expected_content_version in the one definition Claude and Codex share', async () => {
    const schema = z.object(workTools.updateWorkAgentTool.inputFields)
    expect(schema.safeParse({ work_id: 'w', content: 'x' }).success).toBe(false)
    expect(schema.safeParse({ work_id: 'w', content: 'x', expected_content_version: 1 }).success).toBe(true)
    const { solusToolbox } = await import('@solus/server/execution/agents/tools/solus-toolbox')
    expect(solusToolbox.works.update).toBe(workTools.updateWorkAgentTool)
  })

  test('a diagram body that does not parse is refused by the work, whatever the caller', async () => {
    const work = await works.createWork('local', 'Map', 'diagram', '{"nodes":[],"edges":[]}', '', undefined, 'claude-code')
    const result = await workTools.executeWorkTool('update_work', { work_id: work.id, content: 'not json', expected_content_version: 1 })
    expect(result.ok).toBe(false)
    expect(result.text).toStartWith('Invalid diagram content:')
    await expect(personEdit('local', work.id, '{"nodes":1}')).rejects.toBeInstanceOf(workModule.WorkContentInvalidError)
    await expect(works.createWork('local', 'Bad', 'diagram', '[]', '', undefined, 'claude-code')).rejects.toBeInstanceOf(workModule.WorkContentInvalidError)
    expect((await works.loadWork('local', work.id))?.content).toBe('{"nodes":[],"edges":[]}')
  })
})

describe('the HTTP operations', () => {
  test('every content write names its content version; a stale one is refused beside a fresh ETag', async () => {
    const work = await operations.createWork(person, { title: 'Notes', type: 'doc', content: 'one' }, 'write-paths-create-01')
    await expect(operations.updateWork(agent, work.id, { content: 'agent' }, work.version)).rejects.toMatchObject({ status: 400 })
    const edited = await operations.updateWork(person, work.id, { content: 'person', expectedContentVersion: 1 }, work.version)
    expect(edited.contentVersion).toBe(2)
    // The record version is fresh; the content version is the agent's own read.
    await expect(operations.updateWork(agent, work.id, { content: 'agent', expectedContentVersion: 1 }, edited.version)).rejects.toMatchObject({ status: 412, code: 'STALE_VERSION' })
    const saved = await operations.updateWork(agent, work.id, { content: 'agent', expectedContentVersion: 2 }, edited.version)
    expect(saved).toMatchObject({ content: 'agent', contentVersion: 3, contentAuthor: { kind: 'agent', sessionId: 'agent-session' } })
    // A person's save names the body it read too: the record version alone is refused.
    await expect(operations.updateWork(person, work.id, { content: 'person again' }, saved.version)).rejects.toMatchObject({ status: 400 })
    expect((await operations.updateWork(person, work.id, { content: 'person again', expectedContentVersion: 3 }, saved.version)).contentVersion).toBe(4)
  })

  test('an invalid diagram is a request error, not a stored body', async () => {
    await expect(operations.createWork(person, { title: 'Map', type: 'diagram', content: '{}' }, 'write-paths-create-02')).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' })
  })
})

describe('RPC', () => {
  function server() {
    const instance = new SolusServer()
    registerFolioHandlers(instance)
    return instance
  }

  test('agentSaveWork and restoreWorkRevision refuse a body the caller did not see', async () => {
    const rpc = server()
    const work = await works.createWork('local', 'Doc', 'doc', 'first', '', undefined, 'claude-code')
    const saved = await rpc.handle('agentSaveWork', [work.id, { content: 'agent' }, 1], TEST_HANDLER_CTX)
    expect(saved.contentVersion).toBe(2)
    await expect(rpc.handle('agentSaveWork', [work.id, { content: 'late' }, 1], TEST_HANDLER_CTX)).rejects.toBeInstanceOf(workModule.WorkVersionConflictError)

    await personEdit('local', work.id, 'person')
    // Revert names the body the reader compared: the agent's, now displaced by a person's edit.
    const previousRevisionId = (await workModule.Work.byId('local', work.id)).previousRevisionId
    await expect(rpc.handle('restoreWorkRevision', [work.id, previousRevisionId, saved.contentVersion], TEST_HANDLER_CTX)).rejects.toMatchObject({ precondition: 'content' })
    expect((await works.loadWork('local', work.id))?.content).toBe('person')
    const current = await works.loadWork('local', work.id)
    // A title change moves the record version, not the body: the revert still applies.
    await (await workModule.Work.byId('local', work.id)).updateTitle({ title: 'Renamed' })
    // The previous version is the body the agent write displaced.
    const reverted = await rpc.handle('restoreWorkRevision', [work.id, previousRevisionId, current!.contentVersion], TEST_HANDLER_CTX)
    expect(reverted?.content).toBe('first')
  })

  test('History restores any checkpoint as a new version and deletes nothing', async () => {
    // WHY: phase 1 of work review — a reader can go back to any version, and
    // the version they left stays in history, so the restore itself can be undone.
    const rpc = server()
    const work = await works.createWork('local', 'Doc', 'doc', 'v1', '', undefined, 'claude-code')
    await rpc.handle('agentSaveWork', [work.id, { content: 'v2' }, 1], TEST_HANDLER_CTX)
    await rpc.handle('agentSaveWork', [work.id, { content: 'v3' }, 2], TEST_HANDLER_CTX)
    const before = await rpc.handle('loadWorkRevisions', [work.id], TEST_HANDLER_CTX)
    const first = before.find((revision) => revision.reason === 'baseline')!
    expect((await rpc.handle('loadWorkRevision', [work.id, first.revisionId], TEST_HANDLER_CTX)).content).toBe('v1')

    const restored = await rpc.handle('restoreWorkRevision', [work.id, first.revisionId, 3], TEST_HANDLER_CTX)
    expect(restored.content).toBe('v1')
    expect(restored.contentVersion).toBe(4)
    const after = await rpc.handle('loadWorkRevisions', [work.id], TEST_HANDLER_CTX)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.at(-1)?.reason).toBe('restore')
    // The body the restore displaced is still there to go back to.
    const bodies = await Promise.all(after.map(async (revision) => (await rpc.handle('loadWorkRevision', [work.id, revision.revisionId], TEST_HANDLER_CTX)).content))
    expect(bodies).toContain('v3')
  })
})

describe('outbox', () => {
  /** An op as a dispatched session records it; `expectedContentVersion` is left out to model an op from an older host. */
  function updateOp(workId: string, payload: Omit<WorkUpdateOpPayload, 'taskId' | 'expectedContentVersion'> & { expectedContentVersion?: number }) {
    return outbox.recordOutboxOp({ domain: 'works', resourceId: workId, name: 'update', payload: { taskId: 'task', ...payload }, sessionId: 'dispatched' })
  }

  test('a redelivered update is answered by its receipt: one revision, no refusal of its own advance', async () => {
    const work = await works.createWork('local', 'Doc', 'doc', 'v1', '', undefined, 'claude-code')
    const op = updateOp(work.id, { content: 'v2', expectedContentVersion: 1 })
    expect((await outbox.applyOutboxOps([op])).applied).toEqual([op.id])
    const again = await outbox.applyOutboxOps([op])
    expect(again).toEqual({ applied: [op.id], failed: [] })
    const saved = await workModule.Work.byId('local', work.id)
    expect(saved.contentVersion).toBe(2)
    expect((await saved.revisions()).map(revision => revision.reason)).toEqual(['baseline', 'agent'])
    outbox.ackOutboxOps([op.id])
  })

  test('an apply whose receipt cannot be written leaves no write behind, so the retry is not refused', async () => {
    // WHY: the receipt used to land after the applier's commit. A crash between
    // them re-ran the update on redelivery, against its own version advance.
    const { getDb } = await import('@solus/server/db')
    const work = await works.createWork('local', 'Doc', 'doc', 'v1', '', undefined, 'claude-code')
    const op = updateOp(work.id, { content: 'v2', expectedContentVersion: 1 })
    // The applier runs and writes; then the receipt insert fails.
    getDb().exec("CREATE TEMP TRIGGER receipt_unavailable BEFORE INSERT ON applied_ops BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END")
    const failed = await outbox.applyOutboxOps([op]).finally(() => getDb().exec('DROP TRIGGER receipt_unavailable'))
    expect(failed.failed[0]).toMatchObject({ id: op.id, permanent: false, error: expect.stringContaining('receipt unavailable') })
    expect((await works.loadWork('local', work.id))?.contentVersion).toBe(1)

    expect((await outbox.applyOutboxOps([op])).applied).toEqual([op.id])
    const saved = await workModule.Work.byId('local', work.id)
    expect(saved).toMatchObject({ content: 'v2', contentVersion: 2 })
    expect((await saved.revisions()).map(revision => revision.reason)).toEqual(['baseline', 'agent'])
    outbox.ackOutboxOps([op.id])
  })

  test('an op from an older read, or with no version, dead-letters and keeps the newer body', async () => {
    const work = await works.createWork('local', 'Doc', 'doc', 'v1', '', undefined, 'claude-code')
    await personEdit('local', work.id, 'person v2')
    const stale = updateOp(work.id, { content: 'agent from v1', expectedContentVersion: 1 })
    const unversioned = updateOp(work.id, { content: 'agent with no read' })
    const result = await outbox.applyOutboxOps([stale, unversioned])
    expect(result.applied).toEqual([])
    expect(result.failed.map(({ id, permanent }) => ({ id, permanent }))).toEqual([
      { id: stale.id, permanent: true },
      { id: unversioned.id, permanent: true },
    ])
    expect((await works.loadWork('local', work.id))?.content).toBe('person v2')
    outbox.ackOutboxOps([stale.id, unversioned.id])
  })

  test('an invalid diagram op dead-letters instead of retrying forever', async () => {
    const work = await works.createWork('local', 'Map', 'diagram', '{"nodes":[],"edges":[]}', '', undefined, 'claude-code')
    const op = updateOp(work.id, { content: 'not json', expectedContentVersion: 1 })
    expect((await outbox.applyOutboxOps([op])).failed[0]).toMatchObject({ id: op.id, permanent: true })
    outbox.ackOutboxOps([op.id])
  })
})

describe('upstream pull', () => {
  async function linkedWork(content = '# Local') {
    const work = await works.createWork('local', 'Linked', 'doc', content, '', undefined, 'claude-code')
    await (await workModule.Work.byId('local', work.id)).setMirroredDoc(LINK)
    return work
  }

  test('a pull that completes after a person saved keeps the save and replaces nothing', async () => {
    // WHY: the pull used to write whatever version the work had when the
    // provider answered, replacing an edit made while it was in flight.
    const work = await linkedWork()
    let release!: () => void
    upstream.gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { upstream.entered = resolve })
    const pulling = workSync.pullWorkUpstream('local', work.id)
    await entered
    await personEdit('local', work.id, '# Saved during the pull')
    release()

    const result = await pulling
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('changed while it was pulled')
    const kept = await workModule.Work.byId('local', work.id)
    expect(kept.content).toBe('# Saved during the pull')
    expect((await kept.revisions()).some(revision => revision.reason === 'upstream')).toBe(false)
    // A superseded pull is not a provider failure: the link keeps its state.
    expect(kept.mirroredDoc?.syncState).toBe('ok')
  })

  test('an undisturbed pull writes the body and the refreshed link together', async () => {
    const work = await linkedWork()
    const result = await workSync.pullWorkUpstream('local', work.id)
    expect(result.ok).toBe(true)
    const pulled = await workModule.Work.byId('local', work.id)
    expect(pulled).toMatchObject({ content: '# From upstream', title: 'Upstream title', contentVersion: 2, contentAuthor: { kind: 'upstream', provider: 'confluence' } })
    expect(pulled.mirroredDoc?.upstreamVersion).toBe('9')
    expect((await pulled.previous())?.content).toBe('# Local')
  })

  test('a Google-linked work takes a pull, and only a pull', async () => {
    const work = await works.createWork('local', 'Google', 'doc', '# Local', '', undefined, 'claude-code')
    await (await workModule.Work.byId('local', work.id)).setMirroredDoc({ ...LINK, provider: 'gdrive' })
    await expect(personEdit('local', work.id, '# Blocked')).rejects.toThrow(workModule.GOOGLE_WORK_READ_ONLY)
    expect((await workSync.pullWorkUpstream('local', work.id)).ok).toBe(true)
    expect((await works.loadWork('local', work.id))?.content).toBe('# From upstream')
  })
})
