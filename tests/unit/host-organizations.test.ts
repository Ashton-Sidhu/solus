import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { HostOrganizationsResponse, UplinkLinkConfig } from '@solus/contracts/uplink'
import { DEFAULT_ORGANIZATION_POLICY } from '@solus/contracts/uplink'

// docs/plans/organization-scope.md §3, §3.1, §6.1: the host's standing — who
// linked it and which organizations it may deliver to, each with its policy —
// is read from the control plane under the host token, kept between reads, and
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

const LINK: UplinkLinkConfig = { hostId: 'H', issuer: 'https://cloud.invalid', jwksUrl: 'https://cloud.invalid/jwks', directoryUrl: 'https://cloud.invalid', hostname: 'h-H.lab.invalid', proxiedPort: 1, connectionGeneration: 1 }

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
function registry(answers: Answer[], linked = true) {
  const requests: Array<{ url: string; authorization: string | null }> = []
  const timers: number[] = []
  const changes: Array<HostStanding | null> = []
  const instance = new organizations.HostOrganizations({
    link: () => (linked ? LINK : null),
    hostToken: () => 'sht_token',
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
  return { instance, requests, timers, changes }
}

describe('the host\'s standing', () => {
  test('a refresh reads the answer under the host token and answers the organizations, their policies, and the owner', async () => {
    const { instance, requests, timers } = registry([{ status: 200, body: STANDING }])
    expect(instance.current()).toBeNull()
    expect(instance.organizations()).toEqual([])
    await instance.refresh()
    expect(requests).toEqual([{ url: 'https://cloud.invalid/v1/hosts/H/organizations', authorization: 'Bearer sht_token' }])
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

  test('mayExecute holds an organization\'s allowsPersonalHosts against this machine\'s category', async () => {
    // WHY: an organization that refuses personal machines must be refused on one
    // even for the owner (§3.1); a self-hosted server or a managed machine is not a personal one.
    const { instance } = registry([{ status: 200, body: STANDING }])
    await instance.refresh()
    expect(instance.mayExecute('A')).toBe(true)
    expect(instance.mayExecute('B')).toBe(false)
    expect(instance.mayExecute('local')).toBe(true)
    expect(instance.mayExecute('Z')).toBe(true)
    hostCategory.applyHostCategory('self-hosted')
    expect(instance.mayExecute('B')).toBe(true)
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
    expect(instance.mayExecute('B')).toBe(true)

    const linked = registry([{ status: 200, body: STANDING }, { status: 200, body: STANDING }])
    await linked.instance.refresh()
    expect(linked.instance.organizations()).toHaveLength(2)
    linked.instance.linkChanged()
    expect(linked.changes.map((standing) => standing?.hostId ?? null)).toEqual(['H', null])
    // The refresh the change started lands afterwards.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(linked.requests).toHaveLength(2)
    expect(linked.instance.organizations()).toHaveLength(2)
    expect(linked.changes).toHaveLength(3)
  })
})
