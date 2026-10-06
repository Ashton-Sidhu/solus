import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'
import type { Principal } from '@solus/server/admission/principal'
import type { Attribution } from '@solus/contracts/user'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { getDatabase } = await import('@solus/server/db/database')
const { ShareManager } = await import('@solus/server/sharing/share-manager')
const { SharedPromptRelay } = await import('@solus/server/sharing/shared-prompt')
const { upsertSessionRecord } = await import('@solus/server/data/sessions/session-records')
const { ticketForGrant } = await import('@solus/server/transport/http')

let dataDir: string
const oldDataDir = process.env.SOLUS_DATA_DIR
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'solus-p4-')); process.env.SOLUS_DATA_DIR = dataDir })
afterEach(async () => { await resetTestDatabase(); rmSync(dataDir, { recursive: true, force: true }); if (oldDataDir === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = oldDataDir })
const alice: Extract<Principal, { kind: 'org-member' }> = { kind: 'org-member', hostKind: 'cloud', organizationId: 'org1', organizationRole: 'owner', userId: 'alice', teamIds: [], displayName: 'Alice', deviceId: 'alice', deviceLabel: 'Cloud', expiresAt: Date.now() + 60_000 }
const runner: Extract<Principal, { kind: 'runner' }> = { kind: 'runner', organizationId: 'org1', ownerUserId: 'alice', hostId: 'runner1', deviceId: 'runner1', deviceLabel: 'Runner', expiresAt: Date.now() + 60_000 }
const resource = { kind: 'session', id: 'session1' } as const
async function fixture() {
  const shares = new ShareManager({ db: getDatabase() })
  await shares.claimOwner(resource, alice)
  const link = (await shares.setLink({ resource, role: 'editor' }, alice))!
  const resolved = (await shares.resolveLinkSecret(link.secret))!
  const guest: Extract<Principal, { kind: 'guest' }> = { kind: 'guest', organizationId: resolved.organizationId, guestId: 'maya', displayName: 'Maya', deviceId: 'maya', deviceLabel: 'Guest', share: resolved, expiresAt: Date.now() + 60_000 }
  await upsertSessionRecord('org1', { sessionId: resource.id, provider: 'claude-code', projectPath: '/fixture', lastActivityAt: Date.now(), runnerHostId: runner.hostId })
  return { shares, guest, relay: new SharedPromptRelay(shares), link }
}

test('guest access follows the resolved organization, cannot reach other records, and follows revocation', async () => {
  const { shares, guest } = await fixture()
  expect(await shares.roleFor(guest, resource)).toBe('editor')
  expect(await shares.roleFor({ ...guest, organizationId: 'org2' }, resource)).toBe('none')
  expect(await shares.roleFor(guest, { kind: 'session', id: 'other' })).toBe('none')
  await shares.setLink({ resource, role: 'viewer' }, alice)
  expect(await shares.roleFor(guest, resource)).toBe('viewer')
  await shares.setLink({ resource, role: null }, alice)
  expect(await shares.roleFor(guest, resource)).toBe('none')
})

test('a stopped runner gets no accepted prompt or retained work', async () => {
  const { guest, relay } = await fixture()
  expect(await relay.available(guest, resource.id)).toBe(false)
  await expect(relay.prompt(guest, { sessionId: resource.id, text: 'hello' })).rejects.toThrow('offline')
  expect((await relay.poll(runner)).commands).toEqual([])
})

test('only the selected runner receives the prompt; its receipt uses the sharer seat and never dispatches twice', async () => {
  const { guest, relay } = await fixture()
  await relay.poll(runner)
  const pending = relay.prompt(guest, { sessionId: resource.id, text: 'hello' })
  let commands = (await relay.poll(runner)).commands
  for (const deadline = Date.now() + 5_000; !commands.length && Date.now() < deadline;) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    commands = (await relay.poll(runner)).commands
  }
  expect(commands).toHaveLength(1)
  const command = commands[0]!
  expect(command.actor).toEqual({ userId: 'guest:maya', seatUserId: 'alice', displayName: 'Maya' })
  expect((await relay.poll(runner)).commands).toEqual([])
  expect(relay.result({ ...runner, organizationId: 'org2' }, { hostId: runner.hostId, requestId: command.requestId, error: null }).ok).toBe(false)
  expect(relay.result(runner, { hostId: runner.hostId, requestId: command.requestId, error: null }).ok).toBe(true)
  expect(await pending).toEqual({ accepted: true })
})

