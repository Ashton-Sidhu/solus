import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { sql } from 'drizzle-orm'
import * as Y from 'yjs'
import type { WorkArchiveOperation, WorkArchiveBody, WorkArchiveTransport } from '@solus/server/data/works/git-work-storage'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const root = mkdtempSync(join(tmpdir(), 'solus-work-adapters-'))
process.env.SOLUS_DATA_DIR = root
let works: typeof import('@solus/server/data/works/works')
let Work: typeof import('@solus/server/data/works/work').Work
let storage: typeof import('@solus/server/data/works/work-storage')
let database: typeof import('@solus/server/db/database')
let archive: typeof import('@solus/server/data/works/git-work-storage')
let Writer: typeof import('@solus/server/sync/works/work-archive-writer').WorkArchiveWriter
const restores: Array<() => void> = []

beforeAll(async () => {
  works = await import('@solus/server/data/works/works')
  Work = (await import('@solus/server/data/works/work')).Work
  storage = await import('@solus/server/data/works/work-storage')
  database = await import('@solus/server/db/database')
  archive = await import('@solus/server/data/works/git-work-storage')
  Writer = (await import('@solus/server/sync/works/work-archive-writer')).WorkArchiveWriter
})
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore()
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(root, `solus.db${suffix}`), { force: true })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

interface RemoteSnapshot { commit: string; operation: WorkArchiveOperation; bodies: Map<string, string> }
class FixtureTransport implements WorkArchiveTransport {
  readonly repositories = new Map<string, RemoteSnapshot[]>()
  reads = 0
  failPush = false
  loseReply = false
  failRemove = false
  corruptRead = false
  duringPush: (() => Promise<void>) | null = null
  async read(repository: string, commit: string, hash: string): Promise<string> {
    this.reads++
    if (this.corruptRead) return 'corrupt'
    const body = this.repositories.get(repository)?.find(item => item.commit === commit)?.bodies.get(hash)
    if (body === undefined) throw new Error('Missing fixture body')
    return body
  }
  async push(repository: string, operation: WorkArchiveOperation, bodies: readonly WorkArchiveBody[]): Promise<string> {
    if (this.failPush) throw new Error('Offline')
    const commits = this.repositories.get(repository) ?? []
    const old = commits.at(-1)
    if (old?.operation.manifest.operationId === operation.manifest.operationId) return old.commit
    if ((old?.commit ?? null) !== operation.expectedCommit) throw new Error('Stale ref')
    const content = new Map(old?.bodies)
    for (const body of bodies) content.set(body.hash, body.content)
    const commit = createHash('sha1').update(JSON.stringify(operation)).digest('hex')
    commits.push({ commit, operation: structuredClone(operation), bodies: content })
    this.repositories.set(repository, commits)
    await this.duringPush?.()
    if (this.loseReply) { this.loseReply = false; throw new Error('Lost response') }
    return commit
  }
  async remove(repository: string): Promise<void> {
    if (this.failRemove) throw new Error('Offline')
    this.repositories.delete(repository)
  }
}

async function fixture(options: { flushLive?: (workId: string) => Promise<void> } = {}) {
  let now = 100_000
  const transport = new FixtureTransport()
  const writer = new Writer(database.getDatabase, transport, () => now, options.flushLive)
  const artifacts = new archive.GitWorkStorage(transport, workId => writer.drain(workId), () => now)
  const local = new (await import('@solus/server/data/works/database-work-storage')).DatabaseWorkStorage()
  restores.push(storage.installWorkStorage({ database: local, artifacts, defaultProvider: 'cloudflare-artifacts' }))
  return { transport, writer, artifacts, local, setNow: (value: number) => { now = value } }
}
async function create(organization = 'org-a') {
  const created = await works.createWork(organization, 'Draft', 'doc', 'Original', '', undefined, 'claude-code')
  return Work.byId(organization, created.id)
}
async function mapping(workId: string) {
  return database.getDatabase().get<{ provider: string; generation: number; archived_generation: number; operation: string | null; commit_id: string | null; due_at: number | null; repository: string; error: string | null }>(sql`SELECT * FROM work_storage WHERE work_id = ${workId}`)
}

