import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { parseUserKey, sameUser, userKey, type UserId } from '@solus/contracts/user'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/012-user-actor-and-activity.md §1: one user id per person. The host's owner
// is a `local` user minted once; the rows that named them by the `host-owner`
// sentinel, and the comments that said `'you'`, move to that user at boot; linking
// moves them to the owner's account, and unlinking moves the Local ones back.

describe('user ids', () => {
  const ids: UserId[] = [
    { kind: 'account', accountId: 'user_01H' },
    { kind: 'local', localId: '6f1c2d' },
    { kind: 'guest', guestId: 'g-42' },
  ]

  test('a user key parses back to the same user, and members and guests keep the strings their rows hold', () => {
    for (const id of ids) {
      expect(sameUser(parseUserKey(userKey(id)), id)).toBe(true)
    }
    expect(ids.map(userKey)).toEqual(['user_01H', 'local:6f1c2d', 'guest:g-42'])
  })

  test('two kinds with the same id are two people', () => {
    expect(sameUser({ kind: 'account', accountId: 'x' }, { kind: 'guest', guestId: 'x' })).toBe(false)
  })
})

describe('the host user rows', () => {
  let dataDir: string
  const previousDataDir = process.env.SOLUS_DATA_DIR
  let database: typeof import('@solus/server/db/database')
  let rows: typeof import('@solus/server/host/host-user-rows')
  let hostUserModule: typeof import('@solus/server/host/host-user')
  let actors: typeof import('@solus/server/admission/actor')
  let workAnnotations: typeof import('@solus/server/data/works/work-annotations')
  let planAnnotations: typeof import('@solus/server/plans/annotations')
  let settings: typeof import('@solus/server/host/settings')
  let closeDb: () => void

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-host-user-'))
    process.env.SOLUS_DATA_DIR = dataDir
    database = await import('@solus/server/db/database')
    rows = await import('@solus/server/host/host-user-rows')
    hostUserModule = await import('@solus/server/host/host-user')
    actors = await import('@solus/server/admission/actor')
    workAnnotations = await import('@solus/server/data/works/work-annotations')
    planAnnotations = await import('@solus/server/plans/annotations')
    settings = await import('@solus/server/host/settings')
    ;({ closeDb } = await import('@solus/server/db'))
  })

  afterAll(async () => {
    // Other suites in this process expect no host user.
    hostUserModule.useHostUser(null)
    await database.closeDatabase()
    closeDb()
    rmSync(dataDir, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = previousDataDir
  })

  const MEMBER_PERSON = { userId: 'bob', displayName: 'Bob', colorIndex: 3 }
  const OLD_OWNER_PERSON = { userId: 'host-owner', displayName: 'Host owner', colorIndex: 1 }

  async function notificationRows(): Promise<[string, string, number | null][]> {
    const found = await database.getDatabase().all<{ id: string; recipient_key: string; read_at: number | null }>(sql`SELECT id, recipient_key, read_at FROM notifications ORDER BY id`)
    return found.map((row) => [row.id, row.recipient_key, row.read_at === null ? null : Number(row.read_at)])
  }

  async function seed(): Promise<void> {
    const db = database.getDatabase()
    await db.run(sql`INSERT INTO resource_owner (resource_kind, resource_id, owner_user_id, created_at, organization_id) VALUES
      ('work', 'w-local', 'host-owner', 1, 'local'),
      ('session', 's-org', 'host-owner', 1, 'org1'),
      ('work', 'w-bob', 'bob', 1, 'local')`)
    await db.run(sql`INSERT INTO share_grant (id, resource_kind, resource_id, subject_kind, subject_id, role, granted_by_user_id, created_at, organization_id) VALUES
      ('g1', 'work', 'w-local', 'user', 'bob', 'viewer', 'host-owner', 1, 'local')`)
    await db.run(sql`INSERT INTO session_records (session_id, organization_id, owner_user_id, provider, project_path, created_at, last_activity_at) VALUES
      ('s-local', 'local', 'host-owner', 'codex', '/p', 1, 1)`)
    await db.run(sql`INSERT INTO session_admissions (organization_id, admission_id, host_id, owner_user_id, created_at) VALUES
      ('org1', 'a1', 'h1', 'host-owner', 1)`)
    // The owner's notifications (plans/015): one Local, one of an organization, one read.
    await db.run(sql`INSERT INTO notifications (id, organization_id, recipient_key, event_id, kind, resource_key, facts, resource, by, summary, created_at, read_at) VALUES
      ('n-local', 'local', 'host-owner', 'e1', 'task.assigned', 'task:t1', '{"kind":"task.assigned"}', '{"kind":"task","taskId":"t1"}', '{"kind":"system"}', '{"title":"t"}', 1, 7),
      ('n-org', 'org1', 'host-owner', 'e2', 'task.assigned', 'task:t2', '{"kind":"task.assigned"}', '{"kind":"task","taskId":"t2"}', '{"kind":"system"}', '{"title":"t"}', 1, NULL)`)
    // Stored the way hosts wrote them before users had ids.
    const workThreads = [
      { id: 'c-owner', selectedText: 'a', comment: 'mine', author: 'you', person: OLD_OWNER_PERSON, readBy: [{ userId: 'host-owner', readAt: 5 }] },
      { id: 'c-bob', selectedText: 'b', comment: 'his', author: 'you', person: MEMBER_PERSON, replies: [
        { id: 'r-agent', author: 'solus', authorAgent: { sessionId: 's-1', provider: 'codex', title: 'Reviewer' }, text: 'noted', createdAt: 2 },
      ] },
      { id: 'c-anon', selectedText: 'c', comment: 'before people', resolvedAt: 9, resolvedBy: 'you' },
    ]
    await db.run(sql`INSERT INTO work_annotations (work_id, data, updated_at, organization_id) VALUES
      ('w-local', ${JSON.stringify({ version: 1, workId: 'w-local', comments: workThreads, updatedAt: 1 })}, 1, 'local')`)
    const planThreads = [
      { id: 'p-you', selectedText: 'x', comment: 'plan note', author: 'you' },
      { id: 'p-solus', selectedText: 'y', comment: 'decided', author: 'solus' },
    ]
    await db.run(sql`INSERT INTO plan_annotations (session_id, plan_tool_use_id, status, title, bookmarked, project_path, cwd, comments, updated_at, organization_id) VALUES
      ('s-local', 'tool-1', 'pending', 'Plan', 0, '/p', '/p', ${JSON.stringify(planThreads)}, 1, 'local')`)
  }

  /** The key a record the local owner makes is owned under. */
  function localOwnerKey(): string | null {
    return actors.ownerKeyOf(actors.actorFor({ kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }))
  }

  async function ownerOf(resourceId: string): Promise<string | undefined> {
    const row = await database.getDatabase().get<{ owner_user_id: string }>(sql`SELECT owner_user_id FROM resource_owner WHERE resource_id = ${resourceId}`)
    return row?.owner_user_id
  }

  async function storedWorkThreads(): Promise<Array<{ id: string; author: unknown; person?: unknown; readBy?: Array<{ userId: string }> }>> {
    const row = await database.getDatabase().get<{ data: string }>(sql`SELECT data FROM work_annotations WHERE work_id = 'w-local'`)
    return JSON.parse(row!.data).comments
  }

  test('boot moves the sentinel rows and the old comment authors to the local user, once', async () => {
    await seed()
    await rows.adoptHostUser(database.getDatabase(), { localId: 'L1' })

    expect(await ownerOf('w-local')).toBe('local:L1')
    expect(await ownerOf('s-org')).toBe('local:L1')
    expect(await ownerOf('w-bob')).toBe('bob')
    const grant = await database.getDatabase().get<{ subject_id: string; granted_by_user_id: string }>(sql`SELECT subject_id, granted_by_user_id FROM share_grant WHERE id = 'g1'`)
    expect(grant).toEqual({ subject_id: 'bob', granted_by_user_id: 'local:L1' })
    expect((await database.getDatabase().get<{ owner_user_id: string }>(sql`SELECT owner_user_id FROM session_records WHERE session_id = 's-local'`))?.owner_user_id).toBe('local:L1')
    expect((await database.getDatabase().get<{ owner_user_id: string }>(sql`SELECT owner_user_id FROM session_admissions WHERE admission_id = 'a1'`))?.owner_user_id).toBe('local:L1')

    // No `'you'` label and no separate person is stored any more.
    const stored = await storedWorkThreads()
    expect(stored.map((thread) => thread.author)).toEqual([
      { kind: 'user', user: expect.objectContaining({ id: { kind: 'local', localId: 'L1' } }) },
      { kind: 'user', user: { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' } },
      { kind: 'user', user: expect.objectContaining({ id: { kind: 'local', localId: 'L1' } }) },
    ])
    expect(stored.every((thread) => thread.person === undefined)).toBe(true)
    expect(stored[0]!.readBy).toEqual([{ userId: 'local:L1', readAt: 5 }])

    // The wire carries the same attributions: the member keeps their name, the agent its signature (plans/012 stage 4).
    const wire = (await workAnnotations.loadWorkAnnotations('local', 'w-local'))!.comments
    expect(wire[1]!.author).toEqual({ kind: 'user', user: { id: parseUserKey('bob'), displayName: 'Bob' } })
    expect(wire[1]!.replies![0]!.author).toEqual({ kind: 'agent', sessionId: 's-1', provider: 'codex', title: 'Reviewer' })
    expect(wire[0]!.author).toMatchObject({ kind: 'user', user: { id: { kind: 'local', localId: 'L1' } } })
    expect(wire[2]!.resolvedBy).toMatchObject({ kind: 'user', user: { id: { kind: 'local', localId: 'L1' } } })
    // A plan's `'you'` was the host's user, and its unsigned `'solus'` was Solus itself.
    const plan = (await planAnnotations.loadAnnotations('local', 's-local', 'tool-1'))!
    expect(plan.comments.map((comment) => comment.author)).toEqual([
      { kind: 'user', user: expect.objectContaining({ id: { kind: 'local', localId: 'L1' } }) },
      { kind: 'system' },
    ])

    // New rows for the owner are written under the same key.
    expect(localOwnerKey()).toBe('local:L1')
    expect(settings.getServerSettings().hostUser).toMatchObject({ localId: 'L1', adoptedAt: expect.any(Number) })

    // A second boot finds the mark and leaves a row written since alone.
    await database.getDatabase().run(sql`INSERT INTO resource_owner (resource_kind, resource_id, owner_user_id, created_at, organization_id) VALUES ('task', 't-late', 'host-owner', 1, 'local')`)
    await rows.adoptHostUser(database.getDatabase(), settings.getServerSettings().hostUser!)
    expect(await ownerOf('t-late')).toBe('host-owner')
    await database.getDatabase().run(sql`DELETE FROM resource_owner WHERE resource_id = 't-late'`)
  })

  test('linking moves every row of the local user to the owner account', async () => {
    await rows.followHostAccount(database.getDatabase(), { userId: 'acc-1', name: 'Ashton', email: 'a@example.com' })

    expect(await ownerOf('w-local')).toBe('acc-1')
    expect(await ownerOf('s-org')).toBe('acc-1')
    expect(await ownerOf('w-bob')).toBe('bob')
    expect(localOwnerKey()).toBe('acc-1')
    const stored = await storedWorkThreads()
    expect(stored[0]!.author).toEqual({ kind: 'user', user: { id: { kind: 'account', accountId: 'acc-1' }, displayName: 'Ashton', email: 'a@example.com' } })
    expect(stored[0]!.readBy).toEqual([{ userId: 'acc-1', readAt: 5 }])
    expect(settings.getServerSettings().hostUser?.account).toEqual({ accountId: 'acc-1', displayName: 'Ashton', email: 'a@example.com' })
    expect(await notificationRows()).toEqual([['n-local', 'acc-1', 7], ['n-org', 'acc-1', null]])
  })

  test('unlinking moves the Local rows back; an organization keeps the account', async () => {
    await rows.followHostAccount(database.getDatabase(), null)

    expect(await ownerOf('w-local')).toBe('local:L1')
    expect((await database.getDatabase().get<{ owner_user_id: string }>(sql`SELECT owner_user_id FROM session_records WHERE session_id = 's-local'`))?.owner_user_id).toBe('local:L1')
    expect(await ownerOf('s-org')).toBe('acc-1')
    expect((await database.getDatabase().get<{ owner_user_id: string }>(sql`SELECT owner_user_id FROM session_admissions WHERE admission_id = 'a1'`))?.owner_user_id).toBe('acc-1')
    expect((await storedWorkThreads())[0]!.author).toMatchObject({ kind: 'user', user: { id: { kind: 'local', localId: 'L1' } } })
    expect(localOwnerKey()).toBe('local:L1')
    expect(settings.getServerSettings().hostUser?.account).toBeUndefined()
    expect(await notificationRows()).toEqual([['n-local', 'local:L1', 7], ['n-org', 'acc-1', null]])
  })
})