test('a viewer cannot submit and a host refuses guest grants before looking up the secret', async () => {
  const { shares, guest, relay, link } = await fixture()
  await shares.setLink({ resource, role: 'viewer' }, alice)
  await relay.poll(runner)
  await expect(relay.prompt(guest, { sessionId: resource.id, text: 'no' })).rejects.toThrow('not shared')
  const now = Math.floor(Date.now() / 1000)
  let lookedUp = false
  const result = await ticketForGrant({ iss: 'https://cloud.test', aud: 'runner1', sub: 'guest:maya', deviceId: 'maya', access: 'guest', hostKind: 'personal', jti: 'j', iat: now, exp: now + 60 }, { shareSecret: link.secret }, async () => { lookedUp = true; return { ...guest.share, organizationId: 'org1' } }, { workspace: false })
  expect(result).toEqual({ ok: false, reason: 'member-required' })
  expect(lookedUp).toBe(false)
})


/** Read the work, then write naming the content version that read saw. */
async function edit(work: typeof import('@solus/server/data/works/work').Work, scope: string, workId: string, write: { content: string; author: Attribution; reason: 'edit' | 'agent' }) {
  const current = await work.byId(scope, workId)
  return current.updateContent({ ...write, expectedContentVersion: current.contentVersion })
}

test('a caller-chosen work id cannot replace an existing work in any organization', async () => {
  const { createWork, loadWork } = await import('@solus/server/data/works/works')
  await createWork('org1', 'Original', 'doc', 'kept', '', undefined, 'claude-code', '~', 'stable-id')
  await expect(createWork('org2', 'Other', 'doc', 'wrong', '', undefined, 'claude-code', '~', 'stable-id')).rejects.toThrow()
  await expect(createWork('org1', 'Retry', 'doc', 'wrong', '', undefined, 'claude-code', '~', 'stable-id')).rejects.toThrow()
  expect((await loadWork('org1', 'stable-id'))?.content).toBe('kept')
  expect(await loadWork('org2', 'stable-id')).toBeNull()
})

const ALICE: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice' } }
const BOB: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' } }
const AGENT: Attribution = { kind: 'agent', sessionId: 'session-7' }

/** Another database represents the workspace service, just as the Lab does; the source database is kept for after. */
async function atDestination<T>(run: () => Promise<T>): Promise<T> {
  await resetTestDatabase()
  const sourceDir = process.env.SOLUS_DATA_DIR!
  const destinationDir = mkdtempSync(join(tmpdir(), 'solus-p4-destination-'))
  process.env.SOLUS_DATA_DIR = destinationDir
  try {
    return await run()
  } finally { await resetTestDatabase(); process.env.SOLUS_DATA_DIR = sourceDir; rmSync(destinationDir, { recursive: true, force: true }) }
}

/** A work with a baseline, an agent write, a person's edit, and a restore of the baseline, plus one comment. */
async function workWithHistory(id: string) {
  const { createWork } = await import('@solus/server/data/works/works')
  const { Work } = await import('@solus/server/data/works/work')
  const { applyWorkComment } = await import('@solus/server/data/works/work-annotations')
  await createWork('local', 'A document', 'doc', 'first', '', undefined, 'claude-code', '~', id, ALICE)
  await edit(Work, 'local', id, { content: 'second', author: AGENT, reason: 'agent' })
  await edit(Work, 'local', id, { content: 'third', author: BOB, reason: 'edit' })
  const current = await Work.byId('local', id)
  await current.restoreRevision({ revisionId: 1, author: ALICE, expectedContentVersion: current.contentVersion })
  await applyWorkComment('local', id, { kind: 'add', comment: { id: 'comment1', selectedText: 'first', comment: 'Keep this' } }, { by: { kind: 'system' }, canModerate: true, now: 100 })
  return Work.byId('local', id)
}

