import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Server } from 'http'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { io as connect } from 'socket.io-client'

// bun has no node:sqlite; the http module's import chain reaches the db even
// though these tests never open it. Same seam tunnel-listener.test.ts uses.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const hostCategory = await import('@solus/server/host/host-category')
const hostLinkEnv = await import('@solus/server/host/host-link-env')
const { isTrustedRequesterAddress } = await import('@solus/server/transport/trusted-requesters')
const { isLanDiscoveryDisabled } = await import('@solus/server/transport/lan-discovery')
const { assertRpcAccess, RpcAccessError } = await import('@solus/server/admission/access-policy')
const { buildHttpServer } = await import('@solus/server/transport/http')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const auth = await import('@solus/server/admission/auth')
const { projectsRootFor, projectsVisibleTo } = await import('@solus/server/transport/handlers/setup-handlers')
const { setupProjectsRoot } = await import('@solus/server/workspace')

// docs/plans/managed-hosts.md §1: on a managed host nothing is trusted by network
// position, pairing does not exist, the link is system-owned, and the link tokens
// in the environment never reach a child process. A host is managed because its
// link names the organization Solus provisioned it for; no switch says so.
describe('managed host', () => {
  const originalEnv = { ...process.env }
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-managed-mode-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
    hostCategory.resetHostCategoryForTests()
    hostCategory.adoptProvisionedLink({ organizationId: 'org_1' })
    hostLinkEnv.resetHostLinkEnvForTests()
    auth.resetAuthStateForTests()
  })

  afterEach(() => {
    auth.resetAuthStateForTests()
    for (const key of ['SOLUS_HOST_LINK', 'SOLUS_PROJECTS_ROOT']) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    hostCategory.resetHostCategoryForTests()
    hostLinkEnv.resetHostLinkEnvForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  const envLink = {
    link: { hostId: 'abcdefghijklmnop', issuer: 'https://app.example.test', jwksUrl: 'https://app.example.test/api/auth/jwks', directoryUrl: 'https://app.example.test', hostname: 'h-abcdefghijklmnop.example.test', proxiedPort: 34118, connectionGeneration: 1 },
    connectorToken: 'connector-token', hostToken: 'sht_secret', oauthClient: { clientId: 'host_x', clientSecret: 'shc_secret' },
  }

  test('the environment link is read once and its tokens leave process.env on first read', () => {
    // WHY: agent processes inherit process.env; the tokens must not (§2).
    process.env.SOLUS_HOST_LINK = JSON.stringify(envLink)
    expect(hostLinkEnv.readHostLinkEnv()).toEqual(envLink)
    expect(process.env.SOLUS_HOST_LINK).toBeUndefined()
    // The second read answers from memory, not from the (now empty) environment.
    expect(hostLinkEnv.readHostLinkEnv()).toEqual(envLink)
  })

  test('an environment link that is not one is dropped, not stored', () => {
    process.env.SOLUS_HOST_LINK = '{"link":{"hostId":"x"}}'
    expect(hostLinkEnv.readHostLinkEnv()).toBeNull()
    expect(process.env.SOLUS_HOST_LINK).toBeUndefined()
  })

  test('the link decides the category: one that names an owning organization is a managed host, one that names none is not', () => {
    // WHY: the category decides whether any credential-free door opens; a flag in the
    // environment could be missing or wrong, the provisioned link cannot be.
    expect(hostCategory.hostCategory()).toBe('managed')
    expect(hostCategory.provisionedOrganizationId()).toBe('org_1')
    hostCategory.applyHostCategory('self-hosted')
    hostCategory.adoptProvisionedLink({})
    expect(hostCategory.hostCategory()).toBe('self-hosted')
    hostCategory.adoptProvisionedLink(null)
    expect(hostCategory.provisionedOrganizationId()).toBeNull()
  })

  test('nobody is a trusted requester: not loopback, not the LAN, whatever the setting says', async () => {
    expect(await isTrustedRequesterAddress('127.0.0.1')).toBe(false)
    expect(await isTrustedRequesterAddress('::1')).toBe(false)
    expect(await isTrustedRequesterAddress('192.168.1.42')).toBe(false)
  })

  test('LAN discovery is off: the managed boot says so, as the workspace service does', () => {
    expect(isLanDiscoveryDisabled({ SOLUS_NO_LAN_DISCOVERY: '1' })).toBe(true)
    expect(isLanDiscoveryDisabled({ SOLUS_API: '1' })).toBe(true)
    expect(isLanDiscoveryDisabled({})).toBe(false)
  })

  test('the link and the pairing RPCs are refused with MANAGED_HOST, even for a local owner', async () => {
    const owner = { kind: 'local-owner' as const, deviceId: null, deviceLabel: 'Mac' }
    for (const method of ['uplinkLink', 'uplinkUnlink', 'connectionsGeneratePairToken', 'connectionsSetTrustLocalNetwork', 'connectionsSetRemoteAccess'] as const) {
      let refusal: unknown
      try { await assertRpcAccess(method, owner, [{}]) } catch (err) { refusal = err }
      expect(refusal).toBeInstanceOf(RpcAccessError)
      if (refusal instanceof RpcAccessError) {
        expect(refusal.code).toBe('MANAGED_HOST')
        expect(refusal.message).toContain('managed host')
      }
    }
    // The status stays readable; a personal host keeps the ordinary policy.
    await expect(assertRpcAccess('uplinkStatus', owner, [])).resolves.toBeUndefined()
    await expect(assertRpcAccess('uplinkLink', owner, [{}], undefined, false)).resolves.toBeUndefined()
  })

  test('the ordinary listener demands a credential and has no pairing door', async () => {
    const { server, baseUrl } = await listen({
      requireAuth: () => true,
      isTrustedRequester: isTrustedRequesterAddress,
      isTunnelRequest: () => false,
      pairingDisabled: true,
    })
    try {
      const health = await (await fetch(`${baseUrl}/health`)).json() as { requireAuth: boolean }
      expect(health.requireAuth).toBe(true)
      expect((await fetch(`${baseUrl}/pair`, { method: 'POST', body: '{}' })).status).toBe(404)
      expect((await fetch(`${baseUrl}/pair/open`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${baseUrl}/auth/ws-ticket`, { method: 'POST' })).status).toBe(401)
    } finally {
      await close(server)
    }
  })

  test('a credential-free socket on the ordinary listener is refused', async () => {
    const { createServer } = await import('http')
    const http = createServer()
    const transport = attachWebSocketTransport(http, new SolusServer(), {
      clientEvents: new ClientEventRegistry(),
      requireAuth: () => true,
      isTrustedRequester: isTrustedRequesterAddress,
      isTunnelRequest: () => false,
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    const url = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
    try {
      const outcome = await new Promise<string>((resolve) => {
        const socket = connect(url, { path: '/ws', transports: ['websocket'], reconnection: false, auth: { clientInstanceId: 'test0123456789abcdef' } })
        socket.once('connect', () => { socket.disconnect(); resolve('connected') })
        socket.once('connect_error', (error: Error & { data?: { code?: string } }) => resolve(error.data?.code ?? error.message))
      })
      expect(outcome).toBe('UNAUTHORIZED')
    } finally {
      transport.close()
      http.close()
    }
  })

  test('a member gets a workspace of their own beneath the host root; the owner and the host use the root (§3)', () => {
    // WHY: on a shared host every member clones into a directory that is theirs, not
    // into one pile; the owner's pickers still open where they always did.
    const member = { kind: 'org-member' as const, userId: 'user_abc123', organizationId: 'org', organizationRole: 'member' as const, teamIds: [], hostKind: 'managed' as const, displayName: 'Bob', deviceId: 'd', expiresAt: 0, deviceLabel: 'Solus cloud' }
    const workspace = projectsRootFor(member, join(dataDir, 'projects'))
    expect(workspace).toBe(join(dataDir, 'projects', 'user_abc123'))
    expect(existsSync(workspace)).toBe(true)
    expect(projectsRootFor({ kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }, join(dataDir, 'projects'))).toBe(join(dataDir, 'projects'))
    expect(projectsRootFor(undefined, join(dataDir, 'projects'))).toBe(join(dataDir, 'projects'))
    expect(() => projectsRootFor({ ...member, userId: '../escape' }, join(dataDir, 'projects'))).toThrow()
  })

  test('a member\'s project listings show their workspace only; the owner sees every checkout (§3)', () => {
    // WHY: two people on one host must never be handed the same main checkout. A
    // project listed for a member is one that is theirs to open; the owner's own
    // clone and another member's are not.
    const root = join(dataDir, 'projects')
    const member = { kind: 'org-member' as const, userId: 'user_abc123', organizationId: 'org', organizationRole: 'member' as const, teamIds: [], hostKind: 'managed' as const, displayName: 'Bob', deviceId: 'd', expiresAt: 0, deviceLabel: 'Solus cloud' }
    const projects = [
      { path: join(root, 'solus') },
      { path: join(root, 'user_abc123', 'solus') },
      { path: join(root, 'user_abc123') },
      { path: join(root, 'user_other', 'solus') },
      { path: join(root, 'user_abc123-not', 'solus') },
    ]
    expect(projectsVisibleTo(member, projects, root).map((project) => project.path)).toEqual([join(root, 'user_abc123', 'solus'), join(root, 'user_abc123')])
    expect(projectsVisibleTo({ kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }, projects, root)).toHaveLength(5)
    expect(projectsVisibleTo(undefined, projects, root)).toHaveLength(5)
  })

  test('the projects root follows SOLUS_PROJECTS_ROOT until an administrator sets one (§3)', () => {
    expect(setupProjectsRoot({}, '/data/home', { SOLUS_PROJECTS_ROOT: '/data/projects' })).toBe('/data/projects')
    expect(setupProjectsRoot({ projectsBaseDirectory: '~/work' }, '/data/home', { SOLUS_PROJECTS_ROOT: '/data/projects' })).toBe('/data/home/work')
    // WHY: a new project must never land loose in the home folder.
    expect(setupProjectsRoot({}, '/data/home', {})).toBe('/data/home/projects')
  })
})

type HttpServerOptions = NonNullable<Parameters<typeof buildHttpServer>[0]>

async function listen(options: HttpServerOptions): Promise<{ server: Server; baseUrl: string }> {
  const { server } = buildHttpServer({ ...options, host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address && 'port' in address ? address.port : 0
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}
