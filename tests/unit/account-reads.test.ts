import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SOLUS_API_AUDIENCE, SOLUS_API_CLIENT_ID, TOKEN_EXCHANGE_GRANT_TYPE, tokenEndpoint } from '@solus/contracts/uplink'
import { clientCredential, generateHostKey } from '@solus/server/host/host-credential'
import { DelegationError, Delegations, establishWith, type DelegationScope } from '@solus/server/sync/delegations'
import { AccountReads } from '@solus/server/vault/account-reads'

// docs/adr/0001-standard-authentication.md §2.2 rule 7, §3.4: every read of a person's
// account goes with that person's delegated token for the account plane as
// `Authorization: Bearer`, and nothing else. A host and the Solus API (§6.2) read the
// same way, through the same `Delegations`.

const ORIGIN = 'https://account.test'

interface Sent { url: string; method: string; authorization: string | null; body: string | null }

function reads(options: { held?: Array<{ userId: string; scope: DelegationScope }>; token?: (userId: string, scope: DelegationScope) => Promise<string>; origin?: string | null; answer?: () => Response } = {}) {
  const sent: Sent[] = []
  const asked: Array<[string, DelegationScope]> = []
  const accountReads = new AccountReads({
    origin: () => options.origin === undefined ? ORIGIN : options.origin,
    delegations: () => ({
      holders: () => options.held ?? [],
      accessToken: async (userId, scope, resource) => {
        expect(resource).toEqual({ kind: 'account' })
        asked.push([userId, scope])
        return options.token ? options.token(userId, scope) : `delegated-${userId}`
      },
    }),
    fetchImpl: async (url, init) => {
      sent.push({ url: String(url), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization'), body: init?.body ? String(init.body) : null })
      return options.answer?.() ?? Response.json({ ok: true })
    },
  })
  return { accountReads, sent, asked }
}

describe('reading a person’s account', () => {
  test('the delegated token is the bearer and the body is only what the route reads', async () => {
    const { accountReads, sent } = reads({ held: [{ userId: 'bob', scope: { organizationId: 'org_a' } }] })
    const response = await accountReads.fetch('bob', null, '/v1/agent-profile/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverUrl: 'https://mcp.test' }) })
    expect(response).toBeInstanceOf(Response)
    expect(sent).toEqual([{ url: `${ORIGIN}/v1/agent-profile/credential`, method: 'POST', authorization: 'Bearer delegated-bob', body: '{"serverUrl":"https://mcp.test"}' }])
  })

  test('with no scope named, the person’s personal delegation is used first, else one of an organization; a named scope is used as named', async () => {
    const { accountReads, asked } = reads({ held: [{ userId: 'alice', scope: { organizationId: 'org_a' } }, { userId: 'alice', scope: 'personal' }, { userId: 'bob', scope: { organizationId: 'org_b' } }] })
    await accountReads.fetch('alice', null, '/v1/integrations/github/credential', { method: 'POST' })
    await accountReads.fetch('bob', null, '/v1/integrations/github/credential', { method: 'POST' })
    await accountReads.fetch('alice', { organizationId: 'org_a' }, '/v1/agent-profile/read', { method: 'POST' })
    expect(asked).toEqual([['alice', 'personal'], ['bob', { organizationId: 'org_b' }], ['alice', { organizationId: 'org_a' }]])
  })

  test('nothing is sent for a person this host does not act for, on an unlinked host, or when the delegation is refused; each says why', async () => {
    const none = reads()
    expect(await none.accountReads.fetch('carol', null, '/v1/integrations/github/credential')).toMatchObject({ refused: 'NO_DELEGATION', message: expect.stringContaining('Reconnect') })
    expect(none.sent).toEqual([])

    const unlinked = reads({ origin: null, held: [{ userId: 'carol', scope: 'personal' }] })
    expect(await unlinked.accountReads.fetch('carol', null, '/v1/integrations/github/credential')).toMatchObject({ refused: 'NOT_LINKED' })
    expect(unlinked.sent).toEqual([])

    const signedOut = reads({ held: [{ userId: 'carol', scope: 'personal' }], token: async () => { throw new DelegationError('GRANT_REVOKED', 'The sign-in that let this machine act for you has ended. Sign in to Solus again.') } })
    expect(await signedOut.accountReads.fetch('carol', null, '/v1/integrations/github/credential')).toMatchObject({ refused: 'NO_DELEGATION', message: expect.stringContaining('Sign in') })
    expect(signedOut.sent).toEqual([])

    const outage = reads({ held: [{ userId: 'carol', scope: 'personal' }], token: async () => { throw new DelegationError('ORGANIZATION_API_UNAVAILABLE', 'Solus is not reachable.') } })
    expect(await outage.accountReads.fetch('carol', null, '/v1/integrations/github/credential')).toMatchObject({ refused: 'UNREACHABLE' })
  })

  test('the connections page is on the account plane this process reads', () => {
    expect(reads().accountReads.connectionsUrl()).toBe(`${ORIGIN}/connections`)
    expect(reads({ origin: null }).accountReads.connectionsUrl()).toBeNull()
  })
})

describe('the Solus API reads a person’s account as a host does', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-account-reads-'))
    process.env.SOLUS_DATA_DIR = dataDir
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('the API token a member presented is exchanged once, for the organization the request named, with the service credential; then the account read carries the delegated token', async () => {
    // WHY: ADR 0001 §6.2 — no service key: the Solus API takes the one path every caller of the account plane takes.
    const key = await generateHostKey()
    const credential = clientCredential({ clientId: SOLUS_API_CLIENT_ID, privateJwk: key.privateJwk, tokenEndpoint: tokenEndpoint(ORIGIN) })
    const forms: URLSearchParams[] = []
    const reads: Sent[] = []
    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      if (String(url) === tokenEndpoint(ORIGIN)) {
        forms.push(init?.body as URLSearchParams)
        return Response.json({ access_token: 'bob-account-delegated', refresh_token: 'refresh-1', expires_in: 300 })
      }
      reads.push({ url: String(url), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization'), body: null })
      return Response.json({ accessToken: 'gh', scope: 'repo' })
    }
    const delegations = new Delegations({ link: () => null, credential: () => credential, onRevoked: () => {}, fetchImpl })
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const apiToken = `${part({ alg: 'ES256' })}.${part({ sub: 'bob', grant_id: 'grant_bob', aud: SOLUS_API_AUDIENCE })}.c2ln`

    // The admission makes a delegation only for the organization the request names, never a personal one.
    const establish = establishWith(delegations, true)
    await establish(apiToken, 'personal')
    await establish(apiToken, { organizationId: 'org_a' })
    expect(forms).toHaveLength(1)
    expect(forms[0]!.get('grant_type')).toBe(TOKEN_EXCHANGE_GRANT_TYPE)
    expect(forms[0]!.get('subject_token')).toBe(apiToken)
    expect(forms[0]!.get('organization_id')).toBe('org_a')
    expect(forms[0]!.get('client_id')).toBe(SOLUS_API_CLIENT_ID)
    expect(delegations.holders()).toEqual([{ userId: 'bob', scope: { organizationId: 'org_a' } }])

    const accountReads = new AccountReads({ origin: () => ORIGIN, delegations: () => delegations, fetchImpl })
    expect(await accountReads.fetch('bob', null, '/v1/integrations/github/credential', { method: 'POST' })).toBeInstanceOf(Response)
    expect(reads).toEqual([{ url: `${ORIGIN}/v1/integrations/github/credential`, method: 'POST', authorization: 'Bearer bob-account-delegated', body: null }])
    expect(await delegations.accessToken('bob', { organizationId: 'org_a' }, { kind: 'account' })).toBe('bob-account-delegated')
    delegations.clear()
  })

  test('a host makes its owner’s personal delegation at the door', async () => {
    const asked: DelegationScope[] = []
    const establish = establishWith({ establish: async (_token, scope) => { asked.push(scope) } }, false)
    await establish('token', 'personal')
    expect(asked).toEqual(['personal'])
  })
})