test.skipIf(process.env.SOLUS_DB === 'postgres')('a cloud push carries every revision with its identity and author, and the previous version still works', async () => {
  const { exportWorkForCloud, importWorkFromHost } = await import('@solus/server/data/works/works')
  const { Work } = await import('@solus/server/data/works/work')
  const { loadWorkAnnotations } = await import('@solus/server/data/works/work-annotations')
  const source = await workWithHistory('history-work')
  const sourceHistory = await source.revisions()
  const sourcePrevious = await source.previous()
  const transfer = await exportWorkForCloud('local', 'history-work')
  // The person's edit left no row until the restore displaced it; the restore is its own row.
  expect(transfer.revisions.map(({ revisionId, reason, sourceContentVersion, author, content }) => ({ revisionId, reason, sourceContentVersion, author, content }))).toEqual([
    { revisionId: 1, reason: 'baseline', sourceContentVersion: 1, author: ALICE, content: 'first' },
    { revisionId: 2, reason: 'agent', sourceContentVersion: 2, author: AGENT, content: 'second' },
    { revisionId: 3, reason: 'checkpoint', sourceContentVersion: 3, author: BOB, content: 'third' },
    { revisionId: 4, reason: 'restore', sourceContentVersion: 4, author: ALICE, content: 'first' },
  ])
  expect(transfer.previousRevisionId).toBe(3)
  expect(transfer.work).toMatchObject({ organizationId: 'local', content: 'first', contentVersion: 4, contentAuthor: ALICE })

  await atDestination(async () => {
    await importWorkFromHost('org1', transfer)
    const imported = await Work.byId('org1', 'history-work')
    expect(imported.organizationId).toBe('org1')
    expect(imported).toMatchObject({ content: 'first', contentVersion: 4, contentHash: source.contentHash, contentAuthor: ALICE })
    expect(await imported.revisions()).toEqual(sourceHistory)
    expect(await imported.previous()).toEqual(sourcePrevious)
    expect((await loadWorkAnnotations('org1', 'history-work'))?.comments[0]?.comment).toBe('Keep this')

    // A retry of the same transfer answers the stored work and writes nothing.
    expect((await exportWorkForCloud('org1', 'history-work')).fingerprint).toBe(transfer.fingerprint)
    await importWorkFromHost('org1', transfer)
    expect(await imported.revisions()).toEqual(sourceHistory)

    // Revert after import reaches the body the restore displaced, and history continues past the source's ids.
    const carol: Attribution = { kind: 'user', user: { id: { kind: 'account', accountId: 'carol' }, displayName: 'Carol' } }
    await imported.restoreRevision({ revisionId: imported.previousRevisionId!, author: carol, expectedContentVersion: 4 })
    expect(imported).toMatchObject({ content: 'third', contentVersion: 5, contentAuthor: carol })
    expect((await imported.revisions()).at(-1)).toMatchObject({ revisionId: 5, reason: 'restore', sourceContentVersion: 5, author: carol })
    expect((await imported.previous())?.content).toBe('first')
    await expect(importWorkFromHost('org1', transfer)).rejects.toThrow('different version')
  })
})

