import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { INTERNAL_HANDLER_CTX, SolusServer, type HandlerCtx } from '@solus/server/server/server'
import { principalFor, type Principal } from '@solus/server/server/principal'
import { LOCAL_ONLY_RPC_METHODS, RpcAccessError } from '@solus/server/server/access-policy'
import { issueGrantWsTicket, issueSessionToken, issueWsTicket, resetAuthStateForTests, verifyWsTicket } from '@solus/server/server/auth'

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

  test('a pairing ticket admits a local owner carrying its device', () => {
    const { token, deviceId } = issueSessionToken('Phone')
    const ticket = verifyWsTicket(issueWsTicket(token)!)!
    const principal = principalFor({ kind: 'ticket', ticket })
    expect(principal).toEqual({ kind: 'local-owner', deviceId, deviceLabel: 'Phone' })
  })

  test('a grant ticket admits the remote owner with the grant it came from', () => {
    const expiresAt = Date.now() + 60_000
    const ticket = verifyWsTicket(issueGrantWsTicket({ userId: 'user_1', deviceId: 'session_1', expiresAt }))!
    const principal = principalFor({ kind: 'ticket', ticket })
    expect(principal.kind).toBe('remote-owner')
    if (principal.kind === 'remote-owner') {
      expect(principal.userId).toBe('user_1')
      expect(principal.deviceId).toBe('session_1')
      expect(principal.expiresAt).toBe(expiresAt)
    }
  })

  test('a credential-free admission is the local owner without a device', () => {
    expect(principalFor({ kind: 'credential-free' })).toEqual({ kind: 'local-owner', deviceId: null, deviceLabel: 'Web' })
  })
})

describe('the local-only guard', () => {
  const localOwner: HandlerCtx = { clientId: 'ws:local:1', principal: { kind: 'local-owner', deviceId: null, deviceLabel: 'Web' } }
  const remoteOwner: HandlerCtx = {
    clientId: 'ws:session_1:1',
    principal: { kind: 'remote-owner', userId: 'u', deviceId: 'session_1', expiresAt: 0, deviceLabel: 'Solus cloud' },
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
      'connectionsBootstrapDiscoveredServer', 'uplinkLink', 'uplinkUnlink',
      'isVisible', 'switchMode', 'getAppGlobalShortcuts', 'setAppGlobalShortcuts', 'restartApp',
    ]
    for (const method of expected) expect(LOCAL_ONLY_RPC_METHODS.has(method as never)).toBe(true)
    expect(LOCAL_ONLY_RPC_METHODS.has('prompt')).toBe(false)
    expect(LOCAL_ONLY_RPC_METHODS.has('connectionsGetServerInfo')).toBe(false)
  })

  test('the system principal is never a local owner', () => {
    const system: Principal = INTERNAL_HANDLER_CTX.principal
    expect(system.kind).toBe('system')
  })
})
