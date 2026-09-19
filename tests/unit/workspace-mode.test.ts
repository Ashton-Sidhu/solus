import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { HostGrantClaims } from '@solus/contracts/uplink'
import { WORKSPACE_AUDIENCE } from '@solus/contracts/uplink'
import type { ControlPlane } from '@solus/server/control-plane'
import type { HostEventPublisher } from '@solus/server/events/host-event-publisher'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §15: the workspace service is one process for
// every organization. A member reaches the records of their organization and no
// other; a runner reaches its organization's system-only writes and nothing else;
// nobody is trusted by network position; and the service serves one plane.

const ISSUER = 'https://cloud.example.test'
const previousEnv = { ...process.env }
let dataDir: string

type Principal = import('@solus/server/server/principal').Principal
type HandlerCtx = import('@solus/server/server/server').HandlerCtx

let principalModule: typeof import('@solus/server/server/principal')
let workspaceMode: typeof import('@solus/server/server/workspace-mode')
let http: typeof import('@solus/server/server/http')
let auth: typeof import('@solus/server/server/auth')
let accessPolicy: typeof import('@solus/server/server/access-policy')
let serverModule: typeof import('@solus/server/server/server')
let shareManager: typeof import('@solus/server/sharing/share-manager')
let database: typeof import('@solus/server/db/database')
let dbModule: typeof import('@solus/server/db')
let tasksHandlers: typeof import('@solus/server/server/handlers/tasks-handlers')
let folioHandlers: typeof import('@solus/server/server/handlers/folio-handlers')
let sharingHandlers: typeof import('@solus/server/server/handlers/sharing-handlers')
let historyHandlers: typeof import('@solus/server/server/handlers/history-handlers')
let connectionsHandlers: typeof import('@solus/server/server/handlers/connections-handlers')
let presenceModule: typeof import('@solus/server/presence/presence-manager')
let trustedRequesters: typeof import('@solus/server/server/trusted-requesters')
let lanDiscovery: typeof import('@solus/server/server/lan-discovery')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-workspace-mode-'))
  process.env.SOLUS_DATA_DIR = dataDir
  process.env.SOLUS_WORKSPACE = '1'
  process.env.SOLUS_CLOUD_ISSUER = ISSUER
  process.env.SOLUS_CLOUD_JWKS_URL = `${ISSUER}/api/auth/jwks`
  principalModule = await import('@solus/server/server/principal')
  workspaceMode = await import('@solus/server/server/workspace-mode')
  http = await import('@solus/server/server/http')
  auth = await import('@solus/server/server/auth')
  accessPolicy = await import('@solus/server/server/access-policy')
  serverModule = await import('@solus/server/server/server')
  shareManager = await import('@solus/server/sharing/share-manager')
  database = await import('@solus/server/db/database')
  dbModule = await import('@solus/server/db')
  tasksHandlers = await import('@solus/server/server/handlers/tasks-handlers')
  folioHandlers = await import('@solus/server/server/handlers/folio-handlers')
  sharingHandlers = await import('@solus/server/server/handlers/sharing-handlers')
  historyHandlers = await import('@solus/server/server/handlers/history-handlers')
  connectionsHandlers = await import('@solus/server/server/handlers/connections-handlers')
  presenceModule = await import('@solus/server/presence/presence-manager')
  trustedRequesters = await import('@solus/server/server/trusted-requesters')
  lanDiscovery = await import('@solus/server/server/lan-discovery')
  workspaceMode.resetWorkspaceModeForTests()
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  for (const key of ['SOLUS_DATA_DIR', 'SOLUS_WORKSPACE', 'SOLUS_CLOUD_ISSUER', 'SOLUS_CLOUD_JWKS_URL']) {
    if (previousEnv[key] === undefined) delete process.env[key]
    else process.env[key] = previousEnv[key]
  }
})

const now = () => Math.floor(Date.now() / 1000)
const claims = (over: Partial<HostGrantClaims>): HostGrantClaims => ({
  iss: ISSUER, aud: WORKSPACE_AUDIENCE, sub: 'user:alice', deviceId: 'session_1', jti: crypto.randomUUID(),
  iat: now(), exp: now() + 600, hostKind: 'cloud', ...over,
})

function member(userId: string, organizationId: string, organizationRole: 'owner' | 'member' = 'member'): Principal {
  return { kind: 'org-member', userId, organizationId, organizationRole, teamIds: [], hostKind: 'cloud', displayName: userId, deviceId: `d-${userId}`, expiresAt: Date.now() + 600_000, deviceLabel: 'Solus cloud' }
}

