import { describe, expect, test } from 'bun:test'
import { configureCloudAccount, oauthCloudAccount, startupAccountRead, type CloudAccountSession } from '@solus/client-core/cloud-account'
import type { TokenResource } from '@solus/contracts/auth/clients'

// The web client at a Solus Cloud origin reads and ends onboarding for the account,
// creates the cloud host, and shares a linked machine (docs/plans/cloud-onboarding.md §7).

function recordingFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string; body: string | null }> = []
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : null })
    return respond(url, init)
  }) as typeof fetch
  return { calls, fetchImpl }
}

const ORIGIN = 'https://app.solus.sh'

/** The page's sign-in, reduced to what the account uses; records what it was asked. */
function fakeSession(token: string | null = 'account-token') {
  const asked: TokenResource[] = []
  let signedOut = false
  const session: CloudAccountSession = {
    accessToken: async (resource) => { asked.push(resource); return signedOut ? null : token },
    signOut: async () => { signedOut = true },
    state: () => ({ kind: 'signed-out' }),
    onChange: () => () => {},
  }
  return { session, asked, isSignedOut: () => signedOut }
}

const signedInAccount = (origin: string, fetchImpl: typeof fetch) => oauthCloudAccount(origin, fakeSession().session, fetchImpl)

describe('the cloud account source', () => {
  test('cloud agent status reads the seat refs of the account vault, never an execution host', async () => {
    const connections = [
      { ref: { kind: 'seat', provider: 'claude-code' }, material: 'cli-login', status: 'connected', label: null, updatedAt: 5 },
      { ref: { kind: 'seat', provider: 'codex' }, material: 'cli-login', status: 'needs-sign-in', label: null, updatedAt: 6 },
      { ref: { kind: 'typesafe' }, material: 'key', status: 'connected', label: null, updatedAt: 7 },
    ]
    const good = recordingFetch((_url, init) => {
      // The website's cookie is not the credential: an account-plane access token is.
      expect(init.credentials).toBe('omit')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer account-token')
      expect(init.cache).toBe('no-store')
      return Response.json({ connections })
    })
    // WHY: a seat whose CLI was signed out is in the vault but cannot run anything.
    expect(await signedInAccount(ORIGIN, good.fetchImpl).readAgentSeats()).toEqual([
      { provider: 'claude-code', connected: true, updatedAt: 5 },
      { provider: 'codex', connected: false, updatedAt: 6 },
    ])
    expect(good.calls).toEqual([{ url: `${ORIGIN}/v1/account/vault`, method: 'GET', body: null }])
    for (const response of [Response.json({ connections: [{ ref: { kind: 'seat', provider: 'claude-code' }, status: 'yes' }] }), new Response(null, { status: 503 })]) {
      expect(await signedInAccount(ORIGIN, recordingFetch(() => response).fetchImpl).readAgentSeats()).toBeNull()
    }
  })

  test('reads the account and treats a malformed answer as none', async () => {
    const account = { userId: 'ada', onboardingCompletedAt: null, activeOrganizationId: 'org', organizations: [] }
    const good = recordingFetch(() => Response.json(account))
    expect(await signedInAccount(ORIGIN, good.fetchImpl).readAccount()).toEqual(account)
    expect(good.calls[0]).toMatchObject({ url: `${ORIGIN}/v1/account`, method: 'GET' })

    const bad = recordingFetch(() => Response.json({ userId: 'ada' }))
    expect(await signedInAccount(ORIGIN, bad.fetchImpl).readAccount()).toBeNull()
  })

  test("reads the account's GitHub, the answer onboarding waits on after Connections", async () => {
    // WHY: GitHub belongs to the account, so onboarding asks the account, not a machine or
    // the Solus API. Connected, not connected, and unknown (an older control plane) must
    // stay apart: unknown hides the "Get started" row instead of asking to connect again.
    const base = { userId: 'ada', onboardingCompletedAt: null, activeOrganizationId: 'org', organizations: [] }
    const read = (body: object) => signedInAccount(ORIGIN, recordingFetch(() => Response.json(body)).fetchImpl).readAccount()
    expect((await read({ ...base, github: { login: 'ada' } }))?.github).toEqual({ login: 'ada' })
    expect((await read({ ...base, github: null }))?.github).toBeNull()
    expect((await read(base))?.github).toBeUndefined()
    // A malformed field costs only itself, never the whole account.
    const malformed = await read({ ...base, github: { login: 7 } })
    expect(malformed?.userId).toBe('ada')
    expect(malformed?.github).toBeUndefined()
  })

  test('ending onboarding, creating the cloud host and sharing a machine call the account origin', async () => {
    const { calls, fetchImpl } = recordingFetch((url) => url.endsWith('/v1/hosts')
      ? Response.json({ hostId: 'h_new' }, { status: 201 })
      : new Response(null, { status: 204 }))
    const source = signedInAccount(ORIGIN, fetchImpl)

    expect(await source.completeOnboarding()).toBe(true)
    expect(await source.createManagedHost('org_acme')).toEqual({ ok: true, hostId: 'h_new' })
    expect(await source.createManagedHost('org_acme', { label: 'Acme', spec: { size: 'standard' } }))
      .toEqual({ ok: true, hostId: 'h_new' })
    // WHY (organization-scope R15): a host is shared with each organization on its
    // own, so sharing adds one and taking it back removes that one alone.
    expect(await source.shareHost('h_laptop', 'org_acme', true)).toBe(true)
    expect(await source.shareHost('h_laptop', 'org_acme', false)).toBe(true)
    expect(calls.map((call) => [call.method, call.url.slice(ORIGIN.length), call.body])).toEqual([
      ['POST', '/v1/account/onboarding', null],
      ['POST', '/v1/hosts', JSON.stringify({ organizationId: 'org_acme' })],
      ['POST', '/v1/hosts', JSON.stringify({ organizationId: 'org_acme', label: 'Acme', spec: { size: 'standard' } })],
      ['POST', '/v1/hosts/h_laptop/organizations', JSON.stringify({ organizationId: 'org_acme' })],
      ['DELETE', '/v1/hosts/h_laptop/organizations/org_acme', null],
    ])
    expect(source.connectionsUrl).toBe(`${ORIGIN}/connections`)
  })

  test('a refused create names no host but says why, so onboarding can tell "it exists" from "it failed"', async () => {
    const limit = recordingFetch(() => Response.json({ error: 'managed_host_limit' }, { status: 409 }))
    expect(await signedInAccount(ORIGIN, limit.fetchImpl).createManagedHost('org_acme'))
      .toEqual({ ok: false, code: 'managed_host_limit', message: null })
    const unreachable = signedInAccount(ORIGIN, recordingFetch(() => { throw new TypeError('offline') }).fetchImpl)
    expect(await unreachable.createManagedHost('org_acme')).toEqual({ ok: false, code: null, message: null })
  })

  test('calls ask the sign-in for an account-plane token, and none is sent when there is none', async () => {
    const fake = fakeSession()
    const { calls, fetchImpl } = recordingFetch(() => Response.json({}))
    await oauthCloudAccount(ORIGIN, fake.session, fetchImpl).readAccount()
    expect(fake.asked).toEqual([{ kind: 'account' }])
    const signedOut = recordingFetch(() => Response.json({}))
    expect(await oauthCloudAccount(ORIGIN, fakeSession(null).session, signedOut.fetchImpl).readAccount()).toBeNull()
    expect(signedOut.calls).toEqual([])
    expect(calls).toHaveLength(1)
  })

  test('sign-out ends the client grant, then the website cookie, so the page does not sign itself in again', async () => {
    const fake = fakeSession()
    const sent: Array<{ url: string; credentials: RequestCredentials | undefined }> = []
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      sent.push({ url: String(input), credentials: init.credentials })
      return new Response(null, { status: 200 })
    }) as typeof fetch
    const source = oauthCloudAccount(ORIGIN, fake.session, fetchImpl)
    expect(await source.signOut()).toBe(true)
    expect(fake.isSignedOut()).toBe(true)
    expect(sent).toEqual([{ url: `${ORIGIN}/api/auth/sign-out`, credentials: 'same-origin' }])
    expect(source.consoleUrl).toBe(ORIGIN)
  })

  test('boot starts one account read that the workspace reuses, so onboarding is known before it paints', async () => {
    const account = { userId: 'ada', onboardingCompletedAt: null, activeOrganizationId: 'org', organizations: [] }
    const { calls, fetchImpl } = recordingFetch(() => Response.json(account))
    configureCloudAccount(signedInAccount(ORIGIN, fetchImpl))
    const first = startupAccountRead()
    expect(first).toBe(startupAccountRead())
    expect(await first).toEqual(account)
    expect(calls).toHaveLength(1)

    // Off the account origin there is nothing to read and nothing to wait for.
    configureCloudAccount(null)
    expect(startupAccountRead()).toBeNull()
  })
})
