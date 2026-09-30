import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { Attribution } from '@solus/contracts/user'

// A temporary fixture database only; never a live Solus data directory.
const dataDir = mkdtempSync(join(tmpdir(), 'solus-work-revisions-'))
process.env.SOLUS_DATA_DIR = dataDir
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let works: typeof import('@solus/server/data/works/works')
let workModule: typeof import('@solus/server/data/works/work')
let database: typeof import('@solus/server/db/database')
let rawDb: typeof import('@solus/server/db')
let documentContentHash: typeof import('@solus/server/docs/content-hash').documentContentHash

beforeAll(async () => {
  works = await import('@solus/server/data/works/works')
  workModule = await import('@solus/server/data/works/work')
  database = await import('@solus/server/db/database')
  rawDb = await import('@solus/server/db')
  documentContentHash = (await import('@solus/server/docs/content-hash')).documentContentHash
})
afterAll(async () => {
  await database.closeDatabase()
  rawDb.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

const PERSON: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice' } }
const AGENT: Attribution = { kind: 'agent', sessionId: 'session-1' }

async function newDoc(content = 'v1', organizationId = 'org-a') {
  const created = await works.createWork(organizationId, 'Doc', 'doc', content, '', undefined, 'claude-code', '~', undefined, PERSON)
  return workModule.Work.byId(organizationId, created.id)
}

interface StoredRevision { content: string | null; updated_at: number; content_hash: string }

/** Every stored column of every revision, for immutability checks. */
async function storedRevisions(workId: string) {
  return database.getDatabase().all<StoredRevision>(sql`SELECT * FROM work_revisions WHERE work_id = ${workId} ORDER BY rev`)
}

describe('history', () => {
  test('a new work saves its initial baseline and has no previous version', async () => {
    const work = await newDoc('first body')
    expect(await work.revisions()).toEqual([expect.objectContaining({
      workId: work.id, revisionId: 1, reason: 'baseline', sourceContentVersion: 1, author: PERSON, contentHash: documentContentHash('first body'),
    })])
    expect(work.previousRevisionId).toBeNull()
    expect(await work.previous()).toBeNull()
  })

  test('human edits advance the version without a history row', async () => {
    const work = await newDoc()
    for (const content of ['v2', 'v3', 'v4']) await work.updateContent({ content, expectedContentVersion: work.contentVersion, author: PERSON, reason: 'edit' })
    expect(work.contentVersion).toBe(4)
    expect((await work.revisions()).map(revision => revision.reason)).toEqual(['baseline'])
    expect(work.previousRevisionId).toBeNull()
  })

  test('metadata-only and equal-body writes add no history', async () => {
    const work = await newDoc()
    await work.updateTitle({ title: 'Renamed' })
    await work.setPinned(true)
    await work.updateContent({ content: 'v1', expectedContentVersion: work.contentVersion, author: AGENT, reason: 'agent' })
    await work.updateContent({ content: 'v1', title: 'Renamed twice', expectedContentVersion: work.contentVersion, author: AGENT, reason: 'agent' })
    expect(await work.revisions()).toHaveLength(1)
    expect(work.title).toBe('Renamed twice')
    expect(work.contentVersion).toBe(1)
  })

  test('an agent write checkpoints the displaced human edit and its own result', async () => {
    const work = await newDoc()
    await work.updateContent({ content: 'human v2', expectedContentVersion: work.contentVersion, author: PERSON, reason: 'edit' })
    await work.updateContent({ content: 'agent v3', expectedContentVersion: 2, author: AGENT, reason: 'agent' })
    const history = await work.revisions()
    expect(history.map(({ reason, sourceContentVersion, author }) => ({ reason, sourceContentVersion, author }))).toEqual([
      { reason: 'baseline', sourceContentVersion: 1, author: PERSON },
      { reason: 'checkpoint', sourceContentVersion: 2, author: PERSON },
      { reason: 'agent', sourceContentVersion: 3, author: AGENT },
    ])
    expect((await work.revision(2)).content).toBe('human v2')
    expect(history[2]!.contentHash).toBe(documentContentHash('agent v3'))
    // The comparison target is the displaced body, not the newest checkpoint.
    expect(work.previousRevisionId).toBe(2)
    expect((await work.previous())?.content).toBe('human v2')
  })

  test('a body a checkpoint already holds is not captured twice', async () => {
    const work = await newDoc()
    await work.updateContent({ content: 'agent v2', expectedContentVersion: work.contentVersion, author: AGENT, reason: 'agent' })
    await work.updateContent({ content: 'agent v3', expectedContentVersion: work.contentVersion, author: AGENT, reason: 'agent' })
    expect((await work.revisions()).map(revision => revision.reason)).toEqual(['baseline', 'agent', 'agent'])
    expect(work.previousRevisionId).toBe(2)
  })

  const GOOGLE_LINK = { provider: 'gdrive', externalId: 'doc', externalKey: 'root', scope: 'root', url: 'https://docs.google.com/document/d/doc/edit', syncState: 'ok' } as const

  test('an upstream pull checkpoints like an agent write and names its provider', async () => {
    const work = await newDoc()
    await work.setMirroredDoc(GOOGLE_LINK)
    await expect(work.updateContent({ content: 'blocked', expectedContentVersion: work.contentVersion, author: PERSON, reason: 'edit' })).rejects.toThrow(workModule.GOOGLE_WORK_READ_ONLY)
    await work.applyUpstream({ content: 'from google', title: 'Doc', link: { ...GOOGLE_LINK, upstreamVersion: '7' }, expectedContentVersion: work.contentVersion })
    expect((await work.revisions()).at(-1)).toMatchObject({ reason: 'upstream', author: { kind: 'upstream', provider: 'gdrive' }, sourceContentVersion: 2 })
    expect((await work.previous())?.content).toBe('v1')
    // The refreshed link lands with the body, in the same write.
    expect(work.mirroredDoc?.upstreamVersion).toBe('7')
  })

  test('an upstream body is refused for a work with no upstream link', async () => {
    const work = await newDoc()
    await expect(work.applyUpstream({ content: 'x', title: 'Doc', link: GOOGLE_LINK, expectedContentVersion: work.contentVersion })).rejects.toThrow('linked work')
    expect(await work.revisions()).toHaveLength(1)
  })

  test('restore twice: versions advance, old rows never change, and the second undoes the first', async () => {
    const work = await newDoc('original')
    await work.updateContent({ content: 'agent body', expectedContentVersion: work.contentVersion, author: AGENT, reason: 'agent' })
    const before = await storedRevisions(work.id)

    await work.restoreRevision({ revisionId: work.previousRevisionId!, expectedContentVersion: 2, author: PERSON })
    expect(work.content).toBe('original')
    expect(work.contentVersion).toBe(3)
    const afterFirst = await storedRevisions(work.id)
    expect(afterFirst.slice(0, before.length)).toEqual(before)
    expect((await work.revisions()).at(-1)).toMatchObject({ reason: 'restore', sourceContentVersion: 3, author: PERSON })
    expect((await work.previous())?.content).toBe('agent body')

    await work.restoreRevision({ revisionId: work.previousRevisionId!, expectedContentVersion: 3, author: PERSON })
    expect(work.content).toBe('agent body')
    expect(work.contentVersion).toBe(4)
    expect((await storedRevisions(work.id)).slice(0, afterFirst.length)).toEqual(afterFirst)
    expect((await work.previous())?.content).toBe('original')
    // Identical bodies are recognizable by hash across versions.
    const history = await work.revisions()
    expect(history.at(-1)!.contentHash).toBe(history.find(revision => revision.reason === 'agent')!.contentHash)
  })

  test('a restore from a stale read is refused and changes nothing', async () => {
    const work = await newDoc()
    await work.updateContent({ content: 'agent', expectedContentVersion: work.contentVersion, author: AGENT, reason: 'agent' })
    const stale = await workModule.Work.byId('org-a', work.id)
    await work.updateContent({ content: 'human', expectedContentVersion: work.contentVersion, author: PERSON, reason: 'edit' })
    await expect(stale.restoreRevision({ revisionId: 1, expectedContentVersion: stale.contentVersion, author: PERSON })).rejects.toMatchObject({ precondition: 'content' })
    const saved = await workModule.Work.byId('org-a', work.id)
    expect(saved.content).toBe('human')
    expect(await saved.revisions()).toHaveLength(2)
  })

  test('a review checkpoint records the exact body, version, author, and hash it saw', async () => {
    const work = await newDoc()
    await work.updateContent({ content: 'reviewed body', expectedContentVersion: work.contentVersion, author: PERSON, reason: 'edit' })
    const checkpoint = await work.checkpoint({ reason: 'review', expectedContentVersion: 2 })
    expect(checkpoint).toMatchObject({ reason: 'review', sourceContentVersion: 2, author: PERSON, contentHash: documentContentHash('reviewed body'), content: 'reviewed body' })
    await work.updateContent({ content: 'later', expectedContentVersion: work.contentVersion, author: PERSON, reason: 'edit' })
    await expect(work.checkpoint({ reason: 'review', expectedContentVersion: 2 })).rejects.toMatchObject({ precondition: 'content' })
    expect((await work.revision(checkpoint.revisionId)).content).toBe('reviewed body')
  })
})

describe('scope', () => {
  test('another organization cannot load, read the history of, or restore a work', async () => {
    const work = await newDoc('private', 'org-a')
    await work.updateContent({ content: 'agent', expectedContentVersion: work.contentVersion, author: AGENT, reason: 'agent' })
    await expect(workModule.Work.byId('org-b', work.id)).rejects.toThrow('Work not found')
    expect(await workModule.Work.find('org-b', work.id)).toBeNull()
    expect(await works.loadWork('org-b', work.id)).toBeNull()
    expect((await workModule.Work.byId('org-a', work.id)).content).toBe('agent')
  })

  test('a duplicate is a new work with its own baseline, keeping the body author', async () => {
    const work = await newDoc('copied')
    await work.updateContent({ content: 'agent copy', expectedContentVersion: work.contentVersion, author: AGENT, reason: 'agent' })
    const copy = await workModule.Work.byId('org-a', (await works.duplicateWork('org-a', work.id)).id)
    expect(copy.contentVersion).toBe(1)
    expect(copy.contentAuthor).toEqual(AGENT)
    expect((await copy.revisions()).map(revision => revision.reason)).toEqual(['baseline'])
    expect(copy.previousRevisionId).toBeNull()
  })
})

describe('rollback', () => {
  test('a write inside a transaction that rolls back leaves no version, body, or history', async () => {
    const work = await newDoc()
    const before = await storedRevisions(work.id)
    await expect(database.getDatabase().transaction(async () => {
      await (await workModule.Work.byId('org-a', work.id)).updateContent({ content: 'rolled back', expectedContentVersion: 1, author: AGENT, reason: 'agent' })
      throw new Error('abort')
    })).rejects.toThrow('abort')
    const saved = await workModule.Work.byId('org-a', work.id)
    expect(saved.content).toBe('v1')
    expect(saved.contentVersion).toBe(1)
    expect(saved.previousRevisionId).toBeNull()
    expect(await storedRevisions(work.id)).toEqual(before)
  })
})

// The file is the store only on SQLite; the Postgres twin of this step is SQL in its migration.

describe.skipIf(process.env.SOLUS_DB === 'postgres')('the search index', () => {
  test('follows every body and title change, ignores metadata writes, and forgets a deleted work', async () => {
    // WHY: the index is kept by triggers keyed on a stable row per work. A
    // trigger that missed a write would answer stale text; one that fired on
    // every pin or version bump re-indexed the whole body for nothing.
    const { searchWorks } = await import('@solus/server/data/works/work-search')
    const ids = async (query: string) => (await searchWorks('org-a', query, { limit: 10 })).map((hit) => hit.id)
    const doc = await newDoc('the quartz ledger')
    const other = await newDoc('an unrelated note')
    expect(await ids('quartz')).toEqual([doc.id])

    await doc.updateContent({ content: 'the basalt ledger', author: PERSON, expectedContentVersion: doc.contentVersion })
    expect(await ids('quartz')).toEqual([])
    expect(await ids('basalt')).toEqual([doc.id])

    await doc.updateTitle({ title: 'Obsidian plan' })
    expect(await ids('obsidian')).toEqual([doc.id])

    const before = rawDb.getDb().prepare('SELECT COUNT(*) AS count FROM works_fts').get()
    await doc.setPinned(true)
    expect(rawDb.getDb().prepare('SELECT COUNT(*) AS count FROM works_fts').get()).toEqual(before)
    expect(await ids('basalt')).toEqual([doc.id])

    await doc.delete()
    expect(await ids('basalt')).toEqual([])
    expect(rawDb.getDb().prepare('SELECT work_id FROM works_fts_rows WHERE work_id = ?').all(doc.id)).toEqual([])
    expect(await ids('unrelated')).toEqual([other.id])
  })
})
