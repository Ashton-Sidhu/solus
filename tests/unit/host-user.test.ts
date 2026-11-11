import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { sql } from 'drizzle-orm'
import { parseUserKey, sameUser, userKey, type UserId } from '@solus/contracts/user'
import { seedResource } from './helpers/resource-rows'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// plans/012-user-actor-and-activity.md §1: one user id per person. The host's owner
// is a `local` user minted once, and that key never changes (plans/031 D1): a link
// to the owner's account and an unlink rewrite no row.

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

describe('a link and an unlink of the owner\'s account', () => {
  let dataDir: string
  const previousDataDir = process.env.SOLUS_DATA_DIR
  let database: typeof import('@solus/server/db/database')
  let rows: typeof import('@solus/server/host/host-user-rows')
  let hostUserModule: typeof import('@solus/server/host/host-user')
  let actors: typeof import('@solus/server/admission/actor')
  let access: typeof import('@solus/server/admission/access')
  let settings: typeof import('@solus/server/host/settings')
  let closeDb: () => void

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-host-user-'))
    process.env.SOLUS_DATA_DIR = dataDir
    database = await import('@solus/server/db/database')
    rows = await import('@solus/server/host/host-user-rows')
    hostUserModule = await import('@solus/server/host/host-user')
    actors = await import('@solus/server/admission/actor')
    access = await import('@solus/server/admission/access')
    settings = await import('@solus/server/host/settings')
    ;({ closeDb } = await import('@solus/server/db'))
    hostUserModule.useHostUser({ localId: 'L1' })
    settings.setHostUserSettings({ localId: 'L1' })
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

  const OWNER = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' } as const

  async function owners(): Promise<string[]> {
    const found = await database.getDatabase().all<{ id: string; owner: string }>(sql`
      SELECT id, created_by AS owner FROM works UNION ALL SELECT session_id, created_by FROM session_records ORDER BY id`)
    return found.map((row) => `${row.id}=${row.owner}`)
  }

  async function personalOwners(): Promise<string[]> {
    const found = await database.getDatabase().all<{ resource_id: string; created_by: string }>(sql`
      SELECT resource_id, created_by FROM personal_resource_state ORDER BY resource_id`)
    return found.map((row) => `${row.resource_id}=${row.created_by}`)
  }

  test('rewrite no row: the owner keeps their key, their organization session, and its archive', async () => {
    // WHY (plans/031 D1): a sign-out once moved only the Local rows back, so the owner's
    // organization sessions kept the account key and read as "Shared with you". With one
    // key nothing moves, so nothing can be left behind.
    const db = database.getDatabase()
    await seedResource(db, 'work', 'w-local', 'local:L1')
    await seedResource(db, 'session', 's-org', 'local:L1', 'org1')
    await seedResource(db, 'work', 'w-bob', 'bob')
    await db.run(sql`INSERT INTO personal_resource_state (organization_id, resource_kind, resource_id, created_by, archived_at) VALUES ('org1', 'session', 's-org', 'local:L1', 1)`)
    const before = { owners: await owners(), personal: await personalOwners() }
    const orgSession = { kind: 'session' as const, id: 's-org', organizationId: 'org1', ownerKey: 'local:L1', acl: [] }

    await rows.followHostAccount(db, { userId: 'acc-1', name: 'Ashton', email: 'a@example.com' })
    expect({ owners: await owners(), personal: await personalOwners() }).toEqual(before)
    expect(actors.ownerKeyOf(actors.actorFor(OWNER))).toBe('local:L1')
    expect(access.roleOf(actors.actorFor(OWNER), orgSession)).toBe('owner')
    expect(settings.getServerSettings().hostUser).toEqual({ localId: 'L1', account: { accountId: 'acc-1', displayName: 'Ashton', email: 'a@example.com' } })
    // The cloud boundary names the account (plans/031 D4).
    expect(hostUserModule.cloudAccountOf('local:L1')).toBe('acc-1')

    await rows.followHostAccount(db, null)
    expect({ owners: await owners(), personal: await personalOwners() }).toEqual(before)
    expect(actors.ownerKeyOf(actors.actorFor(OWNER))).toBe('local:L1')
    expect(access.roleOf(actors.actorFor(OWNER), orgSession)).toBe('owner')
    expect(settings.getServerSettings().hostUser).toEqual({ localId: 'L1' })
    expect(hostUserModule.cloudAccountOf('local:L1')).toBeNull()
  })

  test('an unlink leaves the host none of the owner\'s connections; another person\'s stay', async () => {
    // WHY (docs/plans/cloud-vault.md §2.5): unlinked, the host keeps nothing for the person.
    const db = database.getDatabase()
    await db.run(sql`INSERT INTO integration (id, organization_id, created_by, kind, slug, name, url, auth, created_at, updated_at) VALUES
      ('i-own', 'local', 'local:L1', 'mcp', 'planetscale', 'PlanetScale', 'https://mcp.pscale.dev/mcp/planetscale', '{"kind":"none"}', '1', '1'),
      ('i-bobs', 'local', 'bob', 'mcp', 'linear', 'Linear', 'https://mcp.linear.app/mcp', '{"kind":"none"}', '1', '1')`)
    await db.run(sql`INSERT INTO integration_connection (integration_id, user_id, status, source, label, info, error, updated_at) VALUES
      ('i-own', 'local:L1', 'connected', 'host', NULL, NULL, NULL, '1'), ('i-bobs', 'bob', 'connected', 'host', NULL, NULL, NULL, '1')`)
    const connected = async () => (await db.all<{ integration_id: string; user_id: string }>(sql`SELECT integration_id, user_id FROM integration_connection ORDER BY integration_id`)).map((row) => [row.integration_id, row.user_id])
    const servers = async () => (await db.all<{ id: string; created_by: string }>(sql`SELECT id, created_by FROM integration ORDER BY id`)).map((row) => [row.id, row.created_by])

    await rows.followHostAccount(db, { userId: 'acc-1' })
    expect(await connected()).toEqual([['i-bobs', 'bob'], ['i-own', 'local:L1']])
    await rows.followHostAccount(db, null)
    expect(await connected()).toEqual([['i-bobs', 'bob']])
    // The server definitions are records, and stay the owner's.
    expect(await servers()).toEqual([['i-bobs', 'bob'], ['i-own', 'local:L1']])
  })
})

describe('the owner named by their account (plans/031 D4, inbound)', () => {
  test('is the host user on this host while it is linked, and anyone else stays who they are', async () => {
    // WHY: a member picks the owner from the organization's directory, by account id. Stored as
    // it came, a review request, mention, or share never reached the owner here.
    const hostUser = await import('@solus/server/host/host-user')
    try {
      hostUser.useHostUser({ localId: 'L1', account: { accountId: 'acc-1' } })
      expect(hostUser.hostKeyOf('acc-1')).toBe('local:L1')
      expect(hostUser.hostKeyOf('bob')).toBe('bob')
      hostUser.useHostUser({ localId: 'L1' })
      expect(hostUser.hostKeyOf('acc-1')).toBe('acc-1')
    } finally {
      hostUser.useHostUser(null)
    }
  })
})