test('local works stay offline and mappings survive a default change', async () => {
  const f = await fixture()
  const local = await create('local')
  const cloud = await create()
  expect((await mapping(local.id))?.provider).toBe('database')
  expect((await mapping(cloud.id))?.provider).toBe('cloudflare-artifacts')
  restores.push(storage.installWorkStorage({ database: f.local, artifacts: f.artifacts, defaultProvider: 'database' }))
  const later = await create()
  expect((await mapping(later.id))?.provider).toBe('database')
  await cloud.flushStorage()
  expect(f.transport.repositories.size).toBe(1)
  await local.updateContent({ content: 'Offline edit', expectedContentVersion: 1, reason: 'edit', author: null })
  expect((await works.loadWork('local', local.id))?.content).toBe('Offline edit')
})

test('archived revisions read and restore through the same Work methods with no database bodies', async () => {
  const f = await fixture()
  const work = await create()
  await work.updateContent({ content: 'Agent body', expectedContentVersion: 1, reason: 'agent', author: { kind: 'agent', sessionId: 'fixture' } })
  await work.flushStorage()
  const rows = await database.getDatabase().all<{ content: string | null }>(sql`SELECT content FROM work_revisions WHERE work_id = ${work.id}`)
  expect(rows.every(row => row.content === null)).toBe(true)
  expect((await work.revision(1)).content).toBe('Original')
  expect(f.transport.reads).toBeGreaterThan(0)
  const history = await work.revisions()
  await work.restoreRevision({ revisionId: 1, expectedContentVersion: 2, author: null })
  expect(work.content).toBe('Original')
  expect(work.contentVersion).toBe(3)
  await work.flushStorage()
  expect((await work.revisions()).slice(0, history.length)).toEqual(history)
  expect((await works.exportWorkForCloud('org-a', work.id)).work.content).toBe('Original')
  expect(await works.loadWork('org-b', work.id)).toBeNull()
  await database.getDatabase().run(sql`UPDATE works SET content = NULL WHERE id = ${work.id}`)
  expect((await Work.byId('org-a', work.id)).content).toBe('Original')
})

test('stale writes and outer transaction rollback leave no archive payload behind', async () => {
  const f = await fixture()
  const work = await create()
  await f.writer.drain(work.id)
  const before = await mapping(work.id)
  await expect(database.getDatabase().transaction(async () => {
    await work.updateContent({ content: 'Rolled back', expectedContentVersion: 1, reason: 'agent', author: null })
    throw new Error('Rollback')
  })).rejects.toThrow('Rollback')
  expect(await mapping(work.id)).toEqual(before)
  expect((await Work.byId('org-a', work.id)).content).toBe('Original')
  const first = await Work.byId('org-a', work.id)
  const stale = await Work.byId('org-a', work.id)
  await first.updateContent({ content: 'Winner', expectedContentVersion: 1, reason: 'edit', author: null })
  await expect(stale.updateContent({ content: 'Loser', expectedContentVersion: 1, reason: 'edit', author: null })).rejects.toThrow('changed after')
  expect((await Work.byId('org-a', work.id)).content).toBe('Winner')
})

test('ordinary edits debounce, continuous edits have a maximum delay, and checkpoints are immediate', async () => {
  const f = await fixture()
  const work = await create()
  await f.writer.drain(work.id)
  await work.updateContent({ content: 'One', expectedContentVersion: 1, reason: 'edit', author: null })
  expect((await mapping(work.id))?.due_at).toBe(103_000)
  f.setNow(102_000)
  await work.updateContent({ content: 'Two', expectedContentVersion: 2, reason: 'edit', author: null })
  expect((await mapping(work.id))?.due_at).toBe(105_000)
  await f.writer.runDue()
  expect([...f.transport.repositories.values()][0]?.length).toBe(1)
  for (let now = 104_000; now <= 128_000; now += 2_000) {
    f.setNow(now)
    await work.updateContent({ content: String(now), expectedContentVersion: work.contentVersion, reason: 'edit', author: null })
  }
  expect((await mapping(work.id))?.due_at).toBe(130_000)
  const pendingBodies = await database.getDatabase().all(sql`SELECT content_hash FROM work_storage_bodies WHERE work_id = ${work.id} AND commit_id IS NULL`)
  expect(pendingBodies).toHaveLength(1)
  await work.checkpoint({ reason: 'review', expectedContentVersion: work.contentVersion })
  expect((await mapping(work.id))?.due_at).toBe(128_000)
  await f.writer.runDue()
  expect([...f.transport.repositories.values()][0]?.length).toBe(2)
})

