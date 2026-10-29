import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { WorkTransfer } from '@solus/contracts/work-transfer'
import type { Attribution, User } from '@solus/contracts/user'
import { WorkGitStore, WorkJournal } from './work-store'
import { ArtifactsCloud } from './cloud'
import { git, initBare, type GitRemote } from './process'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let root: string
let works: typeof import('@solus/server/data/works/works')
let workModule: typeof import('@solus/server/data/works/work')
const snapshots: WorkTransfer[] = []
let cloud: ArtifactsCloud | null = null
let completedCloudRepos = 0
let publicationReviewGap: { sourceReviewers: number; importedReviewers: number } | null = null
const receipts: Array<{ type: string; elapsedMs: number; scratchBytes: number; commit: string }> = []
const scale: Array<{ revisions: number; historyBodyBytes: number; publication: { scratchBytes: number; elapsedMs: number }; nextSave: { scratchBytes: number; elapsedMs: number } }> = []
const PERSON: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'proof-alice' }, displayName: 'Proof Alice' } }
const REVIEWER: User = { id: { kind: 'account', accountId: 'proof-bob' }, displayName: 'Proof Bob' }

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'solus-artifacts-proof-'))
  process.env.SOLUS_DATA_DIR = join(root, 'data')
  process.env.SOLUS_DB = 'sqlite'
  delete process.env.DATABASE_URL
  works = await import('@solus/server/data/works/works')
  workModule = await import('@solus/server/data/works/work')
  const annotations = await import('@solus/server/data/works/work-annotations')
  const reviews = await import('@solus/server/data/works/work-reviews')
  const bodies = [
    { type: 'doc', before: '# Spec\n\nLocal first. [Diagram](work://embed?workId=fixture-diagram&type=diagram)\n\n![Image](asset://proof-image)', after: '# Spec\n\nAgent revision. [Diagram](work://embed?workId=fixture-diagram&type=diagram)\n\n![Image](asset://proof-image)' },
    { type: 'diagram', before: '{"nodes":[],"edges":[]}', after: '{"nodes":[{"id":"a","label":"API"}],"edges":[]}' },
    { type: 'slides', before: '{"slides":[{"title":"Before"}]}', after: '{"slides":[{"title":"After"}]}' },
    { type: 'artifact', before: '<!doctype html><html><body>Before</body></html>', after: '<!doctype html><html><body>After</body></html>' },
  ] as const
  for (const [index, body] of bodies.entries()) {
    const created = await works.createWork('local', `Proof ${body.type}`, body.type, body.before, '', undefined, index % 2 ? 'codex' : 'claude-code', '~', undefined, PERSON)
    const work = await workModule.Work.byId('local', created.id)
    await work.updateContent({ content: body.after, author: { kind: 'agent', sessionId: `proof-${index}` }, expectedContentVersion: 1, reason: 'agent' })
    await work.restoreRevision({ revisionId: 1, author: PERSON, expectedContentVersion: 2 })
    await work.checkpoint({ reason: 'review', expectedContentVersion: 3 })
    if (index === 0 && PERSON.kind === 'user') {
      await reviews.requestWorkReview('local', work.id, { reviewers: [{ userId: 'proof-bob', displayName: 'Proof Bob' }], expectedContentVersion: 3 }, PERSON.user)
      await reviews.decideWorkReview('local', work.id, { decision: 'approved', target: { kind: 'current', contentVersion: 3 } }, REVIEWER)
    }
    await annotations.applyWorkComment('local', work.id, { kind: 'add', comment: { id: 'proof-comment', selectedText: '', comment: 'Keep this comment through publication.' } }, { by: PERSON, canModerate: true, now: Date.now() })
    // A final human edit has no history row: current content must travel separately.
    await work.updateContent({ content: body.after, author: PERSON, expectedContentVersion: 3, reason: 'edit' })
    snapshots.push(await works.exportWorkForCloud('local', work.id))
  }
  if (process.env.ARTIFACTS_PROOF_CLOUD === '1') {
    const prefix = `solus-proof-${Date.now().toString(36)}`
    cloud = process.env.ARTIFACTS_PROOF_AUTH === 'cf'
      ? await ArtifactsCloud.fromCf(process.env.CLOUDFLARE_ACCOUNT_ID ?? '', prefix)
      : await ArtifactsCloud.fromWrangler(process.env.CLOUDFLARE_ACCOUNT_ID ?? '', prefix)
  }
}, 60_000)

