import { describe, expect, test } from 'bun:test'
import type { DirectoryHost } from '@solus/contracts/uplink'
import type { IntroducedHost } from '@solus/contracts/host-api'
import type { DiscoveredServer } from '@solus/contracts/types'
import { RemoteHosts, type IntroducedHostSource, type ReachActor, type ReachRequest } from '@solus/server/execution/orchestration/remote-hosts'

// WHY: an agent starts work only on a host its turn's person reaches
// (docs/plans/host-reach.md): one the account plane lists for that person, or, for
// the owner, one this host was introduced to. Account reach comes first (§5). An
// agent names the host by id or by the name the person sees, so a name must find
// exactly one host, an unclear name must be refused rather than guessed, and this
// host is never its own target. Two people never share a connection to a host.

function host(hostId: string, label: string, overrides: Partial<DirectoryHost> = {}): DirectoryHost {
  return {
    hostId, installationId: `install-${hostId}`, label,
    routes: [{ kind: 'tunnel', url: `https://${hostId}.example` }],
    kind: 'personal', category: 'personal', organizationIds: [],
    ...overrides,
  }
}

const OWNER: ReachRequest = { account: { userId: 'alice', scope: 'personal' }, isOwner: true }
const MEMBER: ReachRequest = { account: { userId: 'bob', scope: { organizationId: 'org_a' } }, isOwner: false }
const NO_ACCOUNT: ReachRequest = { account: null, isOwner: true }

const noIntroductions: IntroducedHostSource = { list: () => ({ hosts: [], refused: [] }), credential: async () => null }

function introductionsOf(hosts: IntroducedHost[]): IntroducedHostSource {
  return { list: () => ({ hosts, refused: [] }), credential: async (installationId) => `introduced-token-${installationId}` }
}

function hostsOf(directory: DirectoryHost[] | null, options: { introduced?: IntroducedHostSource; nearby?: DiscoveredServer[]; asked?: ReachActor[] } = {}) {
  return new RemoteHosts(
    (actor) => {
      options.asked?.push(actor)
      return { hosts: async () => directory, accessToken: async (hostId) => `reach-token-${actor.userId}-${hostId}` }
    },
    options.introduced ?? noIntroductions,
    () => 'this-host',
    async () => options.nearby ?? [],
  )
}

function nearbyHost(installationId: string, address: string): DiscoveredServer {
  return { host: address, port: 7777, name: installationId, installationId, source: 'lan' }
}

const studio: IntroducedHost = { installationId: 'install-h-mini', label: 'Studio Mini', url: 'http://100.64.0.2:7777', introducedAt: 1 }

describe('the hosts a person reaches', () => {
  test('a host is found by its id or by its name in any case', async () => {
    const hosts = hostsOf([host('h-mini', 'Studio Mini'), host('h-book', 'Laptop')])
    expect(await hosts.find(OWNER, 'h-book')).toMatchObject({ hostId: 'h-book' })
    expect(await hosts.find(OWNER, 'studio mini')).toMatchObject({ hostId: 'h-mini' })
  })

  test('a name two hosts share is refused, and the error names their ids', async () => {
    const found = await hostsOf([host('h-1', 'Build'), host('h-2', 'build')]).find(OWNER, 'Build')
    expect(found).toEqual({ error: expect.stringContaining('More than one host is named') })
    expect(JSON.stringify(found)).toContain('h-2')
  })

  test('this host and a host with no way in are not targets', async () => {
    const hosts = hostsOf([host('this-host', 'Here'), host('h-new', 'New', { routes: [] }), host('h-ok', 'There')])
    expect(await hosts.list(OWNER)).toEqual([expect.objectContaining({ hostId: 'h-ok' })])
    expect(await hosts.find(OWNER, 'Here')).toEqual({ error: expect.stringContaining('You do not reach a host "Here"') })
  })

  test('a managed host that is not running is refused before any connection', async () => {
    const hosts = hostsOf([host('h-cloud', 'Cloud', { kind: 'managed', category: 'managed', managedState: 'stopped' })])
    const found = await hosts.find(OWNER, 'Cloud')
    if ('error' in found) throw new Error(found.error)
    expect(hosts.connect(found)).toEqual({ error: 'Cloud is stopped. Start it first, then try again.' })
  })

  test('the dial uses the turn person\'s host-reach token, in the scope of the turn', async () => {
    const asked: ReachActor[] = []
    const hosts = hostsOf([host('h-org', 'Org box', { organizationIds: ['org_a'] })], { asked })
    const found = await hosts.find(MEMBER, 'Org box')
    if ('error' in found) throw new Error(found.error)
    expect(asked).toEqual([MEMBER.account!])
    expect(await found.credential()).toBe('reach-token-bob-h-org')
    // A member reaches the host in the organization they work in here.
    expect(found.organizationId).toBe('org_a')
  })

  test('a dial for the owner names no organization: the reach token states their standing there', async () => {
    // WHY: host B admits a reach token with the standing the account plane put in it; a
    // named organization the token does not state is refused there.
    const found = await hostsOf([host('h-shared', 'Shared', { organizationIds: ['org_a'] })]).find(OWNER, 'Shared')
    if ('error' in found) throw new Error(found.error)
    expect(found.organizationId).toBeUndefined()
  })

  test('two people never share one connection to the same host', async () => {
    const hosts = hostsOf([host('h-org', 'Org box', { organizationIds: ['org_a'] })])
    const forAlice = await hosts.find(OWNER, 'Org box')
    const forBob = await hosts.find(MEMBER, 'Org box')
    if ('error' in forAlice || 'error' in forBob) throw new Error('not found')
    expect(forAlice.connectionKey).not.toBe(forBob.connectionKey)
  })
})