test.skipIf(process.env.SOLUS_DB === 'postgres')('the destination refuses a history that does not belong to the work, and writes nothing', async () => {
  const { exportWorkForCloud, importWorkFromHost, loadWork, workTransferFingerprint } = await import('@solus/server/data/works/works')
  const { documentContentHash } = await import('@solus/server/docs/content-hash')
  await workWithHistory('checked-work')
  const transfer = await exportWorkForCloud('local', 'checked-work')
  type Transfer = typeof transfer
  /** A sender can always make the outer fingerprint agree with what it sends. */
  const resealed = (changed: Omit<Transfer, 'fingerprint'>): Transfer => ({ ...changed, fingerprint: workTransferFingerprint(changed) })
  const [first, second] = transfer.revisions
  const cases: Array<[Transfer, string]> = [
    [{ ...transfer, work: { ...transfer.work, content: 'changed' } }, 'incomplete'],
    [resealed({ ...transfer, previousRevisionId: 99 }), 'previous version names a revision'],
    [resealed({ ...transfer, revisions: [first!, { ...second!, workId: 'other-work' }] }), 'belongs to another work'],
    [resealed({ ...transfer, revisions: [first!, first!] }), 'repeated or out-of-order'],
    [resealed({ ...transfer, revisions: [second!, first!] }), 'repeated or out-of-order'],
    [resealed({ ...transfer, revisions: [first!, { ...second!, content: 'tampered' }] }), 'Revision 2 does not match its content hash'],
    [resealed({ ...transfer, revisions: [first!, { ...second!, sourceContentVersion: 99 }] }), 'content version the work never had'],
    [resealed({ ...transfer, work: { ...transfer.work, content: 'changed' } }), 'does not match its content hash'],
    [resealed({ ...transfer, work: { ...transfer.work, content: 'changed', contentHash: documentContentHash('changed'), contentVersion: 0 } }), 'no valid content version'],
  ]
  await atDestination(async () => {
    for (const [tampered, error] of cases) await expect(importWorkFromHost('org1', tampered)).rejects.toThrow(error)
    expect(await loadWork('org1', 'checked-work')).toBeNull()
    await importWorkFromHost('org1', transfer)
    expect((await loadWork('org1', 'checked-work'))?.content).toBe('first')
  })
})

test.skipIf(process.env.SOLUS_DB === 'postgres')('a member uploads a Local work under its own id: again is the same answer, another organization is refused, and no host is involved', async () => {
  // WHY: sharing a work needs only the person's sign-in (docs/plans/cloud-sharing.md §3).
  // The kept id is what makes a Share that stopped halfway safe to repeat: the second
  // upload must not make a second copy, and a work cannot land in two organizations.
  const { exportWorkForCloud, loadWork } = await import('@solus/server/data/works/works')
  const { SolusServer } = await import('@solus/server/transport/server')
  const { registerCloudUploadHandlers } = await import('@solus/server/transport/solus-api/cloud-uploads')
  const { resetApiModeForTests } = await import('@solus/server/host/api-mode')
  await workWithHistory('shared-work')
  const transfer = await exportWorkForCloud('local', 'shared-work')
  const bob: Extract<Principal, { kind: 'org-member' }> = { ...alice, organizationId: 'org2', userId: 'bob', displayName: 'Bob', deviceId: 'bob' }
  const call = (server: InstanceType<typeof SolusServer>, principal: Principal, input: unknown) =>
    server.handle('workUpload', [input as typeof transfer], { clientId: principal.deviceId ?? 'c', principal })

  const host = new SolusServer()
  registerCloudUploadHandlers(host, { shares: new ShareManager({ db: getDatabase() }) })
  await expect(call(host, alice, transfer)).rejects.toThrow(/not to a machine/)

  const previous = process.env.SOLUS_API
  process.env.SOLUS_API = '1'
  resetApiModeForTests()
  try {
    await atDestination(async () => {
      const shares = new ShareManager({ db: getDatabase() })
      const service = new SolusServer()
      registerCloudUploadHandlers(service, { shares })
      expect(await call(service, alice, transfer)).toEqual({ workId: 'shared-work', organizationId: 'org1' })
      expect((await loadWork('org1', 'shared-work'))?.content).toBe('first')
      expect(await shares.ownerOf({ kind: 'work', id: 'shared-work' })).toBe('alice')
      expect(await shares.roleFor({ ...alice, userId: 'carol', organizationRole: 'member' }, { kind: 'work', id: 'shared-work' })).not.toBe('none')

      expect(await call(service, alice, transfer)).toEqual({ workId: 'shared-work', organizationId: 'org1' })
      await expect(call(service, bob, transfer)).rejects.toThrow(/another organization/)
      expect(await loadWork('org2', 'shared-work')).toBeNull()

      // A transfer that carries no history, like one from before this shape, is refused at the door.
      const { revisions: _revisions, previousRevisionId: _previousRevisionId, ...withoutHistory } = transfer
      await expect(call(service, alice, { ...withoutHistory, id: 'other' })).rejects.toThrow()
    })
  } finally {
    if (previous === undefined) delete process.env.SOLUS_API
    else process.env.SOLUS_API = previous
    resetApiModeForTests()
  }
})

