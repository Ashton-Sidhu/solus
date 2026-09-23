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
  test('reads the account and treats a malformed answer as none', async () => {
    const account = { userId: 'ada', onboardingCompletedAt: null, activeOrganizationId: 'org', organizations: [] }
    const good = recordingFetch(() => Response.json(account))
    expect(await cookieCloudAccount(ORIGIN, good.fetchImpl).readAccount()).toEqual(account)
    expect(good.calls[0]).toMatchObject({ url: `${ORIGIN}/v1/account`, method: 'GET' })

    const bad = recordingFetch(() => Response.json({ userId: 'ada' }))
    expect(await cookieCloudAccount(ORIGIN, bad.fetchImpl).readAccount()).toBeNull()
  })

  test('ending onboarding, creating the cloud host and sharing a machine call the account origin', async () => {
    const { calls, fetchImpl } = recordingFetch((url) => url.endsWith('/v1/hosts')
      ? Response.json({ hostId: 'h_new' }, { status: 201 })
      : new Response(null, { status: 204 }))
    const source = cookieCloudAccount(ORIGIN, fetchImpl)

    expect(await source.completeOnboarding()).toBe(true)
    expect(await source.createManagedHost('org_acme')).toEqual({ ok: true, hostId: 'h_new' })
    expect(await source.shareHost('h_laptop', 'org_acme')).toBe(true)
    expect(await source.shareHost('h_laptop', null)).toBe(true)
    expect(calls.map((call) => [call.method, call.url.slice(ORIGIN.length), call.body])).toEqual([
      ['POST', '/v1/account/onboarding', null],
      ['POST', '/v1/hosts', JSON.stringify({ organizationId: 'org_acme' })],
      ['PUT', '/v1/hosts/h_laptop/organization', JSON.stringify({ organizationId: 'org_acme' })],
      ['PUT', '/v1/hosts/h_laptop/organization', JSON.stringify({ organizationId: null })],
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