test('an edit during push remains pending', async () => {
  const f = await fixture()
  const work = await create()
  f.transport.duringPush = async () => {
    f.transport.duringPush = null
    await work.updateContent({ content: 'While pushing', expectedContentVersion: 1, reason: 'edit', author: null })
  }
  await f.writer.flush(work.id)
  const pending = await mapping(work.id)
  expect(pending!.generation).toBeGreaterThan(pending!.archived_generation)
  expect((await Work.byId('org-a', work.id)).content).toBe('While pushing')
  await f.writer.drain(work.id)
  const done = await mapping(work.id)
  expect(done!.generation).toBe(done!.archived_generation)
})

test('a lost push response recovers after database reopen without duplicate commits', async () => {
  const f = await fixture()
  const work = await create()
  f.transport.loseReply = true
  await expect(f.writer.flush(work.id)).rejects.toThrow('pending')
  expect((await mapping(work.id))?.operation).not.toBeNull()
  await database.closeDatabase()
  ;(await import('@solus/server/db')).closeDb()
  await new Writer(database.getDatabase, f.transport).drain(work.id)
  expect([...f.transport.repositories.values()][0]?.length).toBe(1)
  expect((await mapping(work.id))?.operation).toBeNull()
})

test.skipIf(process.env.SOLUS_DB === 'postgres')('offline publication stays local and corrupt remote bodies cannot restore', async () => {
  const f = await fixture()
  const local = await create('local')
  const transfer = await works.exportWorkForCloud('local', local.id)
  // Separate destination database, as work ids are globally unique.
  await database.closeDatabase()
  ;(await import('@solus/server/db')).closeDb()
  process.env.SOLUS_DATA_DIR = join(root, 'destination')
  try {
    const imported = await works.importWorkFromHost('org-a', transfer, 'user-alice')
    const work = await Work.byId('org-a', imported.id)
    f.transport.failPush = true
    await expect(work.flushStorage()).rejects.toThrow('not yet archived')
    expect((await Work.byId('org-a', work.id)).content).toBe('Original')
    f.transport.failPush = false
    await work.flushStorage()
    f.transport.corruptRead = true
    await expect(work.revision(1)).rejects.toThrow('hash')
  } finally {
    await database.closeDatabase()
    ;(await import('@solus/server/db')).closeDb()
    process.env.SOLUS_DATA_DIR = root
  }
  expect((await Work.byId('local', local.id)).content).toBe('Original')
})

test('deletion retains a durable cleanup record until remote removal succeeds', async () => {
  const f = await fixture()
  const work = await create()
  await work.flushStorage()
  await work.delete()
  expect(await works.loadWork('org-a', work.id)).toBeNull()
  f.transport.failRemove = true
  await expect(f.writer.flush(work.id)).rejects.toThrow('pending')
  expect(await mapping(work.id)).toBeDefined()
  f.transport.failRemove = false
  await f.writer.drain(work.id)
  expect(await mapping(work.id)).toBeUndefined()
  expect(f.transport.repositories.size).toBe(0)
})

