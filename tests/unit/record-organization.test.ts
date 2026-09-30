import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/organization-scope.md §3, R9–R10: every root record carries one
// canonical organization. It is `local` while unassigned, is assigned to an
// organization at most once, and never changes again. A read names its scope —
// one organization, or every one on the disk — and a write names one
// organization. Where a new record starts depends on who writes it and on
// what kind of machine this is.

let records: typeof import('@solus/server/data/sessions/session-records')
let works: typeof import('@solus/server/data/works/works')
let principal: typeof import('@solus/server/admission/principal')
let hostCategory: typeof import('@solus/server/host/host-category')
let dbModule: typeof import('@solus/server/db')
type Principal = import('@solus/server/admission/principal').Principal

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-record-organization-'))
  process.env.SOLUS_DATA_DIR = dataDir
  records = await import('@solus/server/data/sessions/session-records')
  works = await import('@solus/server/data/works/works')
  principal = await import('@solus/server/admission/principal')
  hostCategory = await import('@solus/server/host/host-category')
  dbModule = await import('@solus/server/db')
  hostCategory.resetHostCategoryForTests()
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  hostCategory.resetHostCategoryForTests()
})

const LOCAL_OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const memberOf = (organizationId: string): Principal => ({
  kind: 'org-member', userId: 'bob', organizationId, organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Bob', deviceId: 'd-bob', expiresAt: 0, deviceLabel: 'Solus cloud',
})

const own = (sessionId: string, title = 'First') => records.upsertOwnSessionRecord({ sessionId, provider: 'claude-code', projectPath: '-repo', title, lastActivityAt: 1 })

describe('a record\'s organization', () => {
  test('a session record is born Local on a personal host, moves Local → A once, and refuses A → B', async () => {
    // WHY: a record's organization is the boundary every scoped read trusts; a
    // second assignment would move rows between organizations behind their backs.
    expect(await own('s1')).toMatchObject({ organizationId: 'local', publication: 'local' })
    expect(await records.assignSessionOrganization('s1', 'A')).toMatchObject({ sessionId: 's1', organizationId: 'A' })
    // Asking again for the same organization answers the record as it stands.
    expect(await records.assignSessionOrganization('s1', 'A')).toMatchObject({ organizationId: 'A' })
    // Another organization gets nothing, and the record stays where it is.
    expect(await records.assignSessionOrganization('s1', 'B')).toBeNull()
    expect((await records.getSessionRecord(principal.ANY_ORGANIZATION, 's1'))?.organizationId).toBe('A')
    // A record nobody wrote cannot be assigned.
    expect(await records.assignSessionOrganization('nobody', 'A')).toBeNull()
  })

  test('the host\'s own writers keep an assigned organization; a report into another organization does not touch the record', async () => {
    const before = await records.getSessionRecord('A', 's1')
    expect(before).not.toBeNull()
    const merged = await own('s1', 'Renamed by the indexer')
    expect(merged).toMatchObject({ organizationId: 'A', title: 'Renamed by the indexer', createdAt: before!.createdAt })
    // A member's report into B names a record that exists in A: nothing changes.
    await records.upsertSessionRecord('B', { sessionId: 's1', provider: 'claude-code', projectPath: '-repo', title: 'Hijacked', lastActivityAt: 5 })
    expect(await records.getSessionRecord('B', 's1')).toBeNull()
    expect(await records.getSessionRecord('A', 's1')).toMatchObject({ title: 'Renamed by the indexer' })
  })

  test('a read names its scope: every organization on the disk, or one', async () => {
    await own('s-local')
    await own('s-a2')
    await records.assignSessionOrganization('s-a2', 'A')
    const all = (await records.listSessionRecords(principal.ANY_ORGANIZATION)).map((record) => [record.sessionId, record.organizationId]).sort()
    expect(all).toEqual([['s-a2', 'A'], ['s-local', 'local'], ['s1', 'A']])
    expect((await records.listSessionRecords('A')).map((record) => record.sessionId).sort()).toEqual(['s-a2', 's1'])
    expect((await records.listSessionRecords('local')).map((record) => record.sessionId)).toEqual(['s-local'])
    expect(await records.listSessionRecords('B')).toEqual([])
    expect(await records.getSessionRecord('local', 's1')).toBeNull()
    expect(await records.getSessionRecord('A', 's-local')).toBeNull()
    // A session's children inherit its organization; a session with no record inherits this machine's.
    expect(await records.organizationOfSession('s1')).toBe('A')
    expect(await records.organizationOfSession('never')).toBe('local')
  })

  test('a work created Local and one created in A read the same way through their scopes', async () => {
    const local = await works.createWork('local', 'Scratch', 'doc', '# scratch', '', undefined, 'claude-code', '/repo')
    const inA = await works.createWork('A', 'Team doc', 'doc', '# team', '', undefined, 'claude-code', '/repo')
    expect(local.organizationId).toBe('local')
    expect(inA.organizationId).toBe('A')
    expect((await works.listWorks(principal.ANY_ORGANIZATION)).map((work) => [work.title, work.organizationId]).sort()).toEqual([['Scratch', 'local'], ['Team doc', 'A']])
    expect((await works.listWorks('local')).map((work) => work.id)).toEqual([local.id])
    expect((await works.listWorks('A')).map((work) => work.id)).toEqual([inA.id])
    expect(await works.loadWork('A', local.id)).toBeNull()
    expect((await works.loadWork('A', inA.id))?.content).toBe('# team')
    expect((await works.loadWork(principal.ANY_ORGANIZATION, local.id))?.content).toBe('# scratch')
  })

  test('where a new record starts: Local on a personal host, the host\'s organization on a managed host, a member\'s own wherever they are', () => {
    // A personal host's owner reads everything and writes scratch.
    expect(principal.recordScopeOf(LOCAL_OWNER)).toBe(principal.ANY_ORGANIZATION)
    expect(principal.organizationForNew(LOCAL_OWNER)).toBe('local')
    expect(principal.organizationForNew(memberOf('B'))).toBe('B')
    expect(principal.recordScopeOf(memberOf('B'))).toBe('B')
    expect(principal.scopeAdmits(principal.ANY_ORGANIZATION, 'B')).toBe(true)
    expect(principal.scopeAdmits('A', 'B')).toBe(false)
    expect(principal.scopeAdmits('A', 'A')).toBe(true)

    // A managed host was provisioned for A: its own work is A's, the host itself reads the
    // whole disk, and a pairing credential — which a managed host never issues — would keep
    // only Local records, as on any machine attached for organization work.
    hostCategory.adoptProvisionedLink({ organizationId: 'A' })
    try {
      expect(principal.organizationForNew(LOCAL_OWNER)).toBe('A')
      expect(principal.organizationForNew(principal.INTERNAL_PRINCIPAL)).toBe('A')
      expect(principal.recordScopeOf(principal.INTERNAL_PRINCIPAL)).toBe(principal.ANY_ORGANIZATION)
      expect(principal.recordScopeOf(LOCAL_OWNER)).toBe('local')
      expect(principal.organizationForNew(memberOf('B'))).toBe('B')
    } finally {
      hostCategory.resetHostCategoryForTests()
    }
  })

  test('on a managed host the host\'s own session records are born in its organization', async () => {
    hostCategory.adoptProvisionedLink({ organizationId: 'A' })
    try {
      expect(await own('s-managed')).toMatchObject({ organizationId: 'A', publication: 'local' })
      expect(await records.organizationOfSession('never')).toBe('A')
    } finally {
      hostCategory.resetHostCategoryForTests()
    }
  })
})
