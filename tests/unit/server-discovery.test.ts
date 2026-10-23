import { describe, expect, test } from 'bun:test'
import { parseTailscalePeerCandidates, tailnetEndpointFromStatus } from '@solus/server/transport/endpoints'
import { isLanDiscoveryDisabled } from '@solus/server/transport/lan-discovery'
import {
  discoveredServersFrom,
  discoveryQuery,
  discoveryResponse,
  lanBroadcastAddresses,
  lanSweepAddresses,
  parseLanDiscoveryMessage,
} from '@solus/contracts/lan-discovery'
import {
  filterUnsavedDiscoveredServers,
  mergeNearbyHosts,
  NEARBY_HOST_TTL_MS,
} from '@solus/workspace-ui/contexts/connections/discovery'
import type { DiscoveredServer } from '@solus/contracts/types'

describe('server discovery', () => {
  test('disables LAN discovery for tests and explicitly isolated app runs', () => {
    expect(isLanDiscoveryDisabled({ SOLUS_TEST_MODE: '1' })).toBe(true)
    expect(isLanDiscoveryDisabled({ SOLUS_NO_LAN_DISCOVERY: '1' })).toBe(true)
    expect(isLanDiscoveryDisabled({})).toBe(false)
  })

  test('accepts a valid LAN discovery response', () => {
    const response = {
      protocol: 'solus-discovery',
      version: 1,
      type: 'response',
      nonce: '0123456789abcdef01234567',
      port: 3000,
      name: 'build-server',
      installationId: 'remote-installation',
      os: 'linux',
    }

    expect(parseLanDiscoveryMessage(JSON.stringify(response))).toEqual(response)
  })

  test('ignores malformed or unrelated LAN discovery packets', () => {
    expect(parseLanDiscoveryMessage('not json')).toBeNull()
    expect(parseLanDiscoveryMessage(JSON.stringify({
      protocol: 'another-service',
      version: 1,
      type: 'query',
      nonce: '0123456789abcdef01234567',
    }))).toBeNull()
    expect(parseLanDiscoveryMessage(JSON.stringify({
      protocol: 'solus-discovery',
      version: 1,
      type: 'response',
      nonce: '0123456789abcdef01234567',
      port: 70_000,
      name: 'invalid-server',
      installationId: 'remote-installation',
    }))).toBeNull()
  })

  test('a scan keeps one answer per host to its own query, never the scanner itself', () => {
    const nonce = '0123456789abcdef01234567'
    const answer = (installationId: string, answerNonce = nonce) =>
      JSON.stringify(discoveryResponse(answerNonce, { port: 3000, name: installationId, installationId, os: 'linux' }))
    const servers = discoveredServersFrom([
      { address: '10.0.0.5', text: answer('box') },
      { address: '10.0.0.6', text: answer('box') },
      { address: '10.0.0.7', text: answer('stale', 'ffffffffffffffffffffffff') },
      { address: '10.0.0.8', text: answer('self') },
      { address: '10.0.0.9', text: JSON.stringify(discoveryQuery(nonce)) },
    ], nonce, 'self')
    expect(servers).toEqual([
      { host: '10.0.0.5', port: 3000, name: 'box', installationId: 'box', os: 'linux', source: 'lan' },
    ])
  })

  test('a phone reaches its whole /24 without broadcast', () => {
    const home = [{ address: '192.168.1.20', netmask: '255.255.255.0' }]
    expect(lanBroadcastAddresses(home)).toEqual(['255.255.255.255', '192.168.1.255'])
    const sweep = lanSweepAddresses(home)
    expect(sweep).toHaveLength(253)
    expect(sweep).toContain('192.168.1.1')
    expect(sweep).toContain('192.168.1.254')
    expect(sweep).not.toContain('192.168.1.20')
    expect(sweep).not.toContain('192.168.1.255')
    // A wide network is swept only in the phone's own /24.
    const office = lanSweepAddresses([{ address: '10.10.1.50', netmask: '255.255.0.0' }])
    expect(office).toHaveLength(253)
    expect(office).toContain('10.10.1.79')
    // A point-to-point link has no neighbours to sweep.
    expect(lanSweepAddresses([{ address: '10.0.0.1', netmask: '255.255.255.255' }])).toEqual([])
  })

  test('parses online Tailscale peers with IPv4 tailnet addresses', () => {
    const fixture = {
      Peer: {
        a: {
          Online: true,
          HostName: 'studio-mac',
          TailscaleIPs: ['100.64.0.11', 'fd7a:115c:a1e0::11'],
        },
        b: {
          Online: false,
          HostName: 'offline-box',
          TailscaleIPs: ['100.64.0.12'],
        },
        c: {
          Online: true,
          DNSName: 'linux.tailnet.ts.net.',
          TailscaleIPs: ['fd7a:115c:a1e0::13'],
        },
        d: {
          Online: true,
          HostName: '',
          DNSName: 'daemon.tailnet.ts.net.',
          TailscaleIPs: ['100.64.0.14'],
        },
      },
    }

    expect(parseTailscalePeerCandidates(fixture)).toEqual([
      { host: '100.64.0.11', name: 'studio-mac' },
      { host: '100.64.0.14', name: 'daemon.tailnet.ts.net' },
    ])
  })

  test('derives only a valid IPv4 endpoint from local Tailscale status', () => {
    expect(tailnetEndpointFromStatus({
      Self: { TailscaleIPs: ['fd7a:115c:a1e0::1', '100.64.0.9'] },
    }, 3000)).toEqual({
      kind: 'tailnet',
      label: 'Tailnet (100.64.0.9)',
      host: '100.64.0.9',
      port: 3000,
    })
    expect(tailnetEndpointFromStatus({ Self: { TailscaleIPs: ['fd7a:115c:a1e0::1'] } }, 3000)).toBeNull()
    expect(tailnetEndpointFromStatus(null, 3000)).toBeNull()
  })

  test('keeps previously toasted hosts visible while excluding saved, self, and duplicate sightings', () => {
    const discovered: DiscoveredServer[] = [
      server('100.64.0.10', 'self-installation'),
      server('100.64.0.11', 'saved-installation'),
      server('100.64.0.12', 'snoozed-installation'),
      server('100.64.0.13', 'new-installation'),
      server('100.64.0.14', 'new-installation'),
    ]

    expect(filterUnsavedDiscoveredServers({
      discovered,
      savedServers: [{
        id: 'saved-installation',
        label: 'Saved',
        url: 'http://100.64.0.11:3000',
        sessionToken: 'token',
        installationId: 'saved-installation',
        lastConnected: 1,
      }],
      selfInstallationId: 'self-installation',
    })).toEqual([
      server('100.64.0.12', 'snoozed-installation'),
      server('100.64.0.13', 'new-installation'),
    ])
  })

  test('keeps a nearby host through a missed UDP window, then evicts it at the visibility TTL', () => {
    const nearbyServer = server('100.64.0.11', 'nearby-installation')
    const firstSeenAt = 10_000
    const known = new Map([
      [nearbyServer.installationId, { server: nearbyServer, lastSeenAt: firstSeenAt }],
    ])

    expect(mergeNearbyHosts(known, [], firstSeenAt + NEARBY_HOST_TTL_MS - 1)).toEqual([
      { server: nearbyServer, lastSeenAt: firstSeenAt },
    ])
    expect(mergeNearbyHosts(known, [], firstSeenAt + NEARBY_HOST_TTL_MS)).toEqual([])
  })

  test('refreshes a re-sighted host so transient scan misses do not expire an active machine', () => {
    const oldSighting = server('100.64.0.11', 'nearby-installation')
    const refreshedSighting = {
      ...oldSighting,
      host: '100.64.0.12',
      name: 'renamed-host',
      source: 'lan' as const,
    }
    const known = new Map([
      [oldSighting.installationId, { server: oldSighting, lastSeenAt: 10_000 }],
    ])

    expect(mergeNearbyHosts(known, [refreshedSighting], 20_000)).toEqual([
      { server: refreshedSighting, lastSeenAt: 20_000 },
    ])
  })

  test('sorts nearby hosts alphabetically', () => {
    const alpha = { ...server('100.64.0.11', 'alpha-installation'), name: 'Alpha' }
    const zeta = { ...server('100.64.0.12', 'zeta-installation'), name: 'Zeta' }
    const beta = { ...server('100.64.0.13', 'beta-installation'), name: 'Beta' }

    expect(mergeNearbyHosts(new Map(), [alpha, zeta, beta], 10_000)
      .map(({ server }) => server.installationId)).toEqual([
      'alpha-installation',
      'beta-installation',
      'zeta-installation',
    ])
  })
})

describe('host operating system', () => {
  test('maps Node platform names to the persisted host values', async () => {
    // WHY: stored values are a durable client contract, not Node-specific
    // platform strings. Unknown future platforms must keep the globe fallback.
    const { hostOperatingSystem } = await import('@solus/server/platform/host-operating-system')
    expect(hostOperatingSystem('darwin')).toBe('macos')
    expect(hostOperatingSystem('win32')).toBe('windows')
    expect(hostOperatingSystem('linux')).toBe('linux')
    expect(hostOperatingSystem('aix')).toBeUndefined()
  })
})

function server(host: string, installationId: string): DiscoveredServer {
  return {
    host,
    port: 3000,
    name: host,
    installationId,
    source: 'tailnet',
  }
}
