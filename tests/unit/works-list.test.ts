import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Attribution } from '@solus/contracts/user'
import type { WorkExternalLink } from '@solus/contracts/docs'

/**
 * Collection reads of works never read a body (plans/029 P2, §8): the list
 * tells a mirrored work's sync state from the hash the row already stores, and
 * the history menu lists checkpoints without their bodies. Deleting a work
 * removes its activity with it (§7).
 */

// A temporary fixture database only; never a live Solus data directory.
const dataDir = mkdtempSync(join(tmpdir(), 'solus-works-list-'))
process.env.SOLUS_DATA_DIR = dataDir
mock.module('node:sqlite', () => ({ DatabaseSync }))

let works: typeof import('@solus/server/data/works/works')
let workModule: typeof import('@solus/server/data/works/work')
let activity: typeof import('@solus/server/data/activity/activity')
let database: typeof import('@solus/server/db/database')
let rawDb: typeof import('@solus/server/db')
let documentContentHash: typeof import('@solus/server/docs/content-hash').documentContentHash

beforeAll(async () => {
  works = await import('@solus/server/data/works/works')
  workModule = await import('@solus/server/data/works/work')
  activity = await import('@solus/server/data/activity/activity')
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
const ORG = 'org-a'

async function newDoc(content = 'v1') {
  const created = await works.createWork(ORG, 'Doc', 'doc', content, '', undefined, 'claude-code', '~', undefined, PERSON)
  return workModule.Work.byId(ORG, created.id)
}

/** The SQL text of every statement the host database prepared while `run` ran.
 *  The connection carries `prepare` as its own property, so the wrap is on the instance. */
async function statementsDuring(run: () => Promise<unknown>): Promise<string[]> {
  const db = rawDb.getDb()
  const original = db.prepare
  const captured: string[] = []
  db.prepare = ((text: string) => {
    captured.push(text)
    return original.call(db, text)
  }) as typeof db.prepare
  try {
    await run()
    return captured
  } finally {
    db.prepare = original
  }
}

/** `content` as a column of its own; `content_hash` and the like are other columns. */
const selectsBody = (statement: string) => /\bcontent\b/.test(statement.split(/\bFROM\b/i)[0] ?? statement)

function googleLink(lastPushedContentHash: string): WorkExternalLink {
  return {
    provider: 'gdrive', externalKey: 'drive', externalId: 'doc-1', url: 'https://docs.google.com/document/d/doc-1',
    scope: 'drive', syncState: 'ok', lastPushedContentHash,
  }
}

describe.skipIf(process.env.SOLUS_DB === 'postgres')('the work list', () => {
  test('reads no body, and tells a Google-mirrored work’s state from its stored hash', async () => {
    // WHY: artifact bodies are hundreds of KB, and the list used to read every
    // one only to recompute the hash the row already stores. The state must be
    // the same as before: `ok` while the pushed hash is the current hash, `dirty`
    // once it is not — whatever the body column holds.
    const work = await newDoc('the body')
    await work.setMirroredDoc(googleLink(work.contentHash))

    const statements = await statementsDuring(() => works.listWorks(ORG))
    const list = statements.filter((statement) => /\bFROM\s+"?works"?\b/i.test(statement) && /^\s*SELECT/i.test(statement))
    expect(list.length).toBeGreaterThan(0)
    expect(list.some(selectsBody)).toBe(false)
    expect((await works.listWorks(ORG)).find((listed) => listed.id === work.id)?.mirroredDoc?.syncState).toBe('ok')

    // A body column that disagrees with the hash changes nothing for the list:
    // the hash is the fact. (A body read would refuse the row, so it is put back.)
    const stored = rawDb.getDb().prepare('SELECT content FROM works WHERE id = ?').get(work.id) as { content: string | null }
    rawDb.getDb().prepare('UPDATE works SET content = ? WHERE id = ?').run('not the body', work.id)
    expect((await works.listWorks(ORG)).find((listed) => listed.id === work.id)?.mirroredDoc?.syncState).toBe('ok')
    rawDb.getDb().prepare('UPDATE works SET content = ? WHERE id = ?').run(stored.content, work.id)

    await work.setMirroredDoc(googleLink(documentContentHash('what Google last got')))
    expect((await works.listWorks(ORG)).find((listed) => listed.id === work.id)?.mirroredDoc?.syncState).toBe('dirty')
    expect((await works.loadWork(ORG, work.id))?.mirroredDoc?.syncState).toBe('dirty')
  })

  test('a work with no link, or a state the provider owns, is listed as stored', async () => {
    const plain = await newDoc()
    const conflicted = await newDoc()
    await conflicted.setMirroredDoc({ ...googleLink('stale'), syncState: 'conflict' })

    const listed = await works.listWorks(ORG)
    expect(listed.find((work) => work.id === plain.id)?.mirroredDoc).toBeUndefined()
    expect(listed.find((work) => work.id === conflicted.id)?.mirroredDoc?.syncState).toBe('conflict')
  })
})

describe.skipIf(process.env.SOLUS_DB === 'postgres')('the history list', () => {
  test('selects no bodies; one revision read still has its body', async () => {
    // WHY: `revisions()` opens the history menu. It is documented "without
    // bodies", and with Git-backed storage that is an unbounded read for nothing.
    const work = await newDoc('v1')
    // The displaced body is the baseline, so the agent write adds one checkpoint: its own.
    await work.updateContent({ content: 'v2', expectedContentVersion: work.contentVersion, author: PERSON, reason: 'agent' })

    const statements = await statementsDuring(() => work.revisions())
    const history = statements.filter((statement) => /\bFROM\s+"?work_revisions"?\b/i.test(statement))
    expect(history.length).toBeGreaterThan(0)
    expect(history.some(selectsBody)).toBe(false)

    const summaries = await work.revisions()
    expect(summaries.map((revision) => revision.reason)).toEqual(['baseline', 'agent'])
    expect(summaries.some((revision) => 'content' in revision)).toBe(false)
    expect((await work.revision(1)).content).toBe('v1')
  })
})

describe('deleting a work', () => {
  test('removes its activity with it', async () => {
    // WHY: task delete already does this. Work activity that outlives its work
    // is a row nothing reads and nothing can remove.
    const work = await newDoc()
    const other = await newDoc()
    for (const subject of [work, other]) {
      await activity.appendActivity(ORG, activity.newActivity({ kind: 'work', id: subject.id }, PERSON, { kind: 'renamed', title: 'Renamed' }))
    }
    expect(await activity.activityFor(ORG, { kind: 'work', id: work.id })).toHaveLength(1)

    await work.delete()

    expect(await activity.activityFor(ORG, { kind: 'work', id: work.id })).toEqual([])
    expect(await activity.activityFor(ORG, { kind: 'work', id: other.id })).toHaveLength(1)
  })
})
