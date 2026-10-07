import { describe, expect, test } from 'bun:test'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { RemoteHosts } from '@solus/server/execution/orchestration/remote-hosts'

// WHY: a host starts work only on a host the owner's account lists
// (docs/plans/cross-host-sessions.md §5.2). An agent names the host by id or by
// the name the person sees, so a name must find exactly one host, an unclear
// name must be refused rather than guessed, and this host is never its own target.

function host(hostId: string, label: string, overrides: Partial<DirectoryHost> = {}): DirectoryHost {
  return {
    hostId, installationId: `install-${hostId}`, label,
    routes: [{ kind: 'tunnel', url: `https://${hostId}.example` }],
    kind: 'personal', category: 'personal', organizationIds: [],
    ...overrides,
  }
}

function hostsOf(directory: DirectoryHost[] | null, self: string | null = 'this-host') {
  return new RemoteHosts({ hosts: async () => directory, accessToken: async () => 'token' }, () => self)
}

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

  test('a managed host that is not running is refused before any connection', () => {
    const connected = hostsOf([]).connect(host('h-cloud', 'Cloud', { kind: 'managed', category: 'managed', managedState: 'stopped' }))
    expect(connected).toEqual({ error: 'Cloud is stopped. Start it first, then try again.' })
  })
})
