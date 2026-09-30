import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Attribution } from '@solus/contracts/user'

const dataDir = mkdtempSync(join(tmpdir(), 'solus-work-version-'))
process.env.SOLUS_DATA_DIR = dataDir
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let works: typeof import('@solus/server/data/works/works')
let workModule: typeof import('@solus/server/data/works/work')
let documentContentHash: typeof import('@solus/server/docs/content-hash').documentContentHash
beforeAll(async () => {
  works = await import('@solus/server/data/works/works')
  workModule = await import('@solus/server/data/works/work')
  documentContentHash = (await import('@solus/server/docs/content-hash')).documentContentHash
})
afterAll(async () => {
  await (await import('@solus/server/db/database')).closeDatabase()
  ;(await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

const MEMBER_B: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'member-b' }, displayName: 'Member B' } }
const AGENT: Attribution = { kind: 'agent', sessionId: 'session-1' }

/** Read the work, then write naming the content version that read saw. */
async function edit(scope: string, workId: string, write: { content: string; title?: string; author: Attribution; reason: 'edit' | 'agent' }) {
  const work = await workModule.Work.byId(scope, workId)
  return work.updateContent({ ...write, expectedContentVersion: work.contentVersion })
}

async function newDoc(content = 'Original') {
  const work = await works.createWork('org-a', 'Draft', 'doc', content, '', undefined, 'claude-code', '~', undefined, MEMBER_B)
  return workModule.Work.byId('org-a', work.id)
}

test('cloud saves refuse a stale copy and preserve the newer text', async () => {
  const work = await works.createWork('org-a', 'Draft', 'doc', 'Original', '', undefined, 'claude-code')
  const read = { expectedUpdatedAt: work.updatedAt, expectedContentVersion: work.contentVersion }
  const updated = await (await workModule.Work.byId('org-a', work.id)).updateContent({ content: 'Member B', ...read, author: MEMBER_B, reason: 'edit' })
  expect(updated.updatedAt > work.updatedAt).toBe(true)
  await expect((await workModule.Work.byId('org-a', work.id)).updateContent({ content: 'Stale A', ...read, author: MEMBER_B, reason: 'edit' })).rejects.toThrow('changed in the cloud')
  expect((await works.loadWork('org-a', work.id))?.content).toBe('Member B')
  expect((await works.loadWork('org-a', work.id))?.updatedAt).toBe(updated.updatedAt)
  expect(await works.loadWork('org-b', work.id)).toBeNull()
})

test('agent edits and Restore advance the version read by open clients', async () => {
  const work = await works.createWork('org-a', 'Diagram', 'diagram', '{"nodes":[],"edges":[]}', '', undefined, 'claude-code')
  const updated = await (await workModule.Work.byId('org-a', work.id)).updateTitle({ title: 'Agent title' })
  expect(updated.updatedAt > work.updatedAt).toBe(true)
  await edit('org-a', work.id, { content: '{"nodes":[{"id":"a"}],"edges":[]}', author: AGENT, reason: 'agent' })
  const version = (await works.loadWork('org-a', work.id))?.updatedAt
  const reverting = await workModule.Work.byId('org-a', work.id)
  const restored = await reverting.restoreRevision({ revisionId: reverting.previousRevisionId!, expectedContentVersion: reverting.contentVersion, author: MEMBER_B })
  expect(restored.updatedAt > version!).toBe(true)
  expect(restored.content).toBe(work.content)
})

test('a new work starts at content version 1 with its hash and admitted author', async () => {
  const work = await newDoc()
  expect(work.contentVersion).toBe(1)
  expect(work.contentHash).toBe(documentContentHash('Original'))
  expect(work.contentAuthor).toEqual(MEMBER_B)
  expect((await works.loadWork('org-a', work.id))?.contentVersion).toBe(1)
})

test('each accepted body change advances the content version by one, whoever writes it', async () => {
  const work = await newDoc()
  await work.updateContent({ content: 'Edit 1', expectedContentVersion: 1, author: MEMBER_B, reason: 'edit' })
  expect(work.contentVersion).toBe(2)
  await work.updateContent({ content: 'Edit 2', expectedContentVersion: 2, author: AGENT, reason: 'agent' })
  expect(work.contentVersion).toBe(3)
  expect(work.contentAuthor).toEqual(AGENT)
  expect(work.contentHash).toBe(documentContentHash('Edit 2'))
})

