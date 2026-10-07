import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { IpcContext } from '@solus/contracts/types'
import type { HostOrganizationsResponse, UplinkLinkConfig } from '@solus/contracts/uplink'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/organization-scope.md §3, §3.1, §6.1, R9–R11: at the start of a
// turn an unassigned Local session is assigned to the window's organization,
// once, and only when that organization's Insights would leave this machine;
// a session already assigned keeps its organization; an organization that
// refuses personal hosts does not run on one; and the verified account behind
// the turn is stamped on the actor.

let turnOrganization: typeof import('@solus/server/execution/sessions/turn-organization')
let organizations: typeof import('@solus/server/host/organizations')
let hostCategory: typeof import('@solus/server/host/host-category')
let insightMirror: typeof import('@solus/server/sync/mirror/insight-mirror')
let records: typeof import('@solus/server/data/sessions/session-records')
let dbModule: typeof import('@solus/server/db')
type Principal = import('@solus/server/admission/principal').Principal
let actorFor: typeof import('@solus/server/admission/actor')['actorFor']

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let hostOrganizations: InstanceType<typeof organizations.HostOrganizations>

const LINK: UplinkLinkConfig = { hostId: 'H', issuer: 'https://cloud.invalid', jwksUrl: 'https://cloud.invalid/jwks', directoryUrl: 'https://cloud.invalid', hostname: 'h-H.lab.invalid', proxiedPort: 1, connectionGeneration: 1 }