test.skipIf(process.env.SOLUS_DB === 'postgres')('a source change during the push, even history alone, keeps the local copy', async () => {
  const { exportWorkForCloud, loadWork, markWorkMoved } = await import('@solus/server/data/works/works')
  const { Work } = await import('@solus/server/data/works/work')
  const { applyWorkComment } = await import('@solus/server/data/works/work-annotations')
  const work = await workWithHistory('push-work')

  const beforeCheckpoint = await exportWorkForCloud('local', 'push-work')
  await work.checkpoint({ reason: 'review', expectedContentVersion: work.contentVersion })
  await expect(markWorkMoved('local', 'push-work', beforeCheckpoint.fingerprint, 'org-1')).rejects.toThrow('local copy was kept')

  const beforeComment = await exportWorkForCloud('local', 'push-work')
  await applyWorkComment('local', 'push-work', { kind: 'add', comment: { id: 'comment2', selectedText: 'first', comment: 'Another' } }, { by: { kind: 'system' }, canModerate: true, now: 200 })
  await expect(markWorkMoved('local', 'push-work', beforeComment.fingerprint, 'org-1')).rejects.toThrow('local copy was kept')

  const beforeEdit = await exportWorkForCloud('local', 'push-work')
  await edit(Work, 'local', 'push-work', { content: 'new edit', author: BOB, reason: 'edit' })
  await expect(markWorkMoved('local', 'push-work', beforeEdit.fingerprint, 'org-1')).rejects.toThrow('local copy was kept')
  expect((await loadWork('local', 'push-work'))?.content).toBe('new edit')

  // An unchanged work points at the organization once the service holds it.
  await markWorkMoved('local', 'push-work', (await exportWorkForCloud('local', 'push-work')).fingerprint, 'org-1')
  expect(await loadWork('local', 'push-work')).toBeNull()
})

test('a shared work points at its organization and keeps its content, so a reference to its id here learns where it went', async () => {
  // WHY: transcripts, task links, and embeds name a work by id, and some of them
  // cannot change after Share. The row points at the organization that has the
  // work now (cloud-sharing.md §3a), so the host answers "moved to org-1", not
  // "not found". Share changes the pointer only: the body, history, and comments
  // stay on this host, so nothing is lost if the cloud copy is.
  const { exportWorkForCloud, listWorks, loadWork, markWorkMoved } = await import('@solus/server/data/works/works')
  const { Work, WorkMovedError } = await import('@solus/server/data/works/work')
  const { sql } = await import('drizzle-orm')
  await workWithHistory('moved-work')

  const before = await exportWorkForCloud('local', 'moved-work')
  expect(before.revisions.length).toBeGreaterThan(0)
  await markWorkMoved('local', 'moved-work', before.fingerprint, 'org-1')

  const moved = await Work.byId('local', 'moved-work').catch((error) => error)
  expect(moved).toBeInstanceOf(WorkMovedError)
  expect(moved).toMatchObject({ code: 'MOVED', location: { organizationId: 'org-1' } })
  expect(await loadWork('local', 'moved-work')).toBeNull()
  expect((await listWorks('local')).map((work) => work.id)).not.toContain('moved-work')
  const db = getDatabase()
  expect(await db.get(sql`SELECT content FROM works WHERE id = 'moved-work'`)).toEqual({ content: before.work.content })
  expect(await db.get(sql`SELECT COUNT(*) AS count FROM work_revisions WHERE work_id = 'moved-work'`)).toEqual({ count: before.revisions.length })
  expect(await db.get(sql`SELECT COUNT(*) AS count FROM work_annotations WHERE work_id = 'moved-work'`)).toEqual({ count: before.annotations ? 1 : 0 })
})

