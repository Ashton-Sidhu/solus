import { describe, expect, test } from 'bun:test'
import { parseTailscalePeerCandidates } from '../../src/main/server/endpoints'
import { parseLanDiscoveryMessage } from '../../src/main/server/lan-discovery'
import {
  filterUnsavedDiscoveredServers,
  mergeNearbyHosts,
  NEARBY_HOST_TTL_MS,
  unannouncedDiscoveredServers,
} from '../../src/renderer/contexts/connections/discovery'
import type { DiscoveredServer } from '../../src/shared/types'

describe('server discovery', () => {
  test('accepts a valid LAN discovery response', () => {
    const response = {
      protocol: 'solus-discovery',
      version: 1,
      type: 'response',
      nonce: '0123456789abcdef01234567',
      port: 3000,
      name: 'build-server',
      installationId: 'remote-installation',
      claimable: true,
    }

    expect(parseLanDiscoveryMessage(Buffer.from(JSON.stringify(response)))).toEqual(response)
  })

  test('ignores malformed or unrelated LAN discovery packets', () => {
    expect(parseLanDiscoveryMessage(Buffer.from('not json'))).toBeNull()
    expect(parseLanDiscoveryMessage(Buffer.from(JSON.stringify({
      protocol: 'another-service',
      version: 1,
      type: 'query',
      nonce: '0123456789abcdef01234567',
    })))).toBeNull()
    expect(parseLanDiscoveryMessage(Buffer.from(JSON.stringify({
      protocol: 'solus-discovery',
      version: 1,
      type: 'response',
      nonce: '0123456789abcdef01234567',
      port: 70_000,
      name: 'invalid-server',
      installationId: 'remote-installation',
      claimable: true,
    })))).toBeNull()
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

  test('announces every new host in a scan so simultaneous discoveries are not lost', () => {
    const first = server('100.64.0.11', 'first-installation')
    const second = server('100.64.0.12', 'second-installation')
    const third = server('100.64.0.13', 'third-installation')
    const announced = new Set([first.installationId])

    expect(unannouncedDiscoveredServers([first, second, third], announced)).toEqual([second, third])

    announced.add(second.installationId)
    announced.add(third.installationId)
    expect(unannouncedDiscoveredServers([first, second, third], announced)).toEqual([])
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

  test('sorts claimable hosts first so machines ready to connect stay actionable', () => {
    const paired = { ...server('100.64.0.11', 'paired-installation'), name: 'Alpha', claimable: false }
    const claimableZeta = { ...server('100.64.0.12', 'zeta-installation'), name: 'Zeta' }
    const claimableBeta = { ...server('100.64.0.13', 'beta-installation'), name: 'Beta' }

    expect(mergeNearbyHosts(new Map(), [paired, claimableZeta, claimableBeta], 10_000)
      .map(({ server }) => server.installationId)).toEqual([
      'beta-installation',
      'zeta-installation',
      'paired-installation',
    ])
  })
})

function server(host: string, installationId: string): DiscoveredServer {
  return {
    host,
    port: 3000,
    name: host,
    installationId,
    claimable: true,
    source: 'tailnet',
  }
}