test('durable live edits are projected and archived after restart without reopening a room', async () => {
  const { WorkLiveManager } = await import('@solus/server/work-live/work-live-manager')
  const manager = new WorkLiveManager({ publish: () => {} })
  const f = await fixture({ flushLive: workId => manager.flushPersisted(workId) })
  const work = await create()
  await work.flushStorage()
  const { seedLiveDoc, projectLiveDoc } = await import('@solus/server/work-live/live-codec')
  const doc = seedLiveDoc('Durable live edit')
  const author = { kind: 'agent', sessionId: 'live-author' } as const
  await (await import('@solus/server/work-live/live-store')).saveLiveDoc('org-a', work.id, {
    state: Y.encodeStateAsUpdate(doc), clientSeqs: new Map([['client', 1]]), lastAuthor: author, bodyVersion: 1, needsProjection: true,
  })
  await database.closeDatabase()
  ;(await import('@solus/server/db')).closeDb()
  await f.writer.drain(work.id)
  const saved = await Work.byId('org-a', work.id)
  expect(saved.content).toBe(projectLiveDoc(doc))
  expect(saved.contentAuthor).toEqual(author)
  expect((await mapping(work.id))!.generation).toBe((await mapping(work.id))!.archived_generation)
  doc.destroy()
})


test('native Git transport archives all work types and preserves exact bodies through restore', async () => {
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  const { GitWorkTransport } = await import('@solus/server/sync/works/git-work-transport')
  const directory = mkdtempSync(join(root, 'git-'))
  const transport = new GitWorkTransport({
    remote: async repository => {
      const path = join(directory, repository)
      mkdirSync(path, { recursive: true })
      execFileSync('git', ['init', '--bare', '--initial-branch=main'], { cwd: path, stdio: 'ignore' })
      return { url: new URL(`file://${path}`).href }
    },
    readFile: async (repository, commit, path) => execFileSync('git', ['show', `${commit}:${path}`], { cwd: join(directory, repository), encoding: 'utf8' }),
    remove: async repository => { rmSync(join(directory, repository), { recursive: true, force: true }) },
  })
  const writer = new Writer(database.getDatabase, transport)
  const artifacts = new archive.GitWorkStorage(transport, workId => writer.drain(workId))
  const { databaseWorkStorage } = await import('@solus/server/data/works/database-work-storage')
  restores.push(storage.installWorkStorage({ database: databaseWorkStorage, artifacts, defaultProvider: 'cloudflare-artifacts' }))
  for (const type of ['doc', 'slides', 'artifact'] as const) {
    const before = 'Original\n\n'
    const after = 'Changed\n\n'
    const created = await works.createWork('org-a', 'Native Git', type, before, '', undefined, 'codex')
    const work = await Work.byId('org-a', created.id)
    await work.flushStorage()
    await work.updateContent({ content: after, expectedContentVersion: 1, reason: 'agent', author: null })
    await work.flushStorage()
    expect((await work.revision(1)).content).toBe(before)
    await work.restoreRevision({ revisionId: 1, expectedContentVersion: 2, author: null })
    await work.flushStorage()
    expect((await works.exportWorkForCloud('org-a', work.id)).work.content).toBe(before)
    await work.delete()
    await writer.drain(work.id)
    expect(await mapping(work.id)).toBeUndefined()
  }
}, 60_000)

test('a second writer cannot claim the same work while a push is in flight', async () => {
  const f = await fixture()
  const work = await create()
  f.transport.duringPush = async () => {
    await new Writer(database.getDatabase, f.transport, () => 100_000).flush(work.id)
    await expect(new Writer(database.getDatabase, f.transport, () => 100_000).drain(work.id)).rejects.toThrow('already syncing')
  }
  await f.writer.flush(work.id)
  expect([...f.transport.repositories.values()][0]?.length).toBe(1)
})