const STANDING: HostOrganizationsResponse = {
  hostId: 'H',
  category: 'personal',
  owner: { userId: 'alice', email: 'alice@example.test', name: 'Alice' },
  organizations: [
    { organizationId: 'A', name: 'Acme', shared: true, policy: { allowsCloudHosts: true, allowsPersonalHosts: true, syncAllInsights: true } },
    { organizationId: 'B', name: 'Bolt', shared: true, policy: { allowsCloudHosts: true, allowsPersonalHosts: false, syncAllInsights: false } },
  ],
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-turn-organization-'))
  process.env.SOLUS_DATA_DIR = dataDir
  turnOrganization = await import('@solus/server/execution/sessions/turn-organization')
  ;({ actorFor } = await import('@solus/server/admission/actor'))
  organizations = await import('@solus/server/host/organizations')
  hostCategory = await import('@solus/server/host/host-category')
  insightMirror = await import('@solus/server/sync/mirror/insight-mirror')
  records = await import('@solus/server/data/sessions/session-records')
  dbModule = await import('@solus/server/db')
  ;(await import('@solus/server/host/host-category')).resetHostCategoryForTests()
  hostCategory.resetHostCategoryForTests()
  hostOrganizations = new organizations.HostOrganizations({
    link: () => LINK,
    hostToken: () => 'sht_token',
    fetchImpl: async (url) => {
      if (String(url) !== 'https://cloud.invalid/v1/hosts/H/organizations') return new Response('{}', { status: 404 })
      return new Response(JSON.stringify(STANDING), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    setTimeoutFn: (() => ({ unref() {} })) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  })
  await hostOrganizations.refresh()
  // Wired as boot wires it: the organization's own setting, else the person's opt-in.
  insightMirror.useInsightsPolicy({
    syncAllInsights: (organizationId) => hostOrganizations.organization(organizationId)?.policy.syncAllInsights ?? null,
    optedIn: () => false,
    attached: () => false,
  })
})

afterAll(async () => {
  insightMirror.useInsightsPolicy({ syncAllInsights: () => null, optedIn: () => false, attached: () => false })
  hostCategory.resetHostCategoryForTests()
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const memberOf = (organizationId: string): Principal => ({
  kind: 'org-member', userId: 'bob', organizationId, organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Bob', deviceId: 'd-bob', expiresAt: 0, deviceLabel: 'Solus cloud', email: 'bob@example.test',
})

/** The window's context for a prompt: the session it sends to and the organization it is working in. */
const ctx = (sessionId: string, organizationId?: string): IpcContext => ({ session: { sessionId, organizationId } } as IpcContext)

const localRecord = (sessionId: string) => records.upsertOwnSessionRecord({ sessionId, provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
const organizationOf = async (sessionId: string) => (await records.getSessionRecord((await import('@solus/server/admission/principal')).ANY_ORGANIZATION, sessionId))?.organizationId ?? null

describe('admitting a turn', () => {
  test('the owner\'s prompt from a window in A assigns a Local session to A, once; a window in B, whose Insights stay home, leaves it Local', async () => {
    await localRecord('s-a')
    expect(await turnOrganization.admitTurnOrganization(ctx('s-a', 'A'), actorFor(OWNER), { hostOrganizations })).toBe('A')
    expect(await organizationOf('s-a')).toBe('A')
    // A later window in B changes nothing: the assignment was made once.
    expect(await turnOrganization.admitTurnOrganization(ctx('s-a', 'B'), actorFor(OWNER), { hostOrganizations })).toBe('A')
    expect(await organizationOf('s-a')).toBe('A')

    await localRecord('s-b')
    expect(await turnOrganization.admitTurnOrganization(ctx('s-b', 'B'), actorFor(OWNER), { hostOrganizations })).toBe('local')
    expect(await organizationOf('s-b')).toBe('local')
    // No window selection, or Local selected: Local it stays.
    expect(await turnOrganization.admitTurnOrganization(ctx('s-b'), actorFor(OWNER), { hostOrganizations })).toBe('local')
    expect(await turnOrganization.admitTurnOrganization(ctx('s-b', 'local'), actorFor(OWNER), { hostOrganizations })).toBe('local')
  })

  test('nobody may name an organization the host has never heard of; a member names only their own', async () => {
    await localRecord('s-c')
    expect(await turnOrganization.admitTurnOrganization(ctx('s-c', 'C'), actorFor(memberOf('A')), { hostOrganizations })).toBe('local')
    expect(await turnOrganization.admitTurnOrganization(ctx('s-c', 'C'), actorFor(OWNER), { hostOrganizations })).toBe('local')
    expect(await organizationOf('s-c')).toBe('local')
    // A member of A from a window in A assigns it.
    expect(await turnOrganization.admitTurnOrganization(ctx('s-c', 'A'), actorFor(memberOf('A')), { hostOrganizations })).toBe('A')
    expect(await organizationOf('s-c')).toBe('A')
  })

  test('a session with no record yet is born in the window\'s organization when its first write lands', async () => {
    expect(await turnOrganization.admitTurnOrganization(ctx('s-fresh', 'A'), actorFor(OWNER), { hostOrganizations })).toBe('A')
    expect(await organizationOf('s-fresh')).toBeNull()
    expect(await localRecord('s-fresh')).toMatchObject({ organizationId: 'A' })
  })

  test('an organization that refuses personal hosts does not run on one, even for the owner; a self-hosted server may', async () => {
    await localRecord('s-in-b')
    await records.assignSessionOrganization('s-in-b', 'B')
    const refused = turnOrganization.admitTurnOrganization(ctx('s-in-b', 'B'), actorFor(OWNER), { hostOrganizations })
    await expect(refused).rejects.toBeInstanceOf((await import('@solus/server/execution/sessions/turn-refusal')).TurnRefusedError)
    await expect(refused).rejects.toMatchObject({ code: 'PERSONAL_HOSTS_NOT_ALLOWED', message: expect.stringContaining('Bolt') })
    hostCategory.applyHostCategory('self-hosted')
    try {
      expect(await turnOrganization.admitTurnOrganization(ctx('s-in-b', 'B'), actorFor(OWNER), { hostOrganizations })).toBe('B')
    } finally {
      hostCategory.resetHostCategoryForTests()
    }
  })
})
