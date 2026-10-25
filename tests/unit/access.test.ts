import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { sql } from 'drizzle-orm'
import type { ResourceRole } from '@solus/contracts/sharing'
import type { Principal } from '@solus/server/admission/principal'
import type { AclEntry, ResourceRow } from '@solus/server/admission/access'
import type { ResourceKind } from '@solus/contracts/permissions'
import { resetTestDatabase } from './helpers/test-db'
import { seedResource } from './helpers/resource-rows'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/access-model.md §2.3: one function decides a resource role. Outside
// the person's organization scope: none. The owner: owner. A personal resource
// (integration, notification, browserProfile): nobody else. Otherwise the best ACL entry that
// names the person, their team, their organization, or their link, and an
// administrator gets at least editor. `visibleTo` is the same rule in SQL, so a
// list and a get cannot disagree.

type AccessModule = typeof import('@solus/server/admission/access')
type ActorModule = typeof import('@solus/server/admission/actor')
type DatabaseModule = typeof import('@solus/server/db/database')

let dataDir: string
let access: AccessModule
let actors: ActorModule
let database: DatabaseModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-access-'))
  process.env.SOLUS_DATA_DIR = dataDir
  access = await import('@solus/server/admission/access')
  actors = await import('@solus/server/admission/actor')
  database = await import('@solus/server/db/database')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(async () => {
  ;(await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const LINK_HASH = 'link-hash'
const member = (userId: string, options: { organizationId?: string; teamIds?: string[]; role?: 'owner' | 'member'; hostKind?: 'personal' | 'managed' | 'cloud' } = {}): Principal => ({
  kind: 'org-member', userId, organizationId: options.organizationId ?? 'org1', organizationRole: options.role ?? 'member', teamIds: options.teamIds ?? [],
  hostKind: options.hostKind ?? 'managed', displayName: userId, deviceId: `d-${userId}`, expiresAt: 0, deviceLabel: 'Solus cloud',
})
const guestFor = (kind: 'session' | 'work', id: string): Principal => ({
  kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', organizationId: 'org1',
  share: { resource: { kind, id }, role: 'viewer', sharedByUserId: 'alice', linkSecretHash: LINK_HASH }, expiresAt: 0, deviceLabel: 'Guest link',
})

/** The host roles of §1, and the people around them. */
const PEOPLE = {
  hostOwner: { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' } as Principal,
  admin: member('adam', { role: 'owner' }),
  owner: member('alice'),
  member: member('bob'),
  teamMember: member('cara', { teamIds: ['team-a'] }),
  guest: guestFor('work', 'r1'),
  otherOrganization: member('eve', { organizationId: 'org2', role: 'owner' }),
  runner: { kind: 'runner', hostId: 'h1', organizationId: 'org1', ownerUserId: 'alice', deviceId: 'h1', expiresAt: 0, deviceLabel: 'Runner' } as Principal,
}
type Person = keyof typeof PEOPLE

/** Alice's resource in org1, shared with team A as editors and by a viewer link. */
const ENTRIES: AclEntry[] = [
  { subjectKind: 'team', subjectId: 'team-a', role: 'editor', organizationId: 'org1', linkSecretHash: null },
  { subjectKind: 'everyone', subjectId: '', role: 'viewer', organizationId: 'org1', linkSecretHash: LINK_HASH },
]

const SHAREABLE: Record<Person, ResourceRole> = {
  hostOwner: 'editor', admin: 'editor', owner: 'owner', member: 'none', teamMember: 'editor', guest: 'viewer', otherOrganization: 'none', runner: 'none',
}
const PERSONAL: Record<Person, ResourceRole> = {
  hostOwner: 'none', admin: 'none', owner: 'owner', member: 'none', teamMember: 'none', guest: 'none', otherOrganization: 'none', runner: 'none',
}

/** A resource with an owner and no ACL entries: an automation, a project, an insight (§2.3, D2, D4). */
const OWNED: Record<Person, ResourceRole> = {
  hostOwner: 'editor', admin: 'editor', owner: 'owner', member: 'none', teamMember: 'none', guest: 'none', otherOrganization: 'none', runner: 'none',
}

describe('the role table', () => {
  for (const kind of ['automation', 'project', 'insight'] as const) {
    test(`${kind}: its owner owns it, an administrator edits it, no other member reaches it`, () => {
      // WHY (D2, D4): a member sees and changes their own; a host administrator sees and changes all.
      const resource: ResourceRow = { kind, id: 'r1', organizationId: 'org1', ownerKey: 'alice', acl: [] }
      const roles = Object.fromEntries(Object.entries(PEOPLE).map(([name, principal]) => [name, access.roleOf(actors.actorFor(principal), resource)]))
      expect(roles).toEqual(OWNED)
    })
  }

  const kinds: Array<[ResourceKind, Record<Person, ResourceRole>]> = [
    ['session', SHAREABLE], ['work', SHAREABLE], ['task', SHAREABLE], ['integration', PERSONAL], ['notification', PERSONAL], ['browserProfile', PERSONAL],
  ]
  for (const [kind, expected] of kinds) {
    test(`${kind}: every host role gets the role §2.3 gives it`, () => {
      // WHY: one function decides for every kind. A personal kind gives nothing to
      // anyone but its owner, even with entries; a link reaches only its own resource
      // kind and id (the guest's link is for a work, so it names no session).
      const resource: ResourceRow = { kind, id: 'r1', organizationId: 'org1', ownerKey: 'alice', acl: ENTRIES }
      const roles = Object.fromEntries(Object.entries(PEOPLE).map(([name, principal]) => [name, access.roleOf(actors.actorFor(principal), resource)]))
      const want = kind === 'session' || kind === 'task' ? { ...expected, guest: 'none' } : expected
      expect(roles).toEqual(want)
    })
  }

  test('the host itself holds every role; the host owner owns what is the host user\'s', () => {
    const resource: ResourceRow = { kind: 'work', id: 'r1', organizationId: 'local', ownerKey: actors.ownerKeyOf(actors.actorFor(PEOPLE.hostOwner))!, acl: [] }
    expect(access.roleOf(actors.HOST_ACTOR, resource)).toBe('owner')
    expect(access.roleOf(actors.actorFor(PEOPLE.hostOwner), resource)).toBe('owner')
    expect(access.roleOf(actors.actorFor(PEOPLE.member), resource)).toBe('none')
  })

  test('an entry of another organization grants nothing, and a changed link admits no guest', () => {
    const resource: ResourceRow = { kind: 'work', id: 'r1', organizationId: 'org1', ownerKey: 'alice', acl: [
      { subjectKind: 'organization', subjectId: 'org1', role: 'editor', organizationId: 'org2', linkSecretHash: null },
      { subjectKind: 'everyone', subjectId: '', role: 'editor', organizationId: 'org1', linkSecretHash: 'rotated' },
    ] }
    expect(access.roleOf(actors.actorFor(PEOPLE.member), resource)).toBe('none')
    expect(access.roleOf(actors.actorFor(PEOPLE.guest), resource)).toBe('none')
  })
})

describe('visibleTo agrees with roleOf', () => {
  const ROWS: Array<{ kind: 'session' | 'work' | 'task'; id: string; owner: string; organizationId: string }> = [
    { kind: 'work', id: 'r1', owner: 'alice', organizationId: 'org1' },
    { kind: 'work', id: 'w-bob', owner: 'bob', organizationId: 'org1' },
    { kind: 'work', id: 'w-org', owner: 'alice', organizationId: 'org1' },
    { kind: 'work', id: 'w-host', owner: 'host-owner', organizationId: 'local' },
    { kind: 'work', id: 'w-org2', owner: 'eve', organizationId: 'org2' },
    { kind: 'session', id: 'r1', owner: 'alice', organizationId: 'org1' },
    { kind: 'session', id: 's-user', owner: 'alice', organizationId: 'org1' },
    { kind: 'task', id: 't-org', owner: 'adam', organizationId: 'org1' },
    { kind: 'task', id: 't-private', owner: 'adam', organizationId: 'org1' },
  ]
  const ENTRY_ROWS: Array<{ kind: 'session' | 'work' | 'task'; id: string; subjectKind: string; subjectId: string; role: string; hash: string | null; organizationId: string }> = [
    { kind: 'work', id: 'r1', subjectKind: 'team', subjectId: 'team-a', role: 'editor', hash: null, organizationId: 'org1' },
    { kind: 'work', id: 'r1', subjectKind: 'everyone', subjectId: '', role: 'viewer', hash: LINK_HASH, organizationId: 'org1' },
    { kind: 'work', id: 'w-org', subjectKind: 'organization', subjectId: 'org1', role: 'viewer', hash: null, organizationId: 'org1' },
    { kind: 'session', id: 's-user', subjectKind: 'user', subjectId: 'bob', role: 'viewer', hash: null, organizationId: 'org1' },
    { kind: 'task', id: 't-org', subjectKind: 'organization', subjectId: 'org1', role: 'editor', hash: null, organizationId: 'org1' },
  ]

  test('on every fixture row, for every host role, a list holds exactly what a get opens', async () => {
    // WHY: a list filters in SQL and a get asks `roleOf`. If they disagreed, a
    // sidebar would show a row that does not open, or hide one that does.
    const db = database.getDatabase()
    for (const row of ROWS) await seedResource(db, row.kind, row.id, row.owner, row.organizationId)
    for (const [index, entry] of ENTRY_ROWS.entries()) {
      await db.run(sql`
        INSERT INTO acl_entry (id, resource_kind, resource_id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id, created_at, organization_id)
        VALUES (${`e${index}`}, ${entry.kind}, ${entry.id}, ${entry.subjectKind}, ${entry.subjectId}, ${entry.role}, ${entry.hash}, 'alice', 1, ${entry.organizationId})
      `)
    }
    const { ShareManager } = await import('@solus/server/sharing/share-manager')
    const shares = new ShareManager({ db })
    const principals = { ...PEOPLE, sessionGuest: guestFor('session', 's-user'), workGuest: guestFor('work', 'r1') }
    let checked = 0
    for (const [name, principal] of Object.entries(principals)) {
      for (const kind of ['session', 'work', 'task'] as const) {
        const ids = ROWS.filter((row) => row.kind === kind).map((row) => ({ id: row.id }))
        const listed = new Set((await shares.filterVisible(principal, kind, ids, (row) => row.id)).map((row) => row.id))
        for (const { id } of ids) {
          const opens = await shares.roleFor(principal, { kind, id }) !== 'none'
          expect({ name, kind, id, listed: listed.has(id) }).toEqual({ name, kind, id, listed: opens })
          checked++
        }
      }
    }
    expect(checked).toBe(ROWS.length * Object.keys(principals).length)
  })

  test('on integration rows, only the owner lists and opens one', async () => {
    const db = database.getDatabase()
    const { getDb } = await import('@solus/server/db')
    getDb()
    for (const [id, owner, organizationId] of [['i-alice', 'alice', 'org1'], ['i-bob', 'bob', 'org1'], ['i-eve', 'alice', 'org2']] as const) {
      await db.run(sql`
        INSERT INTO integration (id, organization_id, owner_key, kind, slug, name, url, auth, created_by, created_at, updated_at)
        VALUES (${id}, ${organizationId}, ${owner}, 'mcp', ${id}, ${id}, 'https://example.com/mcp', '{"kind":"none"}', ${owner}, '', '')
      `)
    }
    const rows = await db.all<{ id: string; organization_id: string; owner_key: string }>(sql`SELECT id, organization_id, owner_key FROM integration`)
    for (const principal of Object.values(PEOPLE)) {
      const actor = actors.actorFor(principal)
      const predicate = access.visibleTo(actor, 'integration', { id: sql`id`, organization: sql`organization_id`, owner: sql`owner_key` })
      const listed = (await db.all<{ id: string }>(sql`SELECT id FROM integration WHERE ${predicate}`)).map((row) => row.id).sort()
      const opened = rows.filter((row) => access.roleOf(actor, { kind: 'integration', id: row.id, organizationId: row.organization_id, ownerKey: row.owner_key, acl: [] }) !== 'none').map((row) => row.id).sort()
      expect(listed).toEqual(opened)
    }
    // Alice reaches her own in her organization, and an administrator reaches none of hers.
    expect(rows.filter((row) => access.roleOf(actors.actorFor(PEOPLE.owner), { kind: 'integration', id: row.id, organizationId: row.organization_id, ownerKey: row.owner_key, acl: [] }) === 'owner').map((row) => row.id)).toEqual(['i-alice'])
  })

  test('on automation, project, and notification rows, a list holds exactly what the gate opens', async () => {
    // WHY: these kinds have no ACL entries; their list reads `visibleTo` on their own
    // row and the gate asks `ShareManager.roleFor`. If they disagreed, a member would
    // list an automation the gate refuses, or reach one the list hides.
    const db = database.getDatabase()
    const { getDb } = await import('@solus/server/db')
    const store = await import('@solus/server/data/automations/automations-store')
    for (const [id, owner, organizationId] of [['a-alice', 'alice', 'org1'], ['a-bob', 'bob', 'org1'], ['a-eve', 'eve', 'org2'], ['a-old', '', 'org1']] as const) {
      getDb().prepare(`INSERT INTO automations (id, organization_id, owner_key, name, enabled, action, trigger_config, last_run, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, '{"type":"manual"}', '{}', 1, 1)`).run(id, organizationId, owner, id, JSON.stringify({ prompt: 'p', agentProvider: 'claude-code', modelId: null, reasoningEffort: 'medium', cwd: '/tmp' }))
      await db.run(sql`
        INSERT INTO workspace_projects (id, organization_id, repository_key, display_name, owner_key, created_by, created_at)
        VALUES (${`p-${id}`}, ${organizationId}, ${`github.com/acme/${id}`}, ${id}, ${owner}, ${owner}, 1)
      `)
      await db.run(sql`
        INSERT INTO notifications (id, organization_id, recipient_key, event_id, kind, resource_key, facts, resource, by, summary, created_at)
        VALUES (${`n-${id}`}, ${organizationId}, ${owner}, ${id}, 'automation.finished', ${`automation:${id}`}, '{}', '{}', '{}', '{}', 1)
      `)
    }
    const { ShareManager } = await import('@solus/server/sharing/share-manager')
    const shares = new ShareManager({ db })
    const ids = ['a-alice', 'a-bob', 'a-eve', 'a-old']
    for (const [name, principal] of Object.entries(PEOPLE)) {
      const actor = actors.actorFor(principal)
      const listed = {
        automation: (await store.listAutomations(actor)).map((automation) => automation.id).sort(),
        project: (await db.all<{ id: string }>(sql`SELECT id FROM workspace_projects WHERE ${access.visibleTo(actor, 'project', { id: sql`id`, organization: sql`organization_id`, owner: sql`owner_key` })}`)).map((row) => row.id).sort(),
        notification: (await db.all<{ id: string }>(sql`SELECT id FROM notifications WHERE ${access.visibleTo(actor, 'notification', { id: sql`id`, organization: sql`organization_id`, owner: sql`recipient_key` })}`)).map((row) => row.id).sort(),
      }
      const opened = { automation: [] as string[], project: [] as string[], notification: [] as string[] }
      for (const id of ids) {
        if (await shares.roleFor(principal, { kind: 'automation', id }) !== 'none') opened.automation.push(id)
        if (await shares.roleFor(principal, { kind: 'project', id: `p-${id}` }) !== 'none') opened.project.push(`p-${id}`)
        if (await shares.roleFor(principal, { kind: 'notification', id: `n-${id}` }) !== 'none') opened.notification.push(`n-${id}`)
      }
      expect({ name, ...listed }).toEqual({ name, ...opened })
    }
    // A member reaches only their own automation; an administrator every one in their organization, but never another person's notification.
    expect((await store.listAutomations(actors.actorFor(PEOPLE.member))).map((automation) => automation.id)).toEqual(['a-bob'])
    expect((await store.listAutomations(actors.actorFor(PEOPLE.admin))).map((automation) => automation.id).sort()).toEqual(['a-alice', 'a-bob', 'a-old'])
    expect(await shares.roleFor(PEOPLE.admin, { kind: 'notification', id: 'n-a-bob' })).toBe('none')
    expect(await shares.roleFor(PEOPLE.member, { kind: 'automation', id: 'missing' })).toBe('none')
  })
})
