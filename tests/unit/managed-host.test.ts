import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Server } from 'http'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { dialHostSocket } from '@solus/client-core/host-socket'

// bun has no node:sqlite; the http module's import chain reaches the db even
// though these tests never open it. Same seam tunnel-listener.test.ts uses.
mock.module('node:sqlite', () => ({ DatabaseSync }))

const machine = await import('@solus/server/host/machine-kind')
const bootLinkCode = await import('@solus/server/host/boot-link-code')
const { isTrustedRequesterAddress } = await import('@solus/server/transport/trusted-requesters')
const { isLanDiscoveryDisabled } = await import('@solus/server/transport/lan-discovery')
const { assertRpcAccess, RpcAccessError } = await import('@solus/server/admission/access-policy')
const { buildHttpServer } = await import('@solus/server/transport/http')
const { createDoors } = await import('@solus/server/admission/doors')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const auth = await import('@solus/server/admission/auth')
const { projectsVisibleTo } = await import('@solus/server/transport/handlers/setup-handlers')
const { projectsRootFor } = await import('@solus/server/workspace')
const { setupProjectsRoot } = await import('@solus/server/workspace')

// plans/034-one-cloud-machine-kind.md §2, §3, docs/plans/managed-hosts.md §1: on a cloud
// machine nothing is trusted by network position, pairing does not exist, the link is
// system-owned, and the link code in the environment never reaches a child process. A
// machine is a cloud machine because its registration names the organization it
// works for; no switch says so.
describe('cloud machine', () => {
  const originalEnv = { ...process.env }
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-managed-mode-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
    machine.resetMachineKindForTests()
    machine.adoptRegistration({ organizationId: 'org_1' })
    bootLinkCode.resetBootLinkCodeForTests()
    auth.resetAuthStateForTests()
  })

  afterEach(() => {
    auth.resetAuthStateForTests()
    for (const key of ['SOLUS_LINK_CODE', 'SOLUS_MACHINE_ADDRESS', 'SOLUS_PROJECTS_ROOT']) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    machine.resetMachineKindForTests()
    bootLinkCode.resetBootLinkCodeForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('the link code and the machine address are read once, and both leave process.env on that first read', () => {
    // WHY: agent processes inherit process.env; the one-use ticket must not reach them (§3).
    process.env.SOLUS_LINK_CODE = '  org_ticket@app.example.test '
    process.env.SOLUS_MACHINE_ADDRESS = ' https://vm.example.test '
    expect(bootLinkCode.readBootLinkCode()).toEqual({ code: 'org_ticket@app.example.test', address: 'https://vm.example.test' })
    expect(process.env.SOLUS_LINK_CODE).toBeUndefined()
    expect(process.env.SOLUS_MACHINE_ADDRESS).toBeUndefined()
    // The second read answers from memory, not from the (now empty) environment.
    expect(bootLinkCode.readBootLinkCode()).toEqual({ code: 'org_ticket@app.example.test', address: 'https://vm.example.test' })
  })

  test('a code with no address is a machine whose address the control plane has, or that gets a tunnel', () => {
    process.env.SOLUS_LINK_CODE = 'org_ticket@app.example.test'
    process.env.SOLUS_MACHINE_ADDRESS = '   '
    expect(bootLinkCode.readBootLinkCode()).toEqual({ code: 'org_ticket@app.example.test', address: null })
    expect(process.env.SOLUS_MACHINE_ADDRESS).toBeUndefined()
  })

  test('a machine that a person sets up has no code: an address alone enrolls nothing, and still leaves the environment', () => {
    delete process.env.SOLUS_LINK_CODE
    process.env.SOLUS_MACHINE_ADDRESS = 'https://vm.example.test'
    expect(bootLinkCode.readBootLinkCode()).toBeNull()
    expect(process.env.SOLUS_MACHINE_ADDRESS).toBeUndefined()
    // A code that appears later in the environment is not read: the boot decided once.
    process.env.SOLUS_LINK_CODE = 'org_late@app.example.test'
    expect(bootLinkCode.readBootLinkCode()).toBeNull()
  })

  test('nobody is a trusted requester: not loopback, not the LAN, whatever the setting says', async () => {
    expect(await isTrustedRequesterAddress('127.0.0.1')).toBe(false)
    expect(await isTrustedRequesterAddress('::1')).toBe(false)
    expect(await isTrustedRequesterAddress('192.168.1.42')).toBe(false)
    // The kind is asked on each request: the same loopback address is the owner's on a personal machine.
    machine.resetMachineKindForTests()
    expect(await isTrustedRequesterAddress('127.0.0.1')).toBe(true)
    machine.adoptRegistration({ organizationId: 'org_1' })
    expect(await isTrustedRequesterAddress('127.0.0.1')).toBe(false)
  })

  test('LAN discovery is off: the managed boot says so, as the workspace service does', () => {
    expect(isLanDiscoveryDisabled({ SOLUS_NO_LAN_DISCOVERY: '1' })).toBe(true)
    expect(isLanDiscoveryDisabled({ SOLUS_API: '1' })).toBe(true)
    expect(isLanDiscoveryDisabled({})).toBe(false)
  })

  test('the registration, link, and pairing RPCs are refused with MANAGED_HOST, even for a local owner', async () => {
    const owner = { kind: 'owner' as const, via: 'local' as const, expiresAt: null, deviceId: null, deviceLabel: 'Mac' }
    // `uplinkRegister` too: a cloud machine is registered once, and no later code changes whose machine it is.
    for (const method of ['uplinkRegister', 'uplinkLink', 'uplinkUnlink', 'connectionsGeneratePairToken', 'connectionsSetTrustLocalNetwork', 'connectionsSetRemoteAccess'] as const) {
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
      pairingDisabled: () => true,
    })
    try {
      const health = await (await fetch(`${baseUrl}/health`)).json() as { requireAuth: boolean }
      expect(health.requireAuth).toBe(true)
      expect((await fetch(`${baseUrl}/pair`, { method: 'POST', body: '{}' })).status).toBe(404)
      expect((await fetch(`${baseUrl}/pair/open`, { method: 'POST' })).status).toBe(404)
    } finally {
      await close(server)
    }
  })

  test('the pairing door closes when a running server becomes a cloud machine', async () => {
    // WHY (plans/034 §3): a standalone server registers with an organization code while
    // it runs. From then on a pairing code opens nothing, and a device that paired
    // before is no credential: the door is asked on each request, not once at boot.
    machine.resetMachineKindForTests()
    const pairingDisabled = () => machine.machineKind() === 'cloud'
    const { server, baseUrl } = await listen({ requireAuth: () => true, isTrustedRequester: isTrustedRequesterAddress, isTunnelRequest: () => false, pairingDisabled })
    const doors = createDoors({ place: 'host', pairingDisabled })
    const pair = (pairToken: string) => fetch(`${baseUrl}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairToken, deviceLabel: 'Phone' }) })
    try {
      const paired = await pair(auth.generatePairToken().token)
      expect(paired.status).toBe(200)
      const { sessionToken } = await paired.json() as { sessionToken: string }
      expect(await doors.admitBearer(sessionToken, undefined)).toMatchObject({ ok: true, principal: { kind: 'owner', via: 'local' } })
      expect(await doors.admitCredential({ kind: 'session-token', token: sessionToken })).toMatchObject({ ok: true })

      machine.adoptRegistration({ organizationId: 'org_1' })

      expect((await pair(auth.generatePairToken().token)).status).toBe(404)
      expect((await fetch(`${baseUrl}/pair/open`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${baseUrl}/pair/serve`, { method: 'POST', body: '{}' })).status).toBe(404)
      expect(await doors.admitBearer(sessionToken, undefined)).toEqual({ ok: false, reason: 'not-accepted' })
      expect(await doors.admitCredential({ kind: 'session-token', token: sessionToken })).toEqual({ ok: false, reason: 'not-accepted' })
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
      const dialed = await dialHostSocket(url, { clientInstanceId: 'test0123456789abcdef' })
      if (dialed.ok) dialed.socket.close()
      expect(dialed.ok ? 'connected' : dialed.code).toBe('UNAUTHORIZED')
    } finally {
      transport.close()
      http.close()
    }
  })

  test('a member gets a workspace of their own beneath the host root; the owner and the host use the root (§3)', () => {
    // WHY: on a shared host every member clones into a directory that is theirs, not
    // into one pile; the owner's pickers still open where they always did.
    const member = { kind: 'org-member' as const, userId: 'user_abc123', organizationId: 'org', organizationRole: 'member' as const, teamIds: [], hostKind: 'cloud' as const, displayName: 'Bob', deviceId: 'd', expiresAt: 0, deviceLabel: 'Solus cloud' }
    const workspace = projectsRootFor(member, join(dataDir, 'projects'))
    expect(workspace).toBe(join(dataDir, 'projects', 'user_abc123'))
    expect(existsSync(workspace)).toBe(true)
    expect(projectsRootFor({ kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' }, join(dataDir, 'projects'))).toBe(join(dataDir, 'projects'))
    expect(projectsRootFor(undefined, join(dataDir, 'projects'))).toBe(join(dataDir, 'projects'))
    expect(() => projectsRootFor({ ...member, userId: '../escape' }, join(dataDir, 'projects'))).toThrow()
  })

  test('a member\'s project listings show their workspace only; the owner sees every checkout (§3)', () => {
    // WHY: two people on one host must never be handed the same main checkout. A
    // project listed for a member is one that is theirs to open; the owner's own
    // clone and another member's are not.
    const root = join(dataDir, 'projects')
    const member = { kind: 'org-member' as const, userId: 'user_abc123', organizationId: 'org', organizationRole: 'member' as const, teamIds: [], hostKind: 'cloud' as const, displayName: 'Bob', deviceId: 'd', expiresAt: 0, deviceLabel: 'Solus cloud' }
    const projects = [
      { path: join(root, 'solus') },
      { path: join(root, 'user_abc123', 'solus') },
      { path: join(root, 'user_abc123') },
      { path: join(root, 'user_other', 'solus') },
      { path: join(root, 'user_abc123-not', 'solus') },
    ]
    expect(projectsVisibleTo(member, projects, root).map((project) => project.path)).toEqual([join(root, 'user_abc123', 'solus'), join(root, 'user_abc123')])
    expect(projectsVisibleTo({ kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' }, projects, root)).toHaveLength(5)
    expect(projectsVisibleTo(undefined, projects, root)).toHaveLength(5)
  })

  // POSIX paths: a cloud machine is a Linux machine.
  test.skipIf(process.platform === 'win32')('the projects root follows SOLUS_PROJECTS_ROOT until an administrator sets one (§3)', () => {
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