afterAll(async () => {
  const cleanupErrors = await cloud?.cleanup() ?? []
  const out = process.env.ARTIFACTS_PROOF_RESULTS
  if (out) {
    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'works.json'), JSON.stringify({ mode: cloud ? 'cloud' : 'local-git', snapshots: snapshots.length, completedCloudRepos, controlPlaneRequests: cloud?.operations ?? 0, receipts, publicationReviewGap, scale, cleanupErrors }, null, 2))
    await writeFile(join(out, 'work-fixtures.json'), JSON.stringify(snapshots, null, 2))
  }
  await (await import('@solus/server/db/database')).closeDatabase()
  ;(await import('@solus/server/db')).closeDb()
  await rm(root, { recursive: true, force: true })
  expect(cleanupErrors).toEqual([])
}, 120_000)

test('local work export keeps all types, history, unsnapshotted current body, authors, comments and links', () => {
  expect(snapshots.map(item => item.work.type)).toEqual(['doc', 'diagram', 'slides', 'artifact'])
  for (const snapshot of snapshots) {
    expect(snapshot.work.contentVersion).toBe(4)
    expect(snapshot.revisions.at(-1)?.sourceContentVersion).toBe(3)
    expect(snapshot.annotations?.comments[0]?.comment).toContain('publication')
    expect(snapshot.fingerprint).toBe(works.workTransferFingerprint(snapshot))
  }
  expect(snapshots[0]!.work.content).toContain('asset://proof-image')
  expect(snapshots[0]!.work.content).toContain('work://embed')
})

test('all work types round trip through fresh Git object stores and publication retries keep commit identity', async () => {
  for (const [index, snapshot] of snapshots.entries()) {
    const remote = await initBare(join(root, `work-${index}.git`))
    const journal = new WorkJournal(join(root, `journal-${index}.sqlite`))
    try {
      const store = new WorkGitStore(remote)
      const receipt = await store.publish(snapshot, journal)
      expect(await new WorkGitStore(remote).read()).toEqual(snapshot)
      expect((await new WorkGitStore(remote).publish(snapshot, journal)).commit).toBe(receipt.commit)
      expect(journal.read(snapshot.fingerprint)).toMatchObject({ status: 'complete', payload: null })
      receipts.push({ type: snapshot.work.type, ...receipt })
    } finally { journal.close() }
  }
}, 60_000)

test('the Git snapshot can be imported by the existing Solus cloud importer with the same fingerprint', async () => {
  const snapshot = snapshots[0]!
  const remote = cloud ? await cloud.create('import') : await initBare(join(root, 'import.git'))
  const journal = new WorkJournal(join(root, 'import.sqlite'))
  try {
    await new WorkGitStore(remote).publish(snapshot, journal)
    const recovered = await new WorkGitStore(remote).read()
    expect(works.workTransferFingerprint(recovered)).toBe(snapshot.fingerprint)
    // Separate databases are needed because work ids are global primary keys.
    const database = await import('@solus/server/db/database')
    const rawDb = await import('@solus/server/db')
    const reviews = await import('@solus/server/data/works/work-reviews')
    const sourceReview = await reviews.loadWorkReview('local', snapshot.work.id)
    await database.closeDatabase()
    rawDb.closeDb()
    process.env.SOLUS_DATA_DIR = join(root, 'cloud-data')
    const imported = await works.importWorkFromHost('proof-organization', recovered)
    expect(imported.organizationId).toBe('proof-organization')
    expect((await works.exportWorkForCloud('proof-organization', snapshot.work.id)).fingerprint).toBe(snapshot.fingerprint)
    expect(await works.importWorkFromHost('proof-organization', recovered)).toEqual(imported)
    expect(await works.loadWork('another-organization', snapshot.work.id)).toBeNull()
    const importedReview = await reviews.loadWorkReview('proof-organization', snapshot.work.id)
    publicationReviewGap = { sourceReviewers: sourceReview.reviewers.length, importedReviewers: importedReview.reviewers.length }
    // This is a measured migration gap, not an Artifacts feature claim.
    expect(publicationReviewGap).toEqual({ sourceReviewers: 1, importedReviewers: 0 })
    const importedWork = await workModule.Work.byId('proof-organization', snapshot.work.id)
    const historyBefore = await importedWork.revisions()
    await importedWork.restoreRevision({ revisionId: snapshot.revisions[0]!.revisionId, author: PERSON, expectedContentVersion: snapshot.work.contentVersion })
    expect(importedWork.content).toBe(snapshot.revisions[0]!.content)
    expect(importedWork.contentVersion).toBe(snapshot.work.contentVersion + 1)
    for (const revision of historyBefore) expect(await importedWork.revision(revision.revisionId)).toEqual(snapshot.revisions.find(item => item.revisionId === revision.revisionId)!)
    const restored = await works.exportWorkForCloud('proof-organization', importedWork.id)
    await new WorkGitStore(remote).publish(restored, journal, { expectedContentVersion: snapshot.work.contentVersion })
    expect(await new WorkGitStore(remote).read()).toEqual(restored)
    await database.closeDatabase()
    rawDb.closeDb()
    process.env.SOLUS_DATA_DIR = join(root, 'data')
  } finally { journal.close() }
}, 60_000)

