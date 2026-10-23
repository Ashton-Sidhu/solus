import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { SOLUS_API_AUDIENCE, type AccessTokenClaims } from '@solus/contracts/uplink'
import type { TokenVerdict } from '@solus/server/admission/access-tokens'
import type { Principal } from '@solus/server/admission/principal'
import type { ResolvedLinkShare } from '@solus/server/sharing/share-manager'

// bun has no node:sqlite; the http module's import chain reaches the db even though
// these tests never open it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { buildHttpServer } = await import('@solus/server/transport/http')
const { ShareLinkResolver } = await import('@solus/server/sharing/share-link-resolver')
const auth = await import('@solus/server/admission/auth')

// docs/plans/instant-share-open.md: the resolve door reads the page's own access token
// and answers whom the link opens the resource as, in the same request. The token is
// the page's word for who the visitor is; only one that lists the resource's
// organization makes a member, so no page can name itself into another organization.

const SECRET = 's'.repeat(32)
const LINK: ResolvedLinkShare = { organizationId: 'org_a', resource: { kind: 'session', id: 'sess1' }, role: 'viewer', sharedByUserId: 'alice', linkSecretHash: 'h' }
const now = Math.floor(Date.now() / 1000)
const base = { iss: 'https://app.example.test', aud: SOLUS_API_AUDIENCE, jti: 'j', iat: now, exp: now + 300, client_id: 'solus-web' }
const TOKENS: { [token: string]: AccessTokenClaims } = {
  member: { ...base, sub: 'bob', grant_id: 'grant_bob', access: 'org-member', organizations: [{ id: 'org_a', role: 'member', teamIds: ['team_web'] }] },
  elsewhere: { ...base, sub: 'carol', grant_id: 'grant_carol', access: 'org-member', organizations: [{ id: 'org_b', role: 'owner', teamIds: [] }] },
  delegated: { ...base, sub: 'bob', grant_id: 'grant_bob', act: { sub: 'host_h2', host_id: 'h2' }, access: 'org-member', organizationId: 'org_a', organizationRole: 'member', teamIds: [] },
}

describe('the share link door', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string
  let server: Server | null = null

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-share-link-door-'))
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
    const askedFor: Principal[] = []
    const built = buildHttpServer({
      host: '127.0.0.1',
      port: 0,
      isApiMode: true,
      pairingDisabled: true,
      verifyAccessToken: async (token): Promise<TokenVerdict> => {
        const claims = TOKENS[token]
        return claims ? { ok: true, claims } : { ok: false, reason: 'malformed' }
      },
      shareLinks: new ShareLinkResolver({
        shares: {
          openLink: async (secret) => (secret === SECRET
            ? {
                share: LINK,
                runnerHostId: 'host_a',
                roleOf: (principal) => {
                  askedFor.push(principal)
                  return 'editor'
                },
              }
            : null),
        },
      }),
    })
    server = built.server
    await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve))
    const address = built.server.address()
    if (!address || typeof address === 'string') throw new Error('expected a TCP address')
    const resolve = async (secret: string, token?: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/auth/share-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ shareSecret: secret }),
      })
      return { status: response.status, body: await response.json() }
    }
    return { askedFor, resolve }
  }

  test("a member's token opens the link as that member, with their role, in one request", async () => {
    const { askedFor, resolve } = await door()
    const answer = await resolve(SECRET, 'member')
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ opensAs: { kind: 'member', role: 'editor' }, organizationId: 'org_a', host: { hostId: 'host_a' } })
    // The role is asked as the member of the resource's organization, with their teams.
    expect(askedFor).toMatchObject([{ kind: 'org-member', userId: 'bob', organizationId: 'org_a', teamIds: ['team_web'] }])
  })

  test('no token, a token of another organization, or a host acting for a person opens it as a guest', async () => {
    const { askedFor, resolve } = await door()
    for (const token of [undefined, 'elsewhere', 'delegated', 'garbage']) {
      expect((await resolve(SECRET, token)).body.opensAs).toEqual({ kind: 'guest', role: 'viewer' })
    }
    expect(askedFor).toEqual([])
  })

  test('an unknown secret is a named 404, whoever asks', async () => {
    const { resolve } = await door()
    expect(await resolve('x'.repeat(32), 'member')).toEqual({ status: 404, body: { error: { code: 'SHARE_LINK_UNKNOWN' } } })
  })
})
