import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostOrganizationsResponse, HostRegistration } from '@solus/contracts/uplink'
import { HostCredentialError } from '@solus/server/host/host-credential'

// docs/plans/organization-scope.md §3, §3.1, §6.1: the host's standing — who
// linked it and which organizations it may deliver to, each with its policy —
// is read from the control plane with the host's own control token (client
// credentials with its key, ADR 0001 §2.2 rule 8), kept between reads, and
// refreshed every minute with an ETag so a policy change reaches the host within
// about a minute. The last answer is kept on disk, so a host that restarts offline
// keeps enforcing what it last saw (plans/030 §5.2).

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
    { organizationId: 'A', name: 'Acme', shared: true, hostRules: { allowsCloudHosts: true, allowsPersonalHosts: true }, policy: { schemaVersion: 1, organization: { name: 'Acme' } }, hostPolicy: null },
    { organizationId: 'B', name: 'Bolt', shared: false, hostRules: { allowsCloudHosts: true, allowsPersonalHosts: false }, policy: { schemaVersion: 1, organization: { name: 'Bolt' } }, hostPolicy: null },
  ],
  hostOwnerOrganizationId: null,
}

type Answer = { status: number; body: unknown; etag?: string } | 'unreachable'

/** The control plane, one answer at a time, and the timers the registry set. */
function registry(answers: Answer[], linked = true, key: { refused: boolean } = { refused: false }, cachePath?: string) {
  const requests: Array<{ url: string; authorization: string | null; ifNoneMatch?: string }> = []
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
      const headers = new Headers(init?.headers)
      const ifNoneMatch = headers.get('if-none-match')
      requests.push({ url: String(url), authorization: headers.get('authorization'), ...(ifNoneMatch ? { ifNoneMatch } : {}) })
      const answer = answers.shift()
      if (!answer) throw new Error('The test gave no answer for this request.')
      if (answer === 'unreachable') throw new Error('connect ECONNREFUSED')
      if (answer.status === 304) return new Response(null, { status: 304 })
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json', ...(answer.etag ? { etag: answer.etag } : {}) } })
    },
    setTimeoutFn: ((_fn: () => void, ms: number) => { timers.push(ms); return { unref() {} } }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
    ...(cachePath ? { cachePath } : {}),
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
    expect(instance.organization('B')?.hostRules).toEqual({ allowsCloudHosts: true, allowsPersonalHosts: false })
    expect(instance.owner()).toEqual({ userId: 'alice', email: 'alice@example.test', name: 'Alice' })
    // A good answer schedules the periodic refresh.
    expect(timers).toEqual([60_000])
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
    expect(timers).toEqual([60_000])
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
    expect(timers).toEqual([60_000, 30_000, 30_000])
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

describe('policy delivery (plans/030 §5.2)', () => {
  test('an unchanged standing answers 304 to the ETag: the host keeps what it has and asks again in a minute', async () => {
    // WHY: hosts poll every minute; an idle poll must cost the control plane almost nothing.
    const { instance, requests, timers, changes } = registry([{ status: 200, body: STANDING, etag: '"r1"' }, { status: 304, body: null }])
    await instance.refresh()
    await instance.refresh()
    expect(requests[0]?.ifNoneMatch).toBeUndefined()
    expect(requests[1]?.ifNoneMatch).toBe('"r1"')
    expect(instance.organizations()).toHaveLength(2)
    expect(changes).toHaveLength(1)
    expect(timers).toEqual([60_000, 60_000])
  })

  test('the last answer is kept on disk and loaded before the first read, so an offline restart keeps its policies', async () => {
    // WHY: without the copy, a host restarted offline would run with no cloud host policy until it reached the cloud.
    const dir = mkdtempSync(join(tmpdir(), 'solus-standing-'))
    const cachePath = join(dir, 'organization-standing.json')
    try {
      const online = registry([{ status: 200, body: STANDING, etag: '"r1"' }], true, { refused: false }, cachePath)
      await online.instance.refresh()
      expect(statSync(cachePath).mode & 0o777).toBe(0o600)
      const restarted = registry(['unreachable'], true, { refused: false }, cachePath)
      expect(restarted.instance.organizations().map((entry) => entry.organizationId)).toEqual(['A', 'B'])
      await restarted.instance.refresh()
      expect(restarted.instance.organizations()).toHaveLength(2)
      expect(restarted.requests[0]?.ifNoneMatch).toBe('"r1"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a refused registration deletes the copy: a host that is no longer registered keeps no organization policies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-standing-'))
    const cachePath = join(dir, 'organization-standing.json')
    try {
      const { instance } = registry([{ status: 200, body: STANDING }, { status: 401, body: {} }], true, { refused: false }, cachePath)
      await instance.refresh()
      expect(existsSync(cachePath)).toBe(true)
      await instance.refresh()
      expect(existsSync(cachePath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
