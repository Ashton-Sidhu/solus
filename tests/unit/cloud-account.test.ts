import { describe, expect, test } from 'bun:test'
import { configureCloudAccount, cookieCloudAccount, startupAccountRead } from '@solus/client-core/cloud-account'

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

describe('the cloud account source', () => {
  test('cloud agent status reads the account database endpoint, never an execution host', async () => {
    const seats = [
      { provider: 'claude-code', connected: true, updatedAt: '2026-10-02T18:34:43.873Z' },
      { provider: 'codex', connected: false, updatedAt: null },
    ]
    const good = recordingFetch((_url, init) => {
      expect(init.credentials).toBe('same-origin')
      expect(init.cache).toBe('no-store')
      return Response.json({ seats })
    })
    expect(await cookieCloudAccount(ORIGIN, good.fetchImpl).readAgentSeats()).toEqual(seats)
    expect(good.calls).toEqual([{ url: `${ORIGIN}/v1/account/agent-seats`, method: 'GET', body: null }])
    for (const response of [Response.json({ seats: [{ provider: 'claude-code', connected: 'yes' }] }), new Response(null, { status: 503 })]) {
      expect(await cookieCloudAccount(ORIGIN, recordingFetch(() => response).fetchImpl).readAgentSeats()).toBeNull()
    }
  })

  test('reads the account and treats a malformed answer as none', async () => {
    const account = { userId: 'ada', onboardingCompletedAt: null, activeOrganizationId: 'org', organizations: [] }
    const good = recordingFetch(() => Response.json(account))
    expect(await cookieCloudAccount(ORIGIN, good.fetchImpl).readAccount()).toEqual(account)
    expect(good.calls[0]).toMatchObject({ url: `${ORIGIN}/v1/account`, method: 'GET' })

    const bad = recordingFetch(() => Response.json({ userId: 'ada' }))
    expect(await cookieCloudAccount(ORIGIN, bad.fetchImpl).readAccount()).toBeNull()
  })

  test("reads the account's GitHub, the answer onboarding waits on after Connections", async () => {
    // WHY: GitHub belongs to the account, so onboarding asks the account, not a machine or
    // the Solus API. Connected, not connected, and unknown (an older control plane) must
    // stay apart: unknown hides the "Get started" row instead of asking to connect again.
    const base = { userId: 'ada', onboardingCompletedAt: null, activeOrganizationId: 'org', organizations: [] }
    const read = (body: object) => cookieCloudAccount(ORIGIN, recordingFetch(() => Response.json(body)).fetchImpl).readAccount()
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
    const source = cookieCloudAccount(ORIGIN, fetchImpl)

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
    expect(await cookieCloudAccount(ORIGIN, limit.fetchImpl).createManagedHost('org_acme'))
      .toEqual({ ok: false, code: 'managed_host_limit', message: null })
    const unreachable = cookieCloudAccount(ORIGIN, recordingFetch(() => { throw new TypeError('offline') }).fetchImpl)
    expect(await unreachable.createManagedHost('org_acme')).toEqual({ ok: false, code: null, message: null })
  })

  test('the cookie names who is signed in, so the sidebar shows the account on a cloud host', async () => {
    const me = { id: 'u_ada', email: 'ada@example.com', name: 'Ada', avatarUrl: null }
    const { calls, fetchImpl } = recordingFetch((url) => url.endsWith('/api/account/me')
      ? Response.json(me)
      : new Response(null, { status: 200 }))
    const source = cookieCloudAccount(ORIGIN, fetchImpl)
    expect(await source.readProfile()).toEqual(me)
    expect(await source.signOut()).toBe(true)
    expect(calls.map((call) => [call.method, call.url.slice(ORIGIN.length)])).toEqual([
      ['GET', '/api/account/me'],
      ['POST', '/api/auth/sign-out'],
    ])
    expect(source.consoleUrl).toBe(ORIGIN)

    // A signed-out cookie or a malformed answer is no account, never a blank one.
    const signedOut = recordingFetch(() => new Response(null, { status: 401 }))
    expect(await cookieCloudAccount(ORIGIN, signedOut.fetchImpl).readProfile()).toBeNull()
    const malformed = recordingFetch(() => Response.json({ id: 'u_ada' }))
    expect(await cookieCloudAccount(ORIGIN, malformed.fetchImpl).readProfile()).toBeNull()
  })

  test('boot starts one account read that the workspace reuses, so onboarding is known before it paints', async () => {
    const account = { userId: 'ada', onboardingCompletedAt: null, activeOrganizationId: 'org', organizations: [] }
    const { calls, fetchImpl } = recordingFetch(() => Response.json(account))
    configureCloudAccount(cookieCloudAccount(ORIGIN, fetchImpl))
    const first = startupAccountRead()
    expect(first).toBe(startupAccountRead())
    expect(await first).toEqual(account)
    expect(calls).toHaveLength(1)

    // Off the account origin there is nothing to read and nothing to wait for.
    configureCloudAccount(null)
    expect(startupAccountRead()).toBeNull()
  })
})
