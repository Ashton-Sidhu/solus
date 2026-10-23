import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { CLIENT_SOLUS_API_SCOPES, solusApiScopeSchema } from '@solus/contracts/solus-api'
import { SOLUS_API_ORGANIZATION_HEADER } from '@solus/contracts/solus-api/request'
import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'
import { fakeAccessTokens } from './helpers/socket-handshake'

// bun has no node:sqlite; the http module's import chain reaches the db even though
// these tests never open it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { buildHttpServer } = await import('@solus/server/transport/http')
const { createDoors } = await import('@solus/server/admission/doors')
const { workspaceAdmissionFor } = await import('@solus/server/transport/solus-api/admission')
const auth = await import('@solus/server/admission/auth')
const { ActingIdentities, useActingIdentities } = await import('@solus/server/execution/seats/acting-identity')

// docs/plans/simplify-auth-and-sync.md §3 rule 1, §4.2: a client holds one token for our
// servers, `aud: [account, api]`. The Solus API admits it on HTTP directly, in the
// organization the request names: there is no second bearer to exchange it for.

const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let server: Server | null = null
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-api-auth-'))
  process.env.SOLUS_DATA_DIR = dataDir
  auth.resetAuthStateForTests()
  // As the Solus API installs them: requests read as their person, and start no process.
  useActingIdentities(new ActingIdentities({
    memberToken: async () => null,
    fetchLogin: async () => { throw new Error('no GitHub login here') },
    memberHome: () => { throw new Error('no member process here') },
    gitHelper: () => null,
    now: Date.now,
  }))
})
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
  useActingIdentities(null)
  auth.resetAuthStateForTests()
  rmSync(dataDir, { recursive: true, force: true })
  if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = originalDataDir
})

const member = { sub: 'bob', grant_id: 'grant_bob', access: 'org-member' as const, hostKind: 'cloud' as const, organizations: [{ id: 'org_a', role: 'member' as const, teamIds: [] }, { id: 'org_b', role: 'owner' as const, teamIds: [] }] }
const delegated = { sub: 'bob', grant_id: 'grant_bob', act: { sub: 'host_h1', host_id: 'h1' }, access: 'org-member' as const, hostKind: 'cloud' as const, organizationId: 'org_a', organizationRole: 'member' as const, teamIds: [] }

/** The Solus API's HTTP listener; `/v1/capabilities` reads no records, only the caller's admission. */
async function api() {
  const tokens = fakeAccessTokens()
  // SAFETY: the route under test reads no operation.
  const operations = {} as WorkspaceOperations
  const built = buildHttpServer({ isApiMode: true, pairingDisabled: true, verifyAccessToken: tokens.verify, solusApi: { operations, serviceId: 'api' } })
  server = built.server
  await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve))
  const address = built.server.address()
  if (!address || typeof address === 'string') throw new Error('expected a TCP address')
  const call = async (bearer: string, organizationId?: string) => (await fetch(`http://127.0.0.1:${address.port}/v1/capabilities`, {
    headers: { authorization: `Bearer ${bearer}`, ...(organizationId ? { [SOLUS_API_ORGANIZATION_HEADER]: organizationId } : {}) },
  })).status
  return { tokens, call }
}

describe('the Solus API over HTTP', () => {
  test("a person's API token admits them with no second credential, in an organization it lists", async () => {
    const { tokens, call } = await api()
    const token = tokens.mint({ ...member, aud: ['urn:solus:account', 'urn:solus:api'] })
    expect(await call(token, 'org_a')).toBe(200)
    expect(await call(token, 'org_b')).toBe(200)
    // The token lists the organizations; it admits nowhere else, and nowhere unnamed.
    expect(await call(token, 'org_c')).toBe(401)
    expect(await call(token)).toBe(401)
    expect(await call('forged.token.value', 'org_a')).toBe(401)
  })

  test("a host's delegated token admits its person in the organization it names", async () => {
    const { tokens, call } = await api()
    const token = tokens.mint(delegated)
    expect(await call(token)).toBe(200)
    expect(await call(token, 'org_b')).toBe(401)
  })

  test("an owner's token, a pairing session token, and a revoked client grant are refused", async () => {
    const { tokens, call } = await api()
    expect(await call(tokens.mint({ sub: 'alice', grant_id: 'grant_alice', access: 'owner' }))).toBe(401)
    expect(await call(auth.issueSessionToken('Phone').token)).toBe(401)
    const token = tokens.mint(member)
    auth.revokeDevice('grant_bob')
    expect(await call(token, 'org_a')).toBe(401)
  })
})

describe('the authority of an admitted request', () => {
  test("a person's request has a client's scopes; a host's agent acting for them has the agent's, and its writes are the agent's", async () => {
    const tokens = fakeAccessTokens()
    const admission = workspaceAdmissionFor({ isApiMode: true, solusApi: { operations: {} as WorkspaceOperations, serviceId: 'api' } }, createDoors({ place: 'api', pairingDisabled: true, verifyAccessToken: tokens.verify }))
    const person = await admission.bearer(tokens.mint(member), 'org_a')
    expect(person).toMatchObject({ home: { kind: 'organization', serviceId: 'api', organizationId: 'org_a' }, scopes: CLIENT_SOLUS_API_SCOPES })
    expect(person?.delegation).toBeUndefined()
    const agent = await admission.bearer(tokens.mint(delegated), undefined)
    expect(agent).toMatchObject({ home: { kind: 'organization', organizationId: 'org_a' }, scopes: solusApiScopeSchema.options, delegation: { hostId: 'h1' }, actingAgent: { organizationId: 'org_a' } })
  })

  test('on a host, a paired device reads the local records; another host acting for a person reads none', async () => {
    const tokens = fakeAccessTokens()
    const admission = workspaceAdmissionFor({ solusApi: { operations: {} as WorkspaceOperations, serviceId: 'host-a' } }, createDoors({ place: 'host', verifyAccessToken: tokens.verify }))
    expect(await admission.bearer(auth.issueSessionToken('Phone').token, undefined)).toMatchObject({ home: { kind: 'local', hostId: 'host-a' }, principal: { kind: 'owner', via: 'local' } })
    expect(await admission.bearer(tokens.mint({ ...delegated, access: 'owner', organizationId: undefined, organizationRole: undefined, teamIds: undefined }), undefined)).toBeNull()
  })
})