function runner(hostId: string, organizationId: string): Principal {
  return principalModule.runnerPrincipalFor({ hostId, organizationId, expiresAt: Date.now() + 600_000 })
}

const ctx = (principal: Principal): HandlerCtx => ({ clientId: `ws:${principalModule.principalDisplayName(principal)}`, principal })

describe('booting in workspace mode', () => {
  test('the mode is read from the environment, needs its issuer, and needs Postgres unless a test says sqlite', () => {
    expect(workspaceMode.isWorkspaceMode()).toBe(true)
    expect(workspaceMode.workspaceConfig()).toEqual({ issuer: ISSUER, jwksUrl: `${ISSUER}/api/auth/jwks` })
    expect(() => workspaceMode.applyWorkspaceMode({ SOLUS_WORKSPACE: '1', SOLUS_CLOUD_ISSUER: ISSUER })).toThrow(/SOLUS_CLOUD_JWKS_URL/)
    expect(() => workspaceMode.applyWorkspaceMode({ SOLUS_WORKSPACE: '1', SOLUS_CLOUD_ISSUER: ISSUER, SOLUS_CLOUD_JWKS_URL: 'x' })).toThrow(/DATABASE_URL/)
    expect(() => workspaceMode.applyWorkspaceMode({ SOLUS_WORKSPACE: '1', SOLUS_CLOUD_ISSUER: ISSUER, SOLUS_CLOUD_JWKS_URL: 'x', SOLUS_DB: 'sqlite' })).not.toThrow()
    expect(() => workspaceMode.applyWorkspaceMode({ SOLUS_WORKSPACE: '1', SOLUS_CLOUD_ISSUER: ISSUER, SOLUS_CLOUD_JWKS_URL: 'x', DATABASE_URL: 'postgres://x' })).not.toThrow()
  })

  test('nobody is trusted by network position, LAN discovery is off, and the link methods do not exist', async () => {
    // WHY: the service is reached through a cloud proxy; loopback there is the proxy, not a person.
    expect(await trustedRequesters.isTrustedRequesterAddress('127.0.0.1')).toBe(false)
    expect(lanDiscovery.isLanDiscoveryDisabled({ SOLUS_WORKSPACE: '1' })).toBe(true)
    const owner: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
    await expect(accessPolicy.assertRpcAccess('uplinkLink', owner, [{}])).rejects.toMatchObject({ code: 'MANAGED_HOST' })
    await expect(accessPolicy.assertRpcAccess('connectionsGeneratePairToken', owner, [])).rejects.toMatchObject({ code: 'MANAGED_HOST' })
  })
})

describe('the ticket door of the workspace service', () => {
  test('only a member grant admits a person, as a member of the grant\'s organization', async () => {
    // WHY: an owner grant names a machine's owner; the service is nobody's machine. A
    // guest link is a host's resource; the service has none to bind a guest to (P1).
    expect(await http.ticketForGrant(claims({ access: 'owner' }), null, undefined, { workspace: true })).toEqual({ ok: false, reason: 'member-required' })
    expect(await http.ticketForGrant(claims({ sub: 'guest:g1', deviceId: 'g1', access: 'guest' }), { shareSecret: 'x' }, async () => null, { workspace: true })).toEqual({ ok: false, reason: 'member-required' })
    const admitted = await http.ticketForGrant(claims({ sub: 'user:alice', access: 'org-member', organizationId: 'org1', organizationRole: 'owner', displayName: 'Alice' }), null, undefined, { workspace: true })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const principal = principalModule.principalFor({ kind: 'ticket', ticket: auth.consumeWsTicket(admitted.ticket)! })
    expect(principal).toMatchObject({ kind: 'org-member', userId: 'alice', organizationId: 'org1', hostKind: 'cloud' })
    expect(principalModule.organizationOf(principal)).toBe('org1')
    // An organization owner administers its workspace; a plain member does not.
    expect(principalModule.isHostAdmin(principal)).toBe(true)
    expect(principalModule.isHostAdmin(member('bob', 'org1'))).toBe(false)
  })

  test('a runner grant admits a runner of its organization, and only with one', async () => {
    const admitted = await http.ticketForGrant(claims({ sub: 'host:runner-1', deviceId: 'runner-1', organizationId: 'org1', runner: { hostId: 'runner-1' } }), null, undefined, { workspace: true })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const principal = principalModule.principalFor({ kind: 'ticket', ticket: auth.consumeWsTicket(admitted.ticket)! })
    expect(principal).toMatchObject({ kind: 'runner', hostId: 'runner-1', organizationId: 'org1' })
    expect(principalModule.organizationOf(principal)).toBe('org1')
    expect(principalModule.principalOwnerId(principal)).toBeNull()
    expect(await http.ticketForGrant(claims({ sub: 'host:runner-1', deviceId: 'runner-1', runner: { hostId: 'runner-1' } }), null, undefined, { workspace: true })).toEqual({ ok: false, reason: 'runner-organization' })
  })
})