test('a stopped publication leaves the source local and a changed source is never moved using an old fingerprint', async () => {
  const snapshot = snapshots[0]!
  const source = await workModule.Work.byId('local', snapshot.work.id)
  await source.updateContent({ content: '# Newer local edit', author: PERSON, expectedContentVersion: source.contentVersion, reason: 'edit' })
  await expect(works.markWorkMoved('local', source.id, snapshot.fingerprint, 'proof-organization')).rejects.toThrow('changed during')
  expect((await works.loadWork('local', source.id))?.content).toBe('# Newer local edit')
})

test('a push whose answer is lost recovers once after the journal reopens', async () => {
  const snapshot = snapshots[1]!
  const remote = cloud ? await cloud.create('lost-answer') : await initBare(join(root, 'lost-answer.git'))
  const journalPath = join(root, 'lost-answer.sqlite')
  let journal = new WorkJournal(journalPath)
  try {
    await expect(new WorkGitStore(remote).publish(snapshot, journal, { afterPush: async () => { throw new Error('injected lost answer') } })).rejects.toThrow('lost answer')
    expect(journal.read(snapshot.fingerprint)).toMatchObject({ status: 'pending' })
    journal.close()
    journal = new WorkJournal(journalPath)
    const pending = journal.read(snapshot.fingerprint)
    expect(pending?.payload).toBeTruthy()
    // SAFETY: pending is this test's verified transfer, serialized by WorkJournal; publish rechecks the fingerprint and every body hash.
    const receipt = await new WorkGitStore(remote).publish(JSON.parse(pending!.payload!) as WorkTransfer, journal)
    const reader = join(root, 'lost-answer-reader')
    await git(root, ['clone', '--bare', remote.url, reader], { remote })
    const count = await git(reader, ['rev-list', '--count', 'main'])
    expect(Number(count.stdout.trim())).toBe(snapshot.revisions.length + 1)
    expect(journal.read(snapshot.fingerprint)).toMatchObject({ status: 'complete', commit: receipt.commit })
  } finally { journal.close() }
}, 60_000)

test('a failure before push keeps a durable draft and can retry without remote history', async () => {
  const snapshot = snapshots[2]!
  const remote = cloud ? await cloud.create('before-push') : await initBare(join(root, 'before-push.git'))
  const journal = new WorkJournal(join(root, 'before-push.sqlite'))
  try {
    await expect(new WorkGitStore(remote).publish(snapshot, journal, { beforePush: async () => { throw new Error('injected offline') } })).rejects.toThrow('offline')
    expect(journal.read(snapshot.fingerprint)?.payload).toBe(JSON.stringify(snapshot))
    expect((await git(root, ['ls-remote', remote.url, 'refs/heads/main'], { remote })).stdout.trim()).toBe('')
    await new WorkGitStore(remote).publish(snapshot, journal)
    expect(await new WorkGitStore(remote).read()).toEqual(snapshot)
  } finally { journal.close() }
}, 60_000)

test('corrupt content, missing history, and changed immutable revisions cannot replace a cloud snapshot', async () => {
  const snapshot = snapshots[3]!
  const remote = cloud ? await cloud.create('invalid') : await initBare(join(root, 'invalid.git'))
  const journal = new WorkJournal(join(root, 'invalid.sqlite'))
  try {
    await new WorkGitStore(remote).publish(snapshot, journal)
    const corrupt = structuredClone(snapshot)
    corrupt.work.content = 'corrupt'
    await expect(new WorkGitStore(remote).publish(corrupt, journal)).rejects.toThrow('fingerprint')
    const missing = structuredClone(snapshot)
    missing.revisions.shift()
    missing.fingerprint = works.workTransferFingerprint(missing)
    await expect(new WorkGitStore(remote).publish(missing, journal, { expectedContentVersion: snapshot.work.contentVersion })).rejects.toThrow('History cannot lose revisions')
    const rewritten = structuredClone(snapshot)
    rewritten.revisions[0]!.reason = 'checkpoint'
    rewritten.fingerprint = works.workTransferFingerprint(rewritten)
    await expect(new WorkGitStore(remote).publish(rewritten, journal, { expectedContentVersion: snapshot.work.contentVersion })).rejects.toThrow('immutable revision changed')
    expect(await new WorkGitStore(remote).read()).toEqual(snapshot)
  } finally { journal.close() }
}, 60_000)

