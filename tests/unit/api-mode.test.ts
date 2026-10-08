import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AccessTokenClaims } from '@solus/contracts/uplink'
import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import type { HostEventPublisher } from '@solus/server/transport/events/host-event-publisher'
import { resetTestDatabase } from './helpers/test-db'
import { installTestIdentities } from './helpers/acting-identities'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §15: the workspace service is one process for
// every organization. A member reaches the records of their organization and no
// other; a runner reaches its organization's system-only writes and nothing else;
// nobody is trusted by network position; and the service serves one plane.

const ISSUER = 'https://cloud.example.test'
const previousEnv = { ...process.env }
let dataDir: string

type Principal = import('@solus/server/admission/principal').Principal
type HandlerCtx = import('@solus/server/transport/server').HandlerCtx

let principalModule: typeof import('@solus/server/admission/principal')
let apiMode: typeof import('@solus/server/host/api-mode')
let http: typeof import('@solus/server/transport/http')
let auth: typeof import('@solus/server/admission/auth')
let accessPolicy: typeof import('@solus/server/admission/access-policy')
let serverModule: typeof import('@solus/server/transport/server')
let shareManager: typeof import('@solus/server/sharing/share-manager')
let database: typeof import('@solus/server/db/database')
let dbModule: typeof import('@solus/server/db')
let tasksHandlers: typeof import('@solus/server/transport/handlers/tasks-handlers')
let folioHandlers: typeof import('@solus/server/transport/handlers/folio-handlers')
let sharingHandlers: typeof import('@solus/server/transport/handlers/sharing-handlers')
let historyHandlers: typeof import('@solus/server/transport/handlers/history-handlers')
let connectionsHandlers: typeof import('@solus/server/transport/handlers/connections-handlers')
let presenceModule: typeof import('@solus/server/presence/presence-manager')
let trustedRequesters: typeof import('@solus/server/transport/trusted-requesters')
let lanDiscovery: typeof import('@solus/server/transport/lan-discovery')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-api-mode-'))
  process.env.SOLUS_DATA_DIR = dataDir
  process.env.SOLUS_API = '1'
  process.env.SOLUS_CLOUD_ISSUER = ISSUER
  process.env.SOLUS_CLOUD_JWKS_URL = `${ISSUER}/api/auth/jwks`
  principalModule = await import('@solus/server/admission/principal')
  apiMode = await import('@solus/server/host/api-mode')
  http = await import('@solus/server/transport/http')
  auth = await import('@solus/server/admission/auth')
  accessPolicy = await import('@solus/server/admission/access-policy')
  serverModule = await import('@solus/server/transport/server')
  shareManager = await import('@solus/server/sharing/share-manager')
  database = await import('@solus/server/db/database')
  dbModule = await import('@solus/server/db')
  tasksHandlers = await import('@solus/server/transport/handlers/tasks-handlers')
  folioHandlers = await import('@solus/server/transport/handlers/folio-handlers')
  sharingHandlers = await import('@solus/server/transport/handlers/sharing-handlers')
  historyHandlers = await import('@solus/server/transport/handlers/history-handlers')
  connectionsHandlers = await import('@solus/server/transport/handlers/connections-handlers')
  presenceModule = await import('@solus/server/presence/presence-manager')
  trustedRequesters = await import('@solus/server/transport/trusted-requesters')
  lanDiscovery = await import('@solus/server/transport/lan-discovery')
  apiMode.resetApiModeForTests()
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  for (const key of ['SOLUS_DATA_DIR', 'SOLUS_API', 'SOLUS_CLOUD_ISSUER', 'SOLUS_CLOUD_JWKS_URL']) {
    if (previousEnv[key] === undefined) delete process.env[key]
    else process.env[key] = previousEnv[key]
  }
})

const now = () => Math.floor(Date.now() / 1000)
const claims = (over: Partial<AccessTokenClaims>): AccessTokenClaims => ({
  iss: ISSUER, aud: SOLUS_API_AUDIENCE, sub: 'alice', deviceId: 'session_1', jti: crypto.randomUUID(),
  iat: now(), exp: now() + 600, hostKind: 'cloud', ...over,
})