describe('local reach: introduced hosts (§4)', () => {
  test('an introduced host is a target with no account', async () => {
    const hosts = new RemoteHosts(() => null, introductionsOf([studio]), () => null)
    const found = await hosts.find(NO_ACCOUNT, 'studio mini')
    if ('error' in found) throw new Error(found.error)
    expect(found).toMatchObject({ hostId: 'install-h-mini', url: 'http://100.64.0.2:7777', source: 'introduced' })
    expect(await found.credential()).toBe('introduced-token-install-h-mini')
  })

  test('only the owner\'s turns use introduced hosts: they are the owner\'s own trust', async () => {
    const hosts = hostsOf([], { introduced: introductionsOf([studio]) })
    expect(await hosts.list(MEMBER)).toEqual({ error: expect.stringContaining('reaches no other host') })
  })

  test('a host the account lists and that was introduced uses the account, and is listed once', async () => {
    const hosts = hostsOf([host('h-mini', 'Studio Mini'), host('h-book', 'Laptop')], { introduced: introductionsOf([studio]) })
    const listed = await hosts.list(OWNER)
    if ('error' in listed) throw new Error(listed.error)
    expect(listed.map((target) => [target.label, target.source])).toEqual([['Studio Mini', 'account'], ['Laptop', 'account']])
  })

  test('introduced hosts stay reachable when the account does not answer', async () => {
    expect(await hostsOf(null, { introduced: introductionsOf([studio]) }).list(OWNER)).toEqual([expect.objectContaining({ label: 'Studio Mini', source: 'introduced' })])
  })

  test('with no reach at all, the error names both ways in', async () => {
    const listed = await new RemoteHosts(() => null, noIntroductions, () => null).list(NO_ACCOUNT)
    expect(listed).toEqual({ error: expect.stringContaining('Link both hosts to your Solus account') })
    expect(listed).toEqual({ error: expect.stringContaining('introduced') })
  })
})

describe('registered hosts that are not linked (docs/adr/0001-standard-authentication.md §2.2 rule 9)', () => {
  test('a directory host with no route is reached on the local network when discovery answers with its installation id', async () => {
    const hosts = hostsOf([host('h-desk', 'Desk', { routes: [] }), host('h-far', 'Far', { routes: [] })], { nearby: [nearbyHost('install-h-desk', '192.168.1.20')] })
    const listed = await hosts.list(OWNER)
    if ('error' in listed) throw new Error(listed.error)
    // The host on this network is a target; the one nowhere near has no way in.
    expect(listed.map((target) => [target.hostId, target.url])).toEqual([['h-desk', 'http://192.168.1.20:7777']])
    expect(await listed[0]!.credential()).toBe('reach-token-alice-h-desk')
  })

  test('a linked host found on the local network is dialed there before its tunnel', async () => {
    const hosts = hostsOf([host('h-book', 'Laptop')], { nearby: [nearbyHost('install-h-book', '192.168.1.30')] })
    expect(await hosts.find(OWNER, 'Laptop')).toMatchObject({ url: 'http://192.168.1.30:7777' })
  })
})