describe('organization isolation through the RPC layer', () => {
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
    server.useResourceAccess(shares)
    tasksHandlers.registerTasksHandlers(server, { shares })
    folioHandlers.registerFolioHandlers(server, { shares })
    sharingHandlers.registerSharingHandlers(server, { shares })
    historyHandlers.registerHistoryHandlers(server, {
      // SAFETY: the session-record handlers under test read only the record store; the control plane and publisher are captured, never called.
      controlPlane: {} as ControlPlane,
      events: {} as HostEventPublisher,
      agentIdFromContext: () => 'claude-code',
      shares,
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

    const task = await server.handle('tasksCreate', [{ title: 'Ship it', projectKey: '/repo' }], ctx(alice))
    expect((await server.handle('tasksList', [{}], ctx(alice))).tasks.map((row) => row.id)).toEqual([task.id])
    expect((await server.handle('tasksList', [{}], ctx(alicesColleague))).tasks.map((row) => row.id)).toEqual([task.id])
    await expect(server.handle('tasksGet', [task.id], ctx(alicesColleague))).resolves.toMatchObject({ task: { id: task.id } })
    expect((await server.handle('tasksList', [{}], ctx(bob))).tasks).toEqual([])
    await expect(server.handle('tasksGet', [task.id], ctx(bob))).rejects.toBeInstanceOf(accessPolicy.RpcAccessError)

    const work = await server.handle('createWork', ['Spec', 'doc', '# Spec', 'Spec', undefined, 'claude-code', '/repo'], ctx(alice))
    expect((await server.handle('listWorks', [], ctx(alice))).map((row) => row.id)).toEqual([work.id])
    expect(await server.handle('listWorks', [], ctx(bob))).toEqual([])
    await expect(server.handle('loadWork', [work.id], ctx(bob))).rejects.toBeInstanceOf(accessPolicy.RpcAccessError)
    expect((await server.handle('loadWork', [work.id], ctx(alice)))?.id).toBe(work.id)

    const list = await server.handle('shareGet', [{ resource: { kind: 'task', id: task.id } }], ctx(alice))
    expect(list.ownerUserId).toBe('alice')
    await expect(server.handle('shareGet', [{ resource: { kind: 'task', id: task.id } }], ctx(bob))).rejects.toBeInstanceOf(accessPolicy.RpcAccessError)

    await server.handle('sessionRecordUpsert', [{ sessionId: 's-org1', provider: 'claude-code', projectPath: '-repo', title: 'Ours', lastActivityAt: 1 }], ctx(runner1))
    await server.handle('sessionRecordUpsert', [{ sessionId: 's-org2', provider: 'codex', projectPath: '-repo', title: 'Theirs', lastActivityAt: 2 }], ctx(runner2))
    const aliceRecords = await server.handle('sessionRecordList', [{}], ctx(alice))
    expect(aliceRecords.map((record) => [record.sessionId, record.runnerHostId])).toEqual([['s-org1', 'runner-1']])
    expect((await server.handle('sessionRecordList', [{}], ctx(bob))).map((record) => record.sessionId)).toEqual(['s-org2'])
  })

  test('a runner reaches the system-only writes of its organization and nothing else; no person writes a record', async () => {
    const server = await bootServer()
    await expect(server.handle('sessionRecordUpsert', [{ sessionId: 's-x', provider: 'claude-code', projectPath: '-p', lastActivityAt: 1 }], ctx(alice))).rejects.toThrow(/only available to the host itself/)
    await expect(server.handle('tasksList', [{}], ctx(runner1))).rejects.toThrow(/not available to a runner/)
    await expect(server.handle('listWorks', [], ctx(runner1))).rejects.toThrow(/not available to a runner/)
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
    expect((await presence.hostSnapshot('org1')).participants.map((participant) => participant.userId)).toEqual(['alice'])
    expect((await presence.hostSnapshot('org2')).participants.map((participant) => participant.userId)).toEqual(['bob'])
    expect(presence.organizations().sort()).toEqual(['org1', 'org2'])
    expect(presence.clientsIn('org1')).toEqual(['c-alice'])
    expect(presence.organizationOf('c-bob')).toBe('org2')
  })
})