test.skipIf(process.env.ARTIFACTS_WORK_ADAPTER_CLOUD !== '1')('real Cloudflare storage uses the production adapter for create, agent edit, archived read, restore and delete', async () => {
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  const { CloudflareWorkRepositories } = await import('@solus/server/sync/works/cloudflare-work-repositories')
  const { GitWorkTransport } = await import('@solus/server/sync/works/git-work-transport')
  const access = new CloudflareWorkRepositories(process.env.CLOUDFLARE_ACCOUNT_ID ?? '', 'default', process.env.ARTIFACTS_WORK_ADAPTER_TOKEN ?? '')
  const transport = new GitWorkTransport(access)
  let loseReply = true
  let firstCommit: string | null = null
  const writer = new Writer(database.getDatabase, {
    read: (repository, commit, hash) => transport.read(repository, commit, hash),
    remove: repository => transport.remove(repository),
    push: async (repository, operation, bodies) => {
      const commit = await transport.push(repository, operation, bodies)
      if (loseReply) { loseReply = false; firstCommit = commit; throw new Error('Simulated response lost after acceptance') }
      return commit
    },
  })
  const artifacts = new archive.GitWorkStorage(transport, workId => writer.drain(workId), Date.now, `${process.env.CLOUDFLARE_ACCOUNT_ID}/default`)
  const { databaseWorkStorage } = await import('@solus/server/data/works/database-work-storage')
  restores.push(storage.installWorkStorage({ database: databaseWorkStorage, artifacts, defaultProvider: 'cloudflare-artifacts' }))
  const owned: string[] = []
  try {
    for (const type of ['doc', 'slides', 'artifact'] as const) {
      const before = 'Cloud original\n\n'
      const after = 'Cloud changed\n\n'
      const created = await works.createWork('proof-organization', 'Adapter proof', type, before, '', undefined, 'codex')
      owned.push(created.id)
      const work = await Work.byId('proof-organization', created.id)
      if (type === 'doc') {
        await expect(work.flushStorage()).rejects.toThrow('not yet archived')
        await work.flushStorage()
        expect((await mapping(work.id))?.commit_id).toBe(firstCommit)
      } else await work.flushStorage()
      await work.updateContent({ content: after, expectedContentVersion: 1, reason: 'agent', author: null })
      await work.flushStorage()
      expect((await work.revision(1)).content).toBe(before)
      await work.restoreRevision({ revisionId: 1, expectedContentVersion: 2, author: null })
      await work.flushStorage()
      expect((await works.exportWorkForCloud('proof-organization', work.id)).work.content).toBe(before)
      expect((await mapping(work.id))?.commit_id).toMatch(/^[a-f0-9]{40}$/)
    }
  } finally {
    for (const workId of owned) {
      const work = await Work.find('proof-organization', workId)
      if (work) await work.delete()
      await writer.drain(workId)
      expect(await mapping(workId)).toBeUndefined()
    }
  }
}, 240_000)


test('startup validates selection and requires credentials for existing Artifacts mappings', async () => {
  const { startWorkStorage } = await import('@solus/server/sync/works/work-storage-runtime')
  const input = { database: database.getDatabase, flushLive: async () => {} }
  await expect(startWorkStorage({ ...input, cloud: true, env: { SOLUS_WORK_STORAGE: 'invalid' } })).rejects.toThrow()
  await expect(startWorkStorage({ ...input, cloud: false, env: { SOLUS_WORK_STORAGE: 'cloudflare-artifacts' } })).rejects.toThrow('cloud record service')
  await expect(startWorkStorage({ ...input, cloud: true, env: { SOLUS_WORK_STORAGE: 'cloudflare-artifacts' } })).rejects.toThrow('SOLUS_ARTIFACTS_ACCOUNT_ID')
  const configured = await startWorkStorage({ ...input, cloud: false, env: {} })
  const local = await create('org-a')
  expect((await mapping(local.id))?.provider).toBe('local-git')
  await configured.stop()
  await fixture()
  await create()
  await expect(startWorkStorage({ ...input, cloud: true, env: { SOLUS_WORK_STORAGE: 'database' } })).rejects.toThrow('SOLUS_ARTIFACTS_ACCOUNT_ID')
})

test('legacy works remain database-backed when the default changes', async () => {
  const { databaseWorkStorage } = await import('@solus/server/data/works/database-work-storage')
  restores.push(storage.installWorkStorage({ database: databaseWorkStorage }))
  const old = await create()
  await database.getDatabase().run(sql`DELETE FROM work_storage WHERE work_id = ${old.id}`)
  await fixture()
  await old.updateContent({ content: 'Legacy edit', expectedContentVersion: 1, reason: 'agent', author: null })
  expect((await Work.byId('org-a', old.id)).content).toBe('Legacy edit')
  expect(await mapping(old.id)).toBeUndefined()
})