test('a work from before versions transfers with its unknown authors and null source versions kept', async () => {
  const { exportWorkForCloud, importWorkFromHost } = await import('@solus/server/data/works/works')
  const { Work } = await import('@solus/server/data/works/work')
  const { documentContentHash } = await import('@solus/server/docs/content-hash')
  const { sql } = await import('drizzle-orm')
  const db = getDatabase()
  // The rows as the work-legacy-removal migration leaves them: hashes, one unattributed
  // baseline, legacy revisions with no source version, and the old newest revision as previous.
  await db.run(sql`
    INSERT INTO works (id, title, preview, type, session_id, agent_provider, cwd, pinned, content, created_at, updated_at, meta, organization_id, content_hash, previous_revision_id)
    VALUES ('legacy-work', 'Legacy', '', 'doc', NULL, 'claude-code', '~', NULL, 'current', 1000, 2000, '{}', 'local', ${documentContentHash('current')}, 2)
  `)
  for (const [index, body] of ['older', 'newest'].entries()) {
    await db.run(sql`INSERT INTO work_revisions (work_id, rev, content, updated_at, organization_id, content_hash) VALUES ('legacy-work', ${index + 1}, ${body}, ${1500 + index}, 'local', ${documentContentHash(body)})`)
  }
  await db.run(sql`INSERT INTO work_revisions (work_id, rev, content, updated_at, organization_id, source_content_version, reason, content_hash) VALUES ('legacy-work', 3, 'current', 2000, 'local', 1, 'baseline', ${documentContentHash('current')})`)
  const transfer = await exportWorkForCloud('local', 'legacy-work')
  expect(transfer.revisions.map(({ revisionId, reason, sourceContentVersion, author, content, contentHash }) => ({ revisionId, reason, sourceContentVersion, author, content, contentHash }))).toEqual([
    { revisionId: 1, reason: 'checkpoint', sourceContentVersion: null, author: null, content: 'older', contentHash: documentContentHash('older') },
    { revisionId: 2, reason: 'checkpoint', sourceContentVersion: null, author: null, content: 'newest', contentHash: documentContentHash('newest') },
    { revisionId: 3, reason: 'baseline', sourceContentVersion: 1, author: null, content: 'current', contentHash: documentContentHash('current') },
  ])
  expect(transfer.previousRevisionId).toBe(2)
  await atDestination(async () => {
    await importWorkFromHost('org1', transfer)
    const imported = await Work.byId('org1', 'legacy-work')
    expect(imported.contentAuthor).toBeNull()
    expect((await imported.previous())?.content).toBe('newest')
    expect((await imported.revisions()).map(({ revisionId, sourceContentVersion }) => ({ revisionId, sourceContentVersion })))
      .toEqual([{ revisionId: 1, sourceContentVersion: null }, { revisionId: 2, sourceContentVersion: null }, { revisionId: 3, sourceContentVersion: 1 }])
  })
})

test('an authenticated link visitor uses the verified account identity, never a typed name as a seat id', async () => {
  const { shares, link } = await fixture()
  const now = Math.floor(Date.now() / 1000)
  const outcome = await ticketForGrant({ iss: 'https://cloud.test', aud: 'urn:solus:api', sub: 'bob', deviceId: 'account-session', access: 'guest', hostKind: 'cloud', displayName: 'Bob', jti: 'j', iat: now, exp: now + 60 }, { shareSecret: link.secret }, (secret) => shares.resolveLinkSecret(secret), { workspace: true })
  if (!outcome.ok) throw new Error('Expected a resource ticket')
  const { consumeWsTicket } = await import('@solus/server/admission/auth')
  const { principalFor } = await import('@solus/server/admission/principal')
  const ticket = consumeWsTicket(outcome.ticket)!
  const principal = principalFor({ kind: 'ticket', ticket })
  expect(principal.kind === 'guest' && principal.accountUserId).toBe('bob')
  expect(principal.deviceId).toBe('account-session')
  const relay = new SharedPromptRelay(shares)
  await relay.poll(runner)
  const pending = relay.prompt(principal, { sessionId: resource.id, text: 'my seat' })
  let commands = (await relay.poll(runner)).commands
  for (const deadline = Date.now() + 5_000; !commands.length && Date.now() < deadline;) { await new Promise<void>((resolve) => setImmediate(resolve)); commands = (await relay.poll(runner)).commands }
  expect(commands[0]?.actor).toEqual({ userId: 'bob', seatUserId: 'bob', displayName: 'Bob' })
  relay.result(runner, { hostId: runner.hostId, requestId: commands[0]!.requestId, error: null })
  await pending
})

