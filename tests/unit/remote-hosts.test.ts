import { describe, expect, test } from 'bun:test'
import type { DirectoryHost } from '@solus/contracts/uplink'
import type { PairedHostSummary } from '@solus/contracts/host-api'
import { RemoteHosts, type PairedHostSource } from '@solus/server/execution/orchestration/remote-hosts'

// WHY: a host starts work only on a host the owner's account lists or one it
// paired with (docs/plans/cross-host-sessions.md §5.2, §10). An agent names the
// host by id or by the name the person sees, so a name must find exactly one
// host, an unclear name must be refused rather than guessed, and this host is
// never its own target. A paired host always uses its pairing (§10.3: one
// credential for each host), and pairing alone is enough without an account.

function host(hostId: string, label: string, overrides: Partial<DirectoryHost> = {}): DirectoryHost {
  return {
    hostId, installationId: `install-${hostId}`, label,
    routes: [{ kind: 'tunnel', url: `https://${hostId}.example` }],
    kind: 'personal', category: 'personal', organizationIds: [],
    ...overrides,
  }
}

const noPairs: PairedHostSource = { list: () => [], credential: async () => null }

function pairsOf(hosts: PairedHostSummary[]): PairedHostSource {
  return { list: () => hosts, credential: async (installationId) => `pairing-token-${installationId}` }
}

function hostsOf(directory: DirectoryHost[] | null, self: string | null = 'this-host', paired: PairedHostSource = noPairs) {
  return new RemoteHosts({ hosts: async () => directory, accessToken: async (hostId) => `account-token-${hostId}` }, paired, () => self)
}

const studio: PairedHostSummary = { installationId: 'install-h-mini', label: 'Studio Mini', url: 'http://100.64.0.2:7777', pairedAt: 1 }

describe('the owner\'s other hosts', () => {
  test('a host is found by its id or by its name in any case', async () => {
    const hosts = hostsOf([host('h-mini', 'Studio Mini'), host('h-book', 'Laptop')])
    expect(await hosts.find('h-book')).toMatchObject({ hostId: 'h-book' })
    expect(await hosts.find('studio mini')).toMatchObject({ hostId: 'h-mini' })
  })

  test('a name two hosts share is refused, and the error names their ids', async () => {
    const found = await hostsOf([host('h-1', 'Build'), host('h-2', 'build')]).find('Build')
    expect(found).toEqual({ error: expect.stringContaining('More than one host is named') })
    expect(JSON.stringify(found)).toContain('h-2')
  })

  test('this host and a host with no route yet are not targets', async () => {
    const hosts = hostsOf([host('this-host', 'Here'), host('h-new', 'New', { routes: [] }), host('h-ok', 'There')])
    expect(await hosts.list()).toEqual([expect.objectContaining({ hostId: 'h-ok' })])
    expect(await hosts.find('Here')).toEqual({ error: expect.stringContaining('No host "Here"') })
  })

  test('an account that does not answer is an error, not an empty list', async () => {
    expect(await hostsOf(null).list()).toEqual({ error: expect.stringContaining('did not answer') })
  })

  test('a managed host that is not running is refused before any connection', async () => {
    const hosts = hostsOf([host('h-cloud', 'Cloud', { kind: 'managed', category: 'managed', managedState: 'stopped' })])
    const found = await hosts.find('Cloud')
    if ('error' in found) throw new Error(found.error)
    expect(hosts.connect(found)).toEqual({ error: 'Cloud is stopped. Start it first, then try again.' })
  })
})

describe('paired hosts', () => {
  test('a paired host is a target on a host with no account session', async () => {
    const hosts = new RemoteHosts(null, pairsOf([studio]), () => null)
    const found = await hosts.find('studio mini')
    if ('error' in found) throw new Error(found.error)
    expect(found).toMatchObject({ hostId: 'install-h-mini', url: 'http://100.64.0.2:7777', paired: true })
    expect(await found.credential()).toBe('pairing-token-install-h-mini')
  })

  test('a host that is paired and in the directory uses its pairing, and is listed once', async () => {
    const hosts = hostsOf([host('h-mini', 'Studio Mini'), host('h-book', 'Laptop')], 'this-host', pairsOf([studio]))
    const listed = await hosts.list()
    if ('error' in listed) throw new Error(listed.error)
    expect(listed.map((target) => [target.label, target.paired])).toEqual([['Studio Mini', true], ['Laptop', false]])
    // The agent may name it by its installation id or its label.
    const found = await hosts.find('install-h-mini')
    if ('error' in found) throw new Error(found.error)
    expect(await found.credential()).toBe('pairing-token-install-h-mini')
    const laptop = await hosts.find('Laptop')
    if ('error' in laptop) throw new Error(laptop.error)
    expect(await laptop.credential()).toBe('account-token-h-book')
  })

  test('paired hosts stay reachable when the account does not answer', async () => {
    expect(await hostsOf(null, 'this-host', pairsOf([studio])).list()).toEqual([expect.objectContaining({ label: 'Studio Mini' })])
  })

  test('with no account and no pairing, the error says how to add a host', async () => {
    expect(await new RemoteHosts(null, noPairs, () => null).list()).toEqual({ error: expect.stringContaining('Pair a host in Settings → Hosts') })
  })
})