test('changing the account/namespace cannot redirect an existing work', async () => {
  const f = await fixture()
  const work = await create()
  const replacement = new archive.GitWorkStorage(f.transport, workId => f.writer.drain(workId), Date.now, 'different-account/namespace')
  restores.push(storage.installWorkStorage({ database: f.local, artifacts: replacement, defaultProvider: 'cloudflare-artifacts' }))
  await expect(Work.byId('org-a', work.id)).rejects.toThrow('stored mapping')
})

test('an expired writer claim is fenced after another writer recovers the same remote operation', async () => {
  const f = await fixture()
  const work = await create()
  f.transport.duringPush = async () => {
    f.transport.duringPush = null
    await new Writer(database.getDatabase, f.transport, () => 500_000).drain(work.id)
  }
  await expect(f.writer.flush(work.id)).rejects.toThrow('pending')
  expect([...f.transport.repositories.values()][0]?.length).toBe(1)
  const state = await mapping(work.id)
  expect(state!.generation).toBe(state!.archived_generation)
  expect(state!.operation).toBeNull()
})


test('restart cannot project an old live doc over a newer committed agent body', async () => {
  const { WorkLiveManager } = await import('@solus/server/work-live/work-live-manager')
  const manager = new WorkLiveManager({ publish: () => {} })
  const f = await fixture({ flushLive: workId => manager.flushPersisted(workId) })
  const work = await create()
  const { seedLiveDoc } = await import('@solus/server/work-live/live-codec')
  const doc = seedLiveDoc('Original')
  await (await import('@solus/server/work-live/live-store')).saveLiveDoc('org-a', work.id, {
    state: Y.encodeStateAsUpdate(doc), clientSeqs: new Map(), bodyVersion: 1, needsProjection: false,
  })
  // No bridge callback: model a crash after the SQL body commit and before live absorption.
  await work.updateContent({ content: 'New agent body\n\n', expectedContentVersion: 1, reason: 'agent', author: null })
  await database.closeDatabase()
  ;(await import('@solus/server/db')).closeDb()
  await f.writer.drain(work.id)
  const recovered = await Work.byId('org-a', work.id)
  expect(recovered.content).toBe('New agent body\n\n')
  expect(recovered.contentVersion).toBe(2)
  await f.writer.drain(work.id)
  expect((await Work.byId('org-a', work.id)).contentVersion).toBe(2)
  doc.destroy()
})


test('a live receipt arriving between projection and claim cannot be marked archived with the older body', async () => {
  const { WorkLiveManager } = await import('@solus/server/work-live/work-live-manager')
  const { seedLiveDoc } = await import('@solus/server/work-live/live-codec')
  const manager = new WorkLiveManager({ publish: () => {} })
  const doc = seedLiveDoc('Late live edit')
  let injected = false
  const f = await fixture({ flushLive: async workId => {
    if (!injected) {
      injected = true
      await (await import('@solus/server/work-live/live-store')).saveLiveDoc('org-a', workId, {
        state: Y.encodeStateAsUpdate(doc), clientSeqs: new Map([['late', 1]]), bodyVersion: 1, needsProjection: true,
      })
    } else await manager.flushPersisted(workId)
  } })
  const work = await create()
  await f.writer.flush(work.id)
  expect(f.transport.repositories.size).toBe(0)
  expect((await mapping(work.id))?.archived_generation).toBe(0)
  await f.writer.drain(work.id)
  expect((await Work.byId('org-a', work.id)).content).toBe('Late live edit')
  expect((await mapping(work.id))!.generation).toBe((await mapping(work.id))!.archived_generation)
  doc.destroy()
})


test('legacy NULL empty bodies still read as empty, but a missing nonempty body is refused', async () => {
  const { databaseWorkStorage } = await import('@solus/server/data/works/database-work-storage')
  restores.push(storage.installWorkStorage({ database: databaseWorkStorage }))
  const empty = await works.createWork('local', 'Empty', 'doc', '', '', undefined, 'claude-code')
  await database.getDatabase().run(sql`UPDATE works SET content = NULL WHERE id = ${empty.id}`)
  expect((await Work.byId('local', empty.id)).content).toBe('')
  const nonempty = await create('local')
  await database.getDatabase().run(sql`UPDATE works SET content = NULL WHERE id = ${nonempty.id}`)
  await expect(Work.byId('local', nonempty.id)).rejects.toThrow('hash')
})