test.skipIf(process.env.SOLUS_DB === 'postgres')('a Local task uploads with its comments, works, and sessions, and its host keeps a row that points to the organization', async () => {
  // WHY: a task's linked Local works go with it, and its sessions stay on the host
  // (docs/plans/cloud-sharing.md §3a, §8). The cloud task must link to the uploaded
  // works and list the sessions on the host that runs them, a repeat must change
  // nothing, and the host must keep a task that changed after it was read. After the
  // upload the host keeps the task's row and its session links, so a session that
  // names the task is told where it went instead of "not found".
  const { loadWork } = await import('@solus/server/data/works/works')
  const { createTask } = await import('@solus/server/data/tasks/task-store')
  const { Task } = await import('@solus/server/data/tasks/task')
  const { exportTaskForCloud, markTaskMoved } = await import('@solus/server/data/tasks/task-transfer')
  const { taskSessions } = await import('@solus/server/data/tasks/task-sessions')
  const { listTasks, TaskMovedError } = await import('@solus/server/data/tasks/task-store')
  const { persistIndexedSessionStart } = await import('@solus/server/db/session-indexer')
  const { SolusServer } = await import('@solus/server/transport/server')
  const { registerCloudUploadHandlers } = await import('@solus/server/transport/solus-api/cloud-uploads')
  const { resetApiModeForTests } = await import('@solus/server/host/api-mode')
  await workWithHistory('task-work')
  await createTask('local', { title: 'Ship it', body: 'The plan', status: 'todo' }, { id: 'task-1', now: 1 }, ALICE)
  const local = await Task.byId('local', 'task-1')
  await local.comment('Looks good', { by: BOB })
  await local.link({ kind: 'work', targetKey: 'task-work' }, ALICE)
  persistIndexedSessionStart('session-lead', 'claude-code', '/repo', '-repo', 'opus', 'high', 'Lead the fix')
  await local.linkSession('session-lead', 'lead', { startedBy: ALICE })
  await local.linkSession('session-worker', 'working')

  const exported = await exportTaskForCloud('local', 'task-1', 'host-a')
  expect(exported.task.task).toMatchObject({ id: 'task-1', title: 'Ship it', body: 'The plan', status: 'todo' })
  expect(exported.task.comments.map((comment) => comment.body)).toEqual(['Looks good'])
  expect(exported.task.workIds).toEqual(['task-work'])
  expect(exported.works.map((work) => work.work.id)).toEqual(['task-work'])
  expect(exported.task.sessions).toEqual([
    { sessionId: 'session-lead', role: 'lead', linkedAt: expect.any(Number), title: 'Lead the fix', provider: 'claude-code', startedBy: ALICE, hostInstallationId: 'host-a' },
    { sessionId: 'session-worker', role: 'working', linkedAt: expect.any(Number), title: null, provider: null, startedBy: null, hostInstallationId: 'host-a' },
  ])
  const works = [{ workId: 'task-work', fingerprint: exported.works[0]!.fingerprint }]

  // A comment after the read: the task stays, and so does its work.
  await local.comment('One more thing', { by: ALICE })
  await expect(markTaskMoved('local', 'task-1', exported.task.fingerprint, works, 'org-1', 'host-a')).rejects.toThrow(/changed/)
  expect(await loadWork('local', 'task-work')).not.toBeNull()
  const current = await exportTaskForCloud('local', 'task-1', 'host-a')
  const bob: Extract<Principal, { kind: 'org-member' }> = { ...alice, organizationId: 'org2', userId: 'bob', displayName: 'Bob', deviceId: 'bob' }

  const previous = process.env.SOLUS_API
  process.env.SOLUS_API = '1'
  resetApiModeForTests()
  try {
    await atDestination(async () => {
      const shares = new ShareManager({ db: getDatabase() })
      const service = new SolusServer()
      registerCloudUploadHandlers(service, { shares })
      const as = (principal: Principal) => ({ clientId: principal.deviceId ?? 'c', principal })
      for (const work of current.works) await service.handle('workUpload', [work], as(alice))
      expect(await service.handle('taskUpload', [current.task], as(alice))).toEqual({ taskId: 'task-1', organizationId: 'org1' })
      const cloud = await (await Task.byId('org1', 'task-1')).details()
      expect(cloud.task.title).toBe('Ship it')
      expect(cloud.comments.map((comment) => comment.body)).toEqual(['Looks good', 'One more thing'])
      expect(cloud.links.filter((link) => link.kind === 'work').map((link) => link.targetKey)).toEqual(['task-work'])
      expect(await shares.ownerOf({ kind: 'task', id: 'task-1' })).toBe('alice')
      expect(((await taskSessions('org1', 'task-1'))['task-1'] ?? []).map((link) => [link.sessionId, link.role, link.sessionTitle, link.executionServerId, link.startedBy ?? null])).toEqual([
        ['session-lead', 'lead', 'Lead the fix', 'host-a', ALICE],
        ['session-worker', 'working', null, 'host-a', null],
      ])

      expect(await service.handle('taskUpload', [current.task], as(alice))).toEqual({ taskId: 'task-1', organizationId: 'org1' })
      expect((await (await Task.byId('org1', 'task-1')).details()).comments).toHaveLength(2)
      await expect(service.handle('taskUpload', [current.task], as(bob))).rejects.toThrow(/another organization/)
      await expect(service.handle('taskUpload', [{ ...current.task, fingerprint: 'forged' }], as(alice))).rejects.toThrow(/incomplete/)
    })
  } finally {
    if (previous === undefined) delete process.env.SOLUS_API
    else process.env.SOLUS_API = previous
    resetApiModeForTests()
  }

  await markTaskMoved('local', 'task-1', current.task.fingerprint, current.works.map((work) => ({ workId: work.work.id, fingerprint: work.fingerprint })), 'org-1', 'host-a')
  const moved = await Task.byId('local', 'task-1').catch((error: unknown) => error)
  expect(moved).toBeInstanceOf(TaskMovedError)
  expect(moved).toMatchObject({ code: 'MOVED', location: { organizationId: 'org-1' } })
  expect(await loadWork('local', 'task-work')).toBeNull()
  // The host lists only its own tasks, and the sessions still name the moved one.
  expect((await listTasks('local')).tasks).toEqual([])
  expect(await taskSessions('local', 'task-1')).toEqual({})
  expect(await Task.forSession('local', 'session-lead').catch((error: unknown) => error)).toBeInstanceOf(TaskMovedError)
})

test('a share call counts the queries it sends, inside its transaction too, and no one else\'s', async () => {
  // WHY: `share_call_timed` tells whether a slow Share waits on the database.
  // A count that missed transaction queries, or took in a concurrent call's
  // queries, would point the investigation at the wrong place.
  const { tallyQueries } = await import('@solus/server/db/database')
  const { sql } = await import('drizzle-orm')
  const { shares } = await fixture()
  const tally = { queries: 0, queryMs: 0 }
  const outside = { queries: 0, queryMs: 0 }
  await Promise.all([
    tallyQueries(tally, () => shares.setLink({ resource, role: 'viewer' }, alice)),
    tallyQueries(outside, () => getDatabase().get(sql`SELECT 1`)),
  ])
  expect(outside.queries).toBe(1)
  // One joined read of the owner and the rows, then the one write: the role is computed once.
  expect(tally.queries).toBe(2)
  await getDatabase().get(sql`SELECT 1`)
  expect(outside.queries).toBe(1)
})