function member(userId: string, organizationId: string, organizationRole: 'owner' | 'member' = 'member'): Principal {
  return { kind: 'org-member', userId, organizationId, organizationRole, teamIds: [], hostKind: 'cloud', displayName: userId, deviceId: `d-${userId}`, expiresAt: Date.now() + 600_000, deviceLabel: 'Solus cloud' }
}

function runner(hostId: string, organizationId: string): Principal {
  return principalModule.runnerPrincipalFor({ hostId, organizationId, ownerUserId: 'alice', expiresAt: Date.now() + 600_000 })
}

const ctx = (principal: Principal): HandlerCtx => ({ clientId: `ws:${principal.kind === 'system' ? 'system' : principal.deviceId}`, principal })

// Members act from homes of their own, as on a booted server (plans/019).
installTestIdentities()

describe('booting in API mode', () => {
  test('the mode is read from the environment, needs its issuer, and needs Postgres unless a test says sqlite', () => {
    expect(apiMode.isApiMode()).toBe(true)
    expect(apiMode.apiModeConfig()).toEqual({ issuer: ISSUER, jwksUrl: `${ISSUER}/api/auth/jwks` })
    expect(() => apiMode.applyApiMode({ SOLUS_API: '1', SOLUS_CLOUD_ISSUER: ISSUER })).toThrow(/SOLUS_CLOUD_JWKS_URL/)
    expect(() => apiMode.applyApiMode({ SOLUS_API: '1', SOLUS_CLOUD_ISSUER: ISSUER, SOLUS_CLOUD_JWKS_URL: 'x' })).toThrow(/DATABASE_URL/)
    expect(() => apiMode.applyApiMode({ SOLUS_API: '1', SOLUS_CLOUD_ISSUER: ISSUER, SOLUS_CLOUD_JWKS_URL: 'x', SOLUS_DB: 'sqlite' })).not.toThrow()
    expect(() => apiMode.applyApiMode({ SOLUS_API: '1', SOLUS_CLOUD_ISSUER: ISSUER, SOLUS_CLOUD_JWKS_URL: 'x', DATABASE_URL: 'postgres://x' })).not.toThrow()
  })

  test('nobody is trusted by network position, LAN discovery is off, and the link methods do not exist', async () => {
    // WHY: the service is reached through a cloud proxy; loopback there is the proxy, not a person.
    expect(await trustedRequesters.isTrustedRequesterAddress('127.0.0.1')).toBe(false)
    expect(lanDiscovery.isLanDiscoveryDisabled({ SOLUS_API: '1' })).toBe(true)
    const owner: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
    await expect(accessPolicy.assertRpcAccess('uplinkLink', owner, [{}])).rejects.toMatchObject({ code: 'MANAGED_HOST' })
    await expect(accessPolicy.assertRpcAccess('connectionsGeneratePairToken', owner, [])).rejects.toMatchObject({ code: 'MANAGED_HOST' })
  })
})

