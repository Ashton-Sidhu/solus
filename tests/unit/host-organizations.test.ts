import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { HostOrganizationsResponse, HostRegistration } from '@solus/contracts/uplink'
import { DEFAULT_ORGANIZATION_POLICY } from '@solus/contracts/uplink'
import { HostCredentialError } from '@solus/server/host/host-credential'

// docs/plans/organization-scope.md §3, §3.1, §6.1: the host's standing — who
// linked it and which organizations it may deliver to, each with its policy —
// is read from the control plane with the host's own control token (client
// credentials with its key, ADR 0001 §2.2 rule 8), kept between reads, and
// refreshed on a timer so a policy change reaches the host without a restart.

let organizations: typeof import('@solus/server/host/organizations')
let hostCategory: typeof import('@solus/server/host/host-category')
type HostStanding = import('@solus/server/host/organizations').HostStanding

beforeAll(async () => {
  organizations = await import('@solus/server/host/organizations')
  hostCategory = await import('@solus/server/host/host-category')
  ;(await import('@solus/server/host/host-category')).resetHostCategoryForTests()
})

afterEach(() => {
  hostCategory.resetHostCategoryForTests()
})

const LINK: HostRegistration = { hostId: 'H', issuer: 'https://cloud.invalid', jwksUrl: 'https://cloud.invalid/jwks', directoryUrl: 'https://cloud.invalid', generation: 1 }

const STANDING: HostOrganizationsResponse = {
  hostId: 'H',
  category: 'personal',
  owner: { userId: 'alice', email: 'alice@example.test', name: 'Alice' },
  organizations: [
    { organizationId: 'A', name: 'Acme', shared: true, policy: { allowsCloudHosts: true, allowsPersonalHosts: true, syncAllInsights: true } },
    { organizationId: 'B', name: 'Bolt', shared: false, policy: { allowsCloudHosts: true, allowsPersonalHosts: false, syncAllInsights: false } },
  ],
}

type Answer = { status: number; body: unknown } | 'unreachable'