test('local Git archives all work types, survives reopen, and removes only its own repository', async () => {
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  const { LocalWorkRepositories } = await import('@solus/server/sync/works/local-work-repositories')
  const { GitWorkTransport } = await import('@solus/server/sync/works/git-work-transport')
  const { databaseWorkStorage } = await import('@solus/server/data/works/database-work-storage')
  const repositories = new LocalWorkRepositories(join(root, 'local-history'))
  const transport = new GitWorkTransport(repositories)
  const writer = new Writer(database.getDatabase, transport, Date.now, undefined, 'local-git')
  const localGit = new archive.GitWorkStorage(transport, id => writer.drain(id), Date.now, 'local', 'local-git')
  restores.push(storage.installWorkStorage({ database: databaseWorkStorage, localGit, defaultProvider: 'local-git' }))
  for (const type of ['doc', 'slides', 'artifact'] as const) {
    const before = 'Local original\n\n'
    const after = 'Local changed\n\n'
    const created = await works.createWork('local', 'Offline Git', type, before, '', undefined, 'codex')
    const work = await Work.byId('local', created.id)
    await work.flushStorage()
    await work.updateContent({ content: after, expectedContentVersion: 1, reason: 'agent', author: null })
    await work.flushStorage()
    const stored = await mapping(work.id)
    expect(stored?.provider).toBe('local-git')
    const repository = join(root, 'local-history', `${stored!.repository}.git`)
    expect(execFileSync('git', ['--git-dir', repository, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim()).toBe('2')
    await database.closeDatabase()
    ;(await import('@solus/server/db')).closeDb()
    const reopened = await Work.byId('local', work.id)
    expect((await reopened.revision(1)).content).toBe(before)
    await reopened.restoreRevision({ revisionId: 1, expectedContentVersion: 2, author: null })
    await reopened.flushStorage()
    expect((await works.loadWork('local', work.id))?.content).toBe(before)
    await reopened.delete()
    await writer.drain(work.id)
    expect(await mapping(work.id)).toBeUndefined()
    expect(await Bun.file(join(repository, 'HEAD')).exists()).toBe(false)
  }
  await expect(repositories.remove('../outside')).rejects.toThrow('Invalid')
}, 30_000)

test('legacy local history moves to Git without changing versions or losing revisions', async () => {
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  const { databaseWorkStorage } = await import('@solus/server/data/works/database-work-storage')
  restores.push(storage.installWorkStorage({ database: databaseWorkStorage }))
  const old = await create('local')
  await old.updateContent({ content: 'Existing edit', expectedContentVersion: 1, reason: 'agent', author: null })
  const before = await works.exportWorkForCloud('local', old.id)
  const { LocalWorkRepositories } = await import('@solus/server/sync/works/local-work-repositories')
  const { GitWorkTransport } = await import('@solus/server/sync/works/git-work-transport')
  const { migrateLocalWorkHistory } = await import('@solus/server/sync/works/local-work-migration')
  const transport = new GitWorkTransport(new LocalWorkRepositories(join(root, 'migrated-history')))
  const writer = new Writer(database.getDatabase, transport, Date.now, undefined, 'local-git')
  const localGit = new archive.GitWorkStorage(transport, id => writer.drain(id), Date.now, 'local', 'local-git')
  restores.push(storage.installWorkStorage({ database: databaseWorkStorage, localGit, defaultProvider: 'local-git' }))
  await migrateLocalWorkHistory(database.getDatabase, localGit)
  expect((await mapping(old.id))?.provider).toBe('local-git')
  await writer.drain(old.id)
  await migrateLocalWorkHistory(database.getDatabase, localGit)
  const after = await works.exportWorkForCloud('local', old.id)
  expect(after.fingerprint).toBe(before.fingerprint)
  expect(after.revisions).toEqual(before.revisions)
  expect((await mapping(old.id))?.generation).toBe((await mapping(old.id))?.archived_generation)
  const inline = await database.getDatabase().get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM work_revisions WHERE work_id = ${old.id} AND content IS NOT NULL`)
  expect(inline?.count).toBe(0)
}, 15_000)