describe('the ticket door of the workspace service', () => {
  test('only a member grant admits a person, as a member of the grant\'s organization', async () => {
    // WHY: an owner grant names a machine's owner; the service is nobody's machine. A
    // cloud guest is admitted only to a resource a link secret resolves to
    // (cloud-sharing); a guest grant made for a host is not the service's to honour.
    expect(await http.ticketForGrant(claims({ access: 'owner' }), null, undefined, { workspace: true })).toEqual({ ok: false, reason: 'member-required' })
    expect(await http.ticketForGrant(claims({ sub: 'guest:g1', deviceId: 'g1', access: 'guest', hostKind: 'personal' }), { shareSecret: 'x' }, async () => null, { workspace: true })).toEqual({ ok: false, reason: 'member-required' })
    expect(await http.ticketForGrant(claims({ sub: 'guest:g1', deviceId: 'g1', access: 'guest' }), { shareSecret: 'x' }, async () => null, { workspace: true })).toEqual({ ok: false, reason: 'not-shared' })
    const admitted = await http.ticketForGrant(claims({ sub: 'alice', access: 'org-member', organizationId: 'org1', organizationRole: 'owner', displayName: 'Alice' }), null, undefined, { workspace: true })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const principal = principalModule.principalFor({ kind: 'ticket', ticket: auth.consumeWsTicket(admitted.ticket)! })
    expect(principal).toMatchObject({ kind: 'org-member', userId: 'alice', organizationId: 'org1', hostKind: 'cloud' })
    expect(principalModule.recordScopeOf(principal)).toBe('org1')
    expect(principalModule.organizationForNew(principal)).toBe('org1')
    // An organization owner administers its workspace; a plain member does not.
    expect(principalModule.isHostAdmin(principal)).toBe(true)
    expect(principalModule.isHostAdmin(member('bob', 'org1'))).toBe(false)
  })

  test("a host's delegated token opens only the runner's socket on the API; it is the host acting for a person", async () => {
    // WHY: plans/010-standard-oauth.md — there is no machine identity that writes organization records.
    // The socket is how the API reaches the runner with shared prompts; a host admits none.
    const delegated = claims({ access: 'org-member', organizationId: 'org1', organizationRole: 'member', act: { sub: 'host_runner-1', host_id: 'runner-1' } })
    expect(await http.ticketForGrant(delegated, null, undefined, { workspace: false })).toEqual({ ok: false, reason: 'delegated-token' })
    const admitted = await http.ticketForGrant(delegated, null, undefined, { workspace: true })
    if (!admitted.ok) throw new Error('Expected a runner ticket')
    const { consumeWsTicket } = await import('@solus/server/admission/auth')
    expect(principalModule.principalFor({ kind: 'ticket', ticket: consumeWsTicket(admitted.ticket)! })).toMatchObject({ kind: 'runner', hostId: 'runner-1', organizationId: 'org1' })
    const runner = principalModule.runnerPrincipalFor({ hostId: 'runner-1', organizationId: 'org1', ownerUserId: 'bob', expiresAt: Date.now() + 60_000 })
    expect(principalModule.recordScopeOf(runner)).toBe('org1')
    expect(principalModule.organizationForNew(runner)).toBe('org1')
  })
})

