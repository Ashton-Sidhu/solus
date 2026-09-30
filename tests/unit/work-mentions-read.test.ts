import { installTestWorkspaceTools } from './helpers/workspace-tools'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'
import { personMentionMarkdown, restoreMentions } from '@solus/contracts/mentions'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type WorksModule = typeof import('@solus/server/data/works/works')
type WorkAnnotationsModule = typeof import('@solus/server/data/works/work-annotations')
type WorkToolsModule = typeof import('@solus/server/execution/agents/tools/work-tools')

let dataDir: string
let db: DbModule
let works: WorksModule
let workAnnotations: WorkAnnotationsModule
let workTools: WorkToolsModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeEach(async () => { await installTestWorkspaceTools() })

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-work-mentions-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  works = await import('@solus/server/data/works/works')
  workAnnotations = await import('@solus/server/data/works/work-annotations')
  workTools = await import('@solus/server/execution/agents/tools/work-tools')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('read_work shows a mention as the name an agent reads', () => {
  test('a mention in the body and in a thread reads as @Display Name', async () => {
    // WHY: an agent reads people, it does not write mentions (plan 004 item
    // 13). A raw person:// link in its context invites it to copy or invent
    // one; `@Name` is what a teammate would read.
    const ann = personMentionMarkdown({ userId: 'u_ann', name: 'Ann [Ops] Lee' })
    const bob = personMentionMarkdown({ userId: 'u_bob', name: 'Bob' })
    const work = await works.createWork('local', 'Launch', 'doc', `Owner: ${ann}.`, '', 'peer-1', 'claude-code', '/tmp/proj')
    await workAnnotations.saveWorkAnnotations('local', {
      version: 1,
      workId: work.id,
      updatedAt: 1,
      comments: [{ id: 'c1', selectedText: 'Owner', comment: `${bob} can you confirm?` }],
    })

    const result = await workTools.executeWorkTool('read_work', { work_id: work.id })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Owner: @Ann [Ops] Lee.')
    expect(result.text).toContain('@Bob can you confirm?')
    expect(result.text).not.toContain('person://')
  })
})

describe('an agent\'s rewrite keeps the people it read', () => {
  test('update_work turns each @Name back into the mention it was read from', async () => {
    // WHY: read_work shows a mention as `@Name`, so an agent writes it back that
    // way. Saving that text as-is would silently drop the person from the work.
    const ann = personMentionMarkdown({ userId: 'u_ann', name: 'Ann Lee' })
    const work = await works.createWork('local', 'Launch', 'doc', `Owner: ${ann}.`, '', 'peer-1', 'claude-code', '/tmp/proj')
    const read = await workTools.executeWorkTool('read_work', { work_id: work.id })
    const agentText = read.text.slice(read.text.indexOf('Owner:')).replace('Owner:', 'Owner (confirmed):')

    const result = await workTools.executeWorkTool('update_work', { work_id: work.id, content: agentText, expected_content_version: work.contentVersion })

    expect(result.ok).toBe(true)
    expect((await works.loadWork('local', work.id))?.content).toBe(`Owner (confirmed): ${ann}.`)
  })
})

describe('restoring mentions', () => {
  const ann = personMentionMarkdown({ userId: 'u_ann', name: 'Ann' })
  const annLee = personMentionMarkdown({ userId: 'u_ann_lee', name: 'Ann Lee' })

  test('matches the longest name, and leaves emails, other words and kept links alone', () => {
    const previous = `${ann} and ${annLee}`
    expect(restoreMentions('@Ann Lee, then @Ann; ann@example.com; @Annabel; ' + ann, previous))
      .toBe(`${annLee}, then ${ann}; ann@example.com; @Annabel; ${ann}`)
  })

  test('a name two people share stays text, and an agent never makes a new mention', () => {
    const twin = personMentionMarkdown({ userId: 'u_other_ann', name: 'Ann' })
    expect(restoreMentions('@Ann', `${ann} ${twin}`)).toBe('@Ann')
    expect(restoreMentions('@Bob', ann)).toBe('@Bob')
  })
})