/** The control plane, one answer at a time, and the timers the registry set. */
function registry(answers: Answer[], linked = true, key: { refused: boolean } = { refused: false }) {
  const requests: Array<{ url: string; authorization: string | null }> = []
  const timers: number[] = []
  const changes: Array<HostStanding | null> = []
  const refusals: number[] = []
  const instance = new organizations.HostOrganizations({
    registration: () => (linked ? LINK : null),
    onRegistrationRefused: () => refusals.push(Date.now()),
    credential: () => ({
      hostAccessToken: async () => {
        if (key.refused) throw new HostCredentialError('refused', 'invalid_client')
        return 'control-token'
      },
    }),
    fetchImpl: async (url, init) => {
      const headers = init?.headers as Record<string, string> | undefined
      requests.push({ url: String(url), authorization: headers?.authorization ?? null })
      const answer = answers.shift()
      if (!answer) throw new Error('The test gave no answer for this request.')
      if (answer === 'unreachable') throw new Error('connect ECONNREFUSED')
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
    },
    setTimeoutFn: ((_fn: () => void, ms: number) => { timers.push(ms); return { unref() {} } }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  })
  instance.onChanged((standing) => changes.push(standing))
  return { instance, requests, timers, changes, refusals }
}

describe('the host\'s standing', () => {
  test('a refresh reads the answer with the host’s control token and answers the organizations, their policies, and the owner', async () => {
    const { instance, requests, timers } = registry([{ status: 200, body: STANDING }])
    expect(instance.current()).toBeNull()
    expect(instance.organizations()).toEqual([])
    await instance.refresh()
    expect(requests).toEqual([{ url: 'https://cloud.invalid/v1/hosts/H/organizations', authorization: 'Bearer control-token' }])
    expect(instance.current()).toMatchObject({ hostId: 'H', category: 'personal', owner: { userId: 'alice' } })
    expect(instance.organizations().map((entry) => entry.organizationId)).toEqual(['A', 'B'])
    expect(instance.organization('A')).toMatchObject({ name: 'Acme', shared: true })
    expect(instance.organization('Z')).toBeNull()
    expect(instance.policyFor('B')).toEqual({ allowsCloudHosts: true, allowsPersonalHosts: false, syncAllInsights: false })
    // An organization the host has not heard of has the defaults; Local has no policy at all.
    expect(instance.policyFor('Z')).toEqual(DEFAULT_ORGANIZATION_POLICY)
    expect(instance.policyFor('local')).toBeNull()
    expect(instance.owner()).toEqual({ userId: 'alice', email: 'alice@example.test', name: 'Alice' })
    // A good answer schedules the periodic refresh.
    expect(timers).toEqual([5 * 60_000])
  })

  test('onChanged fires only when the standing changed, not on every refresh', async () => {
    const changed: HostOrganizationsResponse = { ...STANDING, organizations: [STANDING.organizations[0]] }
    const { instance, changes } = registry([{ status: 200, body: STANDING }, { status: 200, body: STANDING }, { status: 200, body: changed }])
    await instance.refresh()
    await instance.refresh()
    expect(changes).toHaveLength(1)
    await instance.refresh()
    expect(changes).toHaveLength(2)
    expect(changes[1]?.organizations.map((entry) => entry.organizationId)).toEqual(['A'])
  })

  test('a 401 means the token is no longer this host\'s: the standing is cleared and nothing is retried', async () => {
    const { instance, timers, changes } = registry([{ status: 200, body: STANDING }, { status: 401, body: { error: 'unauthorized' } }])
    await instance.refresh()
    await instance.refresh()
    expect(instance.current()).toBeNull()
    expect(instance.organizations()).toEqual([])
    expect(instance.owner()).toBeNull()
    expect(changes.map((standing) => standing?.hostId ?? null)).toEqual(['H', null])
    expect(timers).toEqual([5 * 60_000])
  })

  test('a refused registration is reported, so the registrar forgets it and the owner\'s client registers the host again', async () => {
    // WHY: with no retry here, a host that only cleared its standing stayed "registered"
    // with a dead key: no client registered it again, and it could not read the account.
    const key = { refused: false }
    const { instance, refusals } = registry([{ status: 200, body: STANDING }, { status: 401, body: {} }, { status: 404, body: {} }], true, key)
    await instance.refresh()
    expect(refusals).toHaveLength(0)
    await instance.refresh()
    expect(refusals).toHaveLength(1)
    await instance.refresh()
    expect(refusals).toHaveLength(2)
    key.refused = true
    await instance.refresh()
    expect(refusals).toHaveLength(3)
  })

  test('an outage or another refusal is not a refused registration', async () => {
    const { instance, refusals } = registry(['unreachable', { status: 500, body: {} }, { status: 403, body: {} }])
    await instance.refresh()
    await instance.refresh()
    await instance.refresh()
    expect(refusals).toHaveLength(0)
  })

  test('a key the account plane refuses means the link is gone: the standing is cleared and nothing is asked', async () => {
    // WHY: relinking or unlinking removes the host's client; its old key gets no control token.
    const key = { refused: false }
    const { instance, requests, changes } = registry([{ status: 200, body: STANDING }], true, key)
    await instance.refresh()
    key.refused = true
    await instance.refresh()
    expect(instance.current()).toBeNull()
    expect(requests).toHaveLength(1)
    expect(changes.map((standing) => standing?.hostId ?? null)).toEqual(['H', null])
  })

  test('an unreachable control plane keeps the previous standing and schedules a retry', async () => {
    // WHY: a laptop that lost its network must keep admitting turns on what it last knew.
    const { instance, timers, changes } = registry([{ status: 200, body: STANDING }, 'unreachable', { status: 500, body: { error: 'oops' } }])
    await instance.refresh()
    await instance.refresh()
    expect(instance.organizations().map((entry) => entry.organizationId)).toEqual(['A', 'B'])
    await instance.refresh()
    expect(instance.organizations().map((entry) => entry.organizationId)).toEqual(['A', 'B'])
    expect(changes).toHaveLength(1)
    expect(timers).toEqual([5 * 60_000, 30_000, 30_000])
  })

  test('an unlinked host stands in no organization and asks nothing; a link change forgets the standing and asks again', async () => {
    const { instance, requests } = registry([], false)
    await instance.refresh()
    expect(requests).toEqual([])
    expect(instance.current()).toBeNull()

    const linked = registry([{ status: 200, body: STANDING }, { status: 200, body: STANDING }])
    await linked.instance.refresh()
    expect(linked.instance.organizations()).toHaveLength(2)
    linked.instance.registrationChanged()
    expect(linked.changes.map((standing) => standing?.hostId ?? null)).toEqual(['H', null])
    // The refresh the change started lands afterwards.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(linked.requests).toHaveLength(2)
    expect(linked.instance.organizations()).toHaveLength(2)
    expect(linked.changes).toHaveLength(3)
  })
})