describe('organization isolation through HTTP operations and retained RPC', () => {
  let api: WorkspaceOperations
  let resourceShares: import('@solus/server/sharing/share-manager').ShareManager
  const authority = (principal: Principal): WorkspaceRequestContext => {
    if (principal.kind !== 'org-member') throw new Error('Member required')
    return { principal, home: { kind: 'organization', organizationId: principal.organizationId, serviceId: 'workspace' }, scopes: ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read'] }
  }
  const alice = member('alice', 'org1', 'owner')
  const bob = member('bob', 'org2')
  // Built per test: the principal module loads in `beforeAll`, after this describe body ran.
  let runner1: Principal
  let runner2: Principal

  async function bootServer() {
    runner1 = runner('runner-1', 'org1')
    runner2 = runner('runner-2', 'org2')
    const server = new serverModule.SolusServer()
    server.useRoles(new Set(['collaboration']))
    const shares = new shareManager.ShareManager({ db: database.getDatabase() })
    resourceShares = shares
    api = (await import('@solus/server/data/workspace/service')).createWorkspaceOperations(shares)
    server.useResourceAccess(shares)
    tasksHandlers.registerTasksHandlers(server, { shares })
    folioHandlers.registerFolioHandlers(server, { shares })
    sharingHandlers.registerSharingHandlers(server, { shares })
    historyHandlers.registerHistoryHandlers(server, {
      // SAFETY: the session-record handlers under test read only the record store; the control plane and publisher are captured, never called.
      sessionRuntime: {} as SessionRuntime,
      events: {} as HostEventPublisher,
      agentIdFromContext: () => 'claude-code',
      exchangeProgress: () => undefined,
    })
    connectionsHandlers.registerConnectionsHandlers(server, {
      getServerInfo: () => ({ host: '0.0.0.0', port: 3000, allowLan: true, remoteAccess: true, requireAuth: true, trustLocalNetwork: false, hostKind: 'cloud', roles: ['collaboration'] }),
      getActiveSessions: () => [],
      discoverLanServers: async () => [],
      setRemoteAccess: async () => { throw new Error('not here') },
      setTrustLocalNetwork: () => { throw new Error('not here') },
    })
    return server
  }

  test('a task, a work, a share list, and a session record of one organization are not found by another', async () => {
    // WHY: one Postgres serves every organization; the grant is the only thing that
    // tells them apart, so every read must come back empty — not refused, not found —
    // for anyone whose grant names a different organization. Inside the
    // organization the workspace is the team's space, as a managed host is: a
    // member sees what another member made there.
    const server = await bootServer()
    const alicesColleague = member('carol', 'org1')

    const task = await api.createTask(authority(alice), { title: 'Ship it', projectKey: '/repo' }, 'org-task-create-key-01')
    expect((await api.listTasks(authority(alice), { limit: 50 })).items.map(row => row.id)).toEqual([task.id])
    expect((await api.listTasks(authority(alicesColleague), { limit: 50 })).items.map(row => row.id)).toEqual([task.id])
    expect((await api.getTask(authority(alicesColleague), task.id)).id).toBe(task.id)
    expect((await api.listTasks(authority(bob), { limit: 50 })).items).toEqual([])
    await expect(api.getTask(authority(bob), task.id)).rejects.toThrow('not found')
    const work = await api.createWork(authority(alice), { title: 'Spec', type: 'doc', content: '# Spec', projectKey: '/repo' }, 'org-work-create-key-01')
    expect((await api.listWorks(authority(alice), { limit: 50 })).items.map(row => row.id)).toEqual([work.id])
    expect((await api.listWorks(authority(bob), { limit: 50 })).items).toEqual([])
    await expect(api.getWork(authority(bob), work.id)).rejects.toThrow('not found')
    expect((await api.getWork(authority(alice), work.id)).id).toBe(work.id)

    const list = await server.handle('shareGet', [{ resource: { kind: 'task', id: task.id } }], ctx(alice))
    expect(list.ownerUserId).toBe('alice')
    await expect(server.handle('shareGet', [{ resource: { kind: 'task', id: task.id } }], ctx(bob))).rejects.toBeInstanceOf(accessPolicy.RpcAccessError)

    await server.handle('sessionRecordUpsert', [{ sessionId: 's-org1', provider: 'claude-code', projectPath: '-repo', title: 'Ours', lastActivityAt: 1 }], ctx(runner1))
    await server.handle('sessionRecordUpsert', [{ sessionId: 's-org2', provider: 'codex', projectPath: '-repo', title: 'Theirs', lastActivityAt: 2 }], ctx(runner2))
    await resourceShares.claimOwner({ kind: 'session', id: 's-org1' }, alice)
    await resourceShares.claimOwner({ kind: 'session', id: 's-org2' }, bob)
    const aliceRecords = await api.listSessions(authority(alice), { limit: 50 })
    expect(aliceRecords.items.map(record => [record.id, record.runnerHostId])).toEqual([['s-org1', 'runner-1']])
    expect((await api.listSessions(authority(bob), { limit: 50 })).items.map(record => record.id)).toEqual(['s-org2'])
  })

  test('a runner report carries where its session runs, a later report keeps it, and a member lists it', async () => {
    // WHY: a client lists an organization's sessions from the service alone. A
    // record that cannot name its working directory, branch and parent cannot be
    // resumed or grouped, and a report that omits them must not erase them.
    const server = await bootServer()
    await server.handle('sessionRecordUpsert', [{
      sessionId: 's-where', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 3,
      cwd: '/home/vm/repo', slug: 'brave-otter', isWorktree: true, branch: 'feat/x', projectRoot: '/home/vm/repo',
      parentSessionId: 's-parent', rootSessionId: 's-parent',
      delegation: { messageId: 'm-1', depth: 1, intent: 'delegate', createdAt: 2 },
    }], ctx(runner1))
    await server.handle('sessionRecordUpsert', [{ sessionId: 's-where', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 4 }], ctx(runner1))
    await resourceShares.claimOwner({ kind: 'session', id: 's-where' }, alice)

    const page = await api.listSessions(authority(alice), { limit: 50 })
    expect(page.items.find(item => item.id === 's-where')).toMatchObject({
      cwd: '/home/vm/repo', slug: 'brave-otter', isWorktree: true, branch: 'feat/x', projectRoot: '/home/vm/repo',
      delegation: { messageId: 'm-1', depth: 1, intent: 'delegate', createdAt: 2 },
    })
    // The service has no first sweep: its list is always its whole list.
    expect(page.indexing).toBe(false)
  })

  test('while the index is still filling, a list and a search say so', async () => {
    // WHY: before a machine's first sweep ends its records are not every
    // session. A client that took that answer as final would say "no sessions"
    // about a project that has some.
    await bootServer()
    const records = await import('@solus/server/data/sessions/session-records')
    records.useSessionIndexState(() => false)
    try {
      expect((await api.listSessions(authority(alice), { limit: 50 })).indexing).toBe(true)
      expect((await api.searchSessions(authority(alice), { q: 'anything' })).indexing).toBe(true)
    } finally {
      records.useSessionIndexState(() => true)
    }
  })

  test('a member finds what was said in their organization\'s mirrored sessions, and nowhere else', async () => {
    // WHY: an organization's sessions are searched on the service, not on the
    // machine that ran them, so the answer must hold while that machine is off —
    // and must never reach across organizations or into tool output.
    const server = await bootServer()
    const { getDatabase } = await import('@solus/server/db/database')
    const { sql } = await import('drizzle-orm')
    await server.handle('sessionRecordUpsert', [{ sessionId: 's-said-1', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 5 }], ctx(runner1))
    await server.handle('sessionRecordUpsert', [{ sessionId: 's-said-2', provider: 'claude-code', projectPath: '-repo', lastActivityAt: 5 }], ctx(runner2))
    await resourceShares.claimOwner({ kind: 'session', id: 's-said-1' }, alice)
    await resourceShares.claimOwner({ kind: 'session', id: 's-said-2' }, bob)
    const mirror = async (organizationId: string, sessionId: string, runnerHostId: string, position: number, message: object) =>
      getDatabase().run(sql`INSERT INTO session_transcripts (organization_id, session_id, position, runner_host_id, message, updated_at)
        VALUES (${organizationId}, ${sessionId}, ${position}, ${runnerHostId}, ${JSON.stringify(message)}, 1)`)
    await mirror('org1', 's-said-1', 'runner-1', 0, { role: 'user', content: 'roll the canary out', timestamp: 10 })
    await mirror('org1', 's-said-1', 'runner-1', 1, { role: 'assistant', toolName: 'Bash', content: 'canary deploy log', timestamp: 11 })
    await mirror('org1', 's-said-1', 'runner-1', 2, { role: 'assistant', content: 'The canary is live.', timestamp: 12 })
    await mirror('org2', 's-said-2', 'runner-2', 0, { role: 'user', content: 'our own canary', timestamp: 10 })

    const found = await api.searchSessions(authority(alice), { q: 'cana' })
    expect(found.items.map(item => item.session.id)).toEqual(['s-said-1'])
    expect(found.items[0]!.session.runnerHostId).toBe('runner-1')
    const positions = [found.items[0]!.messageId, ...found.items[0]!.additionalMatches.map(hit => hit.messageId)].sort()
    expect(positions).toEqual([0, 2])
    expect((await api.searchSessions(authority(bob), { q: 'canary' })).items.map(item => item.session.id)).toEqual(['s-said-2'])

  })

  test('a member finds a session by its title and by words said in different messages, a page at a time', async () => {
    // WHY: search treats a session as a whole (docs/plans/unified-search.md):
    // its title counts, its words need not share one message, and every match
    // is reachable a page at a time with the total known.
    const server = await bootServer()
    const { getDatabase } = await import('@solus/server/db/database')
    const { sql } = await import('drizzle-orm')
    const upsert = (sessionId: string, fields: { customTitle?: string; lastActivityAt: number }) =>
      server.handle('sessionRecordUpsert', [{ sessionId, provider: 'claude-code', projectPath: '-repo', ...fields }], ctx(runner1))
    await upsert('s-titled', { customTitle: 'Heron migration plan', lastActivityAt: 1 })
    await upsert('s-spread', { lastActivityAt: 2 })
    await upsert('s-half', { lastActivityAt: 3 })
    for (const id of ['s-titled', 's-spread', 's-half']) await resourceShares.claimOwner({ kind: 'session', id }, alice)
    const mirror = (sessionId: string, position: number, content: string) =>
      getDatabase().run(sql`INSERT INTO session_transcripts (organization_id, session_id, position, runner_host_id, message, updated_at)
        VALUES ('org1', ${sessionId}, ${position}, 'runner-1', ${JSON.stringify({ role: 'user', content, timestamp: position })}, 1)`)
    await mirror('s-titled', 0, 'nothing about birds')
    await mirror('s-spread', 0, 'the heron landed')
    await mirror('s-spread', 1, 'then the migration ran')
    await mirror('s-half', 0, 'the heron landed')

    const found = await api.searchSessions(authority(alice), { q: 'heron migration' })
    expect(found.total).toBe(2)
    // The title holds every word: it ranks first, with no passage to show.
    expect(found.items.map(item => item.session.id)).toEqual(['s-titled', 's-spread'])
    expect(found.items[0]!.snippet).toBeUndefined()
    expect(found.items[1]!.additionalMatches).toHaveLength(1)
    const second = await api.searchSessions(authority(alice), { q: 'heron migration', limit: 1, offset: 1 })
    expect(second).toMatchObject({ total: 2 })
    expect(second.items.map(item => item.session.id)).toEqual(['s-spread'])
    expect((await api.searchSessions(authority(alice), { q: 'heron', namesOnly: 'true' })).items.map(item => item.session.id)).toEqual(['s-titled'])
  })

  test('a runner reaches the system-only writes of its organization and nothing else; no person writes a record', async () => {
    const server = await bootServer()
    await expect(server.handle('sessionRecordUpsert', [{ sessionId: 's-x', provider: 'claude-code', projectPath: '-p', lastActivityAt: 1 }], ctx(alice))).rejects.toThrow(/only available to the host itself/)
    await expect(server.handle('tasksSidebarSnapshot', [], ctx(runner1))).rejects.toThrow(/not available to a runner/)
    await expect(server.handle('connectionsGetServerInfo', [], ctx(runner1))).rejects.toThrow(/not available to a runner/)
    // The record a runner writes is stamped with the runner, whatever the body claimed.
    const record = await server.handle('sessionRecordUpsert', [{ sessionId: 's-stamped', provider: 'claude-code', projectPath: '-p', runnerHostId: 'someone-else', lastActivityAt: 1 }], ctx(runner1))
    expect(record.runnerHostId).toBe('runner-1')
  })

  test('the service answers hostKind cloud, the organization, and its roles, so a client keeps it out of execution targets', async () => {
    const server = await bootServer()
    const info = await server.handle('connectionsGetServerInfo', [], ctx(alice))
    expect(info).toMatchObject({ hostKind: 'cloud', organizationId: 'org1', roles: ['collaboration'], principal: 'org-member', userId: 'alice' })
    await expect(server.handle('prompt', [{ session: { sessionId: 's' } }, { prompt: 'x' }], ctx(alice))).rejects.toMatchObject({ code: 'PLANE_DISABLED' })
  })

  test('presence is one room per organization', async () => {
    // WHY: a roster that named another organization's people would be the one
    // host-wide fact the service must never leak.
    const presence = new presenceModule.PresenceManager()
    presence.join('c-alice', alice, 'Web')
    presence.join('c-bob', bob, 'Web')
    expect(presence.join('c-runner', runner1, 'Runner')).toBe(false)
    expect((await presence.hostSnapshot('org1')).participants.map((participant) => participant.user.id)).toEqual([{ kind: 'account', accountId: 'alice' }])
    expect((await presence.hostSnapshot('org2')).participants.map((participant) => participant.user.id)).toEqual([{ kind: 'account', accountId: 'bob' }])
    expect(presence.organizations().sort()).toEqual(['org1', 'org2'])
    expect(presence.clientsIn('org1')).toEqual(['c-alice'])
    expect(presence.organizationOf('c-bob')).toBe('org2')
  })
})