test('concurrent writers at the same remote version accept one push and retain immutable history', async () => {
  const snapshot = snapshots[3]!
  const remote = cloud ? await cloud.create('race') : await initBare(join(root, 'race.git'))
  const journal = new WorkJournal(join(root, 'race.sqlite'))
  try {
    await new WorkGitStore(remote).publish(snapshot, journal)
    const candidates = ['A', 'B'].map(label => {
      const next = structuredClone(snapshot)
      next.work.content = `<html>${label}</html>`
      next.work.contentVersion += 1
      next.work.contentHash = Bun.CryptoHasher.hash('sha256', next.work.content, 'hex')
      next.fingerprint = works.workTransferFingerprint(next)
      return next
    })
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const beforePush = async () => { if (++arrived === 2) release(); await gate }
    const results = await Promise.allSettled(candidates.map(candidate => new WorkGitStore(remote).publish(candidate, journal, { expectedContentVersion: 4, beforePush })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const saved = await new WorkGitStore(remote).read()
    expect(saved.work.contentVersion).toBe(5)
    expect(saved.revisions).toEqual(snapshot.revisions)
    const loser = candidates.find(candidate => candidate.fingerprint !== saved.fingerprint)!
    await expect(new WorkGitStore(remote).publish(loser, journal, { expectedContentVersion: 3 })).rejects.toThrow()
  } finally { journal.close() }
}, 60_000)

test.skipIf(process.env.ARTIFACTS_PROOF_CLOUD !== '1')('real Artifacts preserves every work type and serves exact historical content over its HTTP interface', async () => {
  for (const snapshot of snapshots) {
    const remote = await cloud!.create(snapshot.work.type)
    const journal = new WorkJournal(join(root, `cloud-${snapshot.work.type}.sqlite`))
    try {
      const receipt = await new WorkGitStore(remote).publish(snapshot, journal)
      expect(await new WorkGitStore(remote).read()).toEqual(snapshot)
      const ext = snapshot.work.type === 'doc' ? 'md' : snapshot.work.type === 'artifact' ? 'html' : 'json'
      expect(await cloud!.readFile(remote.name, receipt.commit, `content.${ext}`)).toBe(snapshot.work.content)
      expect((await new WorkGitStore(remote).publish(snapshot, journal)).commit).toBe(receipt.commit)
      const readRemote: GitRemote = { url: remote.url, token: await cloud!.issueToken(remote.name, 'read') }
      expect(await new WorkGitStore(readRemote).read()).toEqual(snapshot)
      const changed = structuredClone(snapshot)
      changed.work.title += ' read token must not write'
      changed.fingerprint = works.workTransferFingerprint(changed)
      await expect(new WorkGitStore(readRemote).publish(changed, journal, { expectedContentVersion: snapshot.work.contentVersion })).rejects.toThrow()
      completedCloudRepos += 1
      receipts.push({ type: `cloud-${snapshot.work.type}`, ...receipt })
    } finally { journal.close() }
  }
}, 240_000)

test('scale: an ordinary save fetches metadata instead of all historical bodies', async () => {
  for (const count of [1, 40]) {
    const transfer = structuredClone(snapshots[0]!)
    transfer.annotations = null
    transfer.revisions = []
    transfer.previousRevisionId = null
    const baseTime = Date.now()
    for (let index = 1; index <= count; index++) {
      const content = randomBytes(96 * 1024).toString('base64')
      transfer.revisions.push({ workId: transfer.work.id, revisionId: index, reason: index === 1 ? 'baseline' : 'agent', sourceContentVersion: index, author: PERSON, contentHash: Bun.CryptoHasher.hash('sha256', content, 'hex'), capturedAt: new Date(baseTime + index).toISOString(), content })
    }
    const last = transfer.revisions.at(-1)!
    transfer.work.content = last.content
    transfer.work.contentVersion = count
    transfer.work.contentHash = last.contentHash
    transfer.work.updatedAt = last.capturedAt
    transfer.fingerprint = works.workTransferFingerprint(transfer)
    const remote = cloud ? await cloud.create(`scale-${count}`) : await initBare(join(root, `scale-${count}.git`))
    const journal = new WorkJournal(join(root, `scale-${count}.sqlite`))
    try {
      const publication = await new WorkGitStore(remote).publish(transfer, journal)
      const next = structuredClone(transfer)
      next.work.content = 'Small current edit'
      next.work.contentVersion += 1
      next.work.contentHash = Bun.CryptoHasher.hash('sha256', next.work.content, 'hex')
      next.work.updatedAt = new Date(baseTime + count + 1).toISOString()
      next.fingerprint = works.workTransferFingerprint(next)
      const nextSave = await new WorkGitStore(remote).publish(next, journal, { expectedContentVersion: count })
      const historyBodyBytes = transfer.revisions.reduce((bytes, revision) => bytes + Buffer.byteLength(revision.content), 0)
      if (count === 40) expect(nextSave.scratchBytes).toBeLessThan(historyBodyBytes / 2)
      scale.push({ revisions: count, historyBodyBytes, publication, nextSave })
      expect(await new WorkGitStore(remote).read()).toEqual(next)
    } finally { journal.close() }
  }
}, 240_000)
