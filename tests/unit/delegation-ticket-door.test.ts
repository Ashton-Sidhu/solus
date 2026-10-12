import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { hostAudience, type AccessTokenClaims } from '@solus/contracts/uplink'
import type { TokenVerdict } from '@solus/server/admission/access-tokens'
import type { DelegationScope } from '@solus/server/sync/delegations'

// bun has no node:sqlite; the http module's import chain reaches the db even though
// these tests never open it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { buildHttpServer } = await import('@solus/server/transport/http')
const auth = await import('@solus/server/admission/auth')

// docs/adr/0001-standard-authentication.md §2.2 rule 6, §3.4: a host acts for a person
// only through a delegation made from a token their client presented. The ticket door
// is where a signed-in client presents one: the owner's connection makes the personal
// delegation, and a connection that works in an organization makes that one.

const HOST = 'abcdefghijklmnop'
const now = Math.floor(Date.now() / 1000)
const base = { iss: 'https://app.example.test', aud: hostAudience(HOST), jti: 'j', iat: now, exp: now + 300, client_id: 'solus-desktop' }
const TOKENS: Record<string, AccessTokenClaims> = {
  owner: { ...base, sub: 'alice', grant_id: 'grant_alice', access: 'owner' },
  member: { ...base, sub: 'bob', grant_id: 'grant_bob', access: 'org-member', organizations: [{ id: 'org_a', role: 'member', teamIds: [] }] },
  delegated: { ...base, aud: ['urn:solus:api', 'urn:solus:account'], sub: 'bob', grant_id: 'grant_bob', act: { sub: 'host_h2', host_id: 'h2' }, access: 'org-member', organizationId: 'org_a', organizationRole: 'member', teamIds: [] },
}

describe('the ticket door makes the delegations of a signed-in connection', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string
  let server: Server | null = null

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-delegation-door-'))
    process.env.SOLUS_DATA_DIR = dataDir
    auth.resetAuthStateForTests()
  })

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    auth.resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  async function door() {
    const established: Array<[string, DelegationScope]> = []
    const built = buildHttpServer({
      host: '127.0.0.1',
      port: 0,
      verifyAccessToken: async (token): Promise<TokenVerdict> => {
        const claims = TOKENS[token]
        return claims ? { ok: true, claims } : { ok: false, reason: 'malformed' }
      },
      establishDelegation: async (token, scope) => { established.push([token, scope]) },
    })
    server = built.server
    await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve))
    const address = built.server.address()
    if (!address || typeof address === 'string') throw new Error('expected a TCP address')
    const ticket = (token: string, organizationId?: string) => fetch(`http://127.0.0.1:${address.port}/auth/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(organizationId ? { organizationId } : {}),
    })
    return { established, ticket }
  }

  test("the owner's connection makes their personal delegation, and the organization's it works in", async () => {
    const { established, ticket } = await door()
    expect((await ticket('owner')).status).toBe(200)
    expect((await ticket('owner', 'org_a')).status).toBe(200)
    expect(established).toEqual([['owner', 'personal'], ['owner', 'personal'], ['owner', { organizationId: 'org_a' }]])
  })

  test("a member's connection makes the delegation of the organization it named; a refused one makes none", async () => {
    const { established, ticket } = await door()
    expect((await ticket('member', 'org_a')).status).toBe(200)
    expect((await ticket('member', 'org_b')).status).toBe(401)
    expect(established).toEqual([['member', { organizationId: 'org_a' }]])
  })

  test("a host's delegated token makes no delegation", async () => {
    const { established, ticket } = await door()
    await ticket('delegated', 'org_a')
    expect(established).toEqual([])
  })
})
