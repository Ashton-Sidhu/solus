import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { INTERNAL_HANDLER_CTX, SolusServer, type HandlerCtx } from '@solus/server/transport/server'
import { CREDENTIAL_FREE_PRINCIPAL, type Principal } from '@solus/server/admission/principal'
import { pairedPrincipalFor, principalForClaims } from '@solus/server/admission/doors'
import { RpcAccessError } from '@solus/server/admission/access-policy'
import { permissionOf } from '@solus/contracts/permissions'
import { issueSessionToken, resetAuthStateForTests } from '@solus/server/admission/auth'

// docs/plans/personal-uplink.md P1/P2: every call names who is calling, and the
// handful of methods that change how the host is reached take a local owner only.
// A grant proves the owner's identity, not their presence at the machine.

describe('principals at admission', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-principal-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
    resetAuthStateForTests()
  })

  afterEach(() => {
    resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('a pairing session token admits a local owner carrying its device', () => {
    const { token, deviceId } = issueSessionToken('Phone')
    expect(pairedPrincipalFor(token)).toEqual({ ok: true, principal: { kind: 'owner', via: 'local', expiresAt: null, deviceId, deviceLabel: 'Phone' } })
  })

  test("an owner's access token admits the owner by grant, with the grant it came from", () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const admission = principalForClaims({ iss: 'i', aud: 'urn:solus:host:h', sub: 'user_1', grant_id: 'session_1', jti: 'j', iat: exp - 60, exp, access: 'owner' }, undefined, 'host')
    expect(admission).toEqual({ ok: true, principal: { kind: 'owner', via: 'grant', userId: 'user_1', deviceId: 'session_1', expiresAt: exp * 1000, deviceLabel: 'Solus cloud' } })
  })

  test('a credential-free admission is the local owner without a device', () => {
    expect(CREDENTIAL_FREE_PRINCIPAL).toEqual({ kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Web' })
  })
})

describe('the local-only guard', () => {
  const localOwner: HandlerCtx = { clientId: 'ws:local:1', principal: { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Web' } }
  const remoteOwner: HandlerCtx = {
    clientId: 'ws:session_1:1',
    principal: { kind: 'owner', via: 'grant', userId: 'u', deviceId: 'session_1', expiresAt: 0, deviceLabel: 'Solus cloud' },
  }

  function serverWith(): SolusServer {
    const server = new SolusServer()
    server.register('uplinkUnlink', () => ({ linked: false }))
    server.register('uplinkStatus', () => ({ linked: false }))
    server.register('listAttention', () => [])
    return server
  }

  test('a call without a principal is refused before any handler runs', async () => {
    const server = serverWith()
    // SAFETY: the test deliberately violates the contract to prove the guard fails closed.
    const noCtx = undefined as unknown as HandlerCtx
    await expect(server.handle('listAttention', [], noCtx)).rejects.toThrow(/without a principal/)
  })

  test('a remote owner cannot change how the host is reached; a local owner can', async () => {
    const server = serverWith()
    await expect(server.handle('uplinkUnlink', [], remoteOwner)).rejects.toBeInstanceOf(RpcAccessError)
    await expect(server.handle('uplinkUnlink', [], localOwner)).resolves.toEqual({ linked: false })
    // Reading the link is not changing it: any owner may see whether the host is linked.
    await expect(server.handle('uplinkStatus', [], remoteOwner)).resolves.toEqual({ linked: false })
  })

  test('the refusal is typed so transports can name it', async () => {
    const server = serverWith()
    const error = await server.handle('uplinkUnlink', [], remoteOwner).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(RpcAccessError)
    if (error instanceof RpcAccessError) expect(error.code).toBe('FORBIDDEN')
  })

  test('everything else stays open to the remote owner and the host itself', async () => {
    const server = serverWith()
    await expect(server.handle('listAttention', [], remoteOwner)).resolves.toEqual([])
    await expect(server.handle('listAttention', [], INTERNAL_HANDLER_CTX)).resolves.toEqual([])
  })

  test('the set names exactly the surface that changes reachability or drives the window', () => {
    const expected: Array<Parameters<SolusServer['hasHandler']>[0]> = [
      'connectionsSetRemoteAccess', 'connectionsSetTrustLocalNetwork', 'connectionsGeneratePairToken',
      'hostsAddOverSsh', 'hostsListForwarded', 'hostsRemoveForwarded', 'hostsLinkForwarded', 'uplinkLink', 'uplinkUnlink',
      'isVisible', 'getAppGlobalShortcuts', 'setAppGlobalShortcuts', 'restartApp',
    ]
    for (const method of expected) expect(permissionOf(method as never)?.startsWith('host.local')).toBe(true)
    expect(permissionOf('prompt')).toBeNull()
    expect(permissionOf('connectionsGetServerInfo')).toBe('host.connect')
  })

  test('the system principal is never a local owner', () => {
    const system: Principal = INTERNAL_HANDLER_CTX.principal
    expect(system.kind).toBe('system')
  })
})