test('an equal body is not a change: neither version moves', async () => {
  const work = await newDoc()
  const before = work.record()
  await work.updateContent({ content: 'Original', expectedContentVersion: 1, author: AGENT, reason: 'agent' })
  expect(work.contentVersion).toBe(1)
  expect(work.updatedAt).toBe(before.updatedAt)
  expect(work.contentAuthor).toEqual(MEMBER_B)
})

test('metadata-only writes move the record version and never the content version', async () => {
  const work = await newDoc()
  const before = work.record()
  await work.updateTitle({ title: 'Renamed', expectedUpdatedAt: before.updatedAt })
  expect(work.updatedAt > before.updatedAt).toBe(true)
  await work.updateContent({ content: 'Original', title: 'Renamed again', expectedContentVersion: work.contentVersion, author: MEMBER_B, reason: 'edit' })
  await work.setPinned(true)
  await work.linkSession('session-2')
  await work.setMirroredDoc({ provider: 'confluence', externalId: '1', externalKey: 'site/ENG', scope: 'ENG', url: 'https://example.atlassian.net/wiki/1', syncState: 'ok' })
  const reloaded = await workModule.Work.byId('org-a', work.id)
  expect(reloaded.title).toBe('Renamed again')
  expect(reloaded.pinned).toBe(true)
  expect(reloaded.contentVersion).toBe(1)
  expect(reloaded.contentHash).toBe(before.contentHash)
})

test('a restore to earlier content still advances the content version', async () => {
  const work = await newDoc()
  await work.updateContent({ content: 'Agent body', expectedContentVersion: work.contentVersion, author: AGENT, reason: 'agent' })
  await work.restoreRevision({ revisionId: work.previousRevisionId!, expectedContentVersion: 2, author: MEMBER_B })
  expect(work.content).toBe('Original')
  expect(work.contentVersion).toBe(3)
  expect(work.contentHash).toBe(documentContentHash('Original'))
  expect(work.contentAuthor).toEqual(MEMBER_B)
})

test('two instances loaded at one version: the second write is refused and the first survives', async () => {
  const created = await newDoc()
  const first = await workModule.Work.byId('org-a', created.id)
  const second = await workModule.Work.byId('org-a', created.id)
  await first.updateContent({ content: 'From A', expectedContentVersion: first.contentVersion, author: MEMBER_B, reason: 'edit' })
  const stale = second.updateContent({ content: 'From B', expectedContentVersion: second.contentVersion, author: AGENT, reason: 'agent' })
  await expect(stale).rejects.toBeInstanceOf(workModule.WorkVersionConflictError)
  await expect(stale).rejects.toMatchObject({ precondition: 'content' })
  expect((await works.loadWork('org-a', created.id))?.content).toBe('From A')
})

test('racing writers at one version: exactly one is accepted', async () => {
  const created = await newDoc()
  const writers = await Promise.all([1, 2, 3].map(() => workModule.Work.byId('org-a', created.id)))
  const results = await Promise.allSettled(writers.map((writer, index) =>
    writer.updateContent({ content: `Writer ${index}`, expectedContentVersion: 1, author: MEMBER_B, reason: 'edit' })))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const saved = await workModule.Work.byId('org-a', created.id)
  expect(saved.contentVersion).toBe(2)
  expect(['Writer 0', 'Writer 1', 'Writer 2']).toContain(saved.content)
})

test('a combined title and body write satisfies both preconditions or writes nothing', async () => {
  const work = await newDoc()
  const read = work.record()
  await work.updateTitle({ title: 'Moved on' })
  const stale = await workModule.Work.byId('org-a', work.id)
  await expect(stale.updateContent({ content: 'New body', title: 'Stale title', expectedUpdatedAt: read.updatedAt, expectedContentVersion: read.contentVersion, author: MEMBER_B, reason: 'edit' }))
    .rejects.toMatchObject({ precondition: 'record' })
  const saved = await workModule.Work.byId('org-a', work.id)
  expect(saved.title).toBe('Moved on')
  expect(saved.content).toBe('Original')
  expect(saved.contentVersion).toBe(1)
})

test('the record is plain data: it survives serialization with every version field', async () => {
  const work = await newDoc()
  const record = JSON.parse(JSON.stringify(work.record()))
  expect(record).toMatchObject({ id: work.id, contentVersion: 1, contentHash: documentContentHash('Original'), contentAuthor: MEMBER_B })
  expect(record.updatedAt).toBe(work.updatedAt)
})
