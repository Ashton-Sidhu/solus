import { describe, expect, test } from 'bun:test'
import { parseTailscalePeerCandidates } from '../../src/main/server/endpoints'
import { filterNewDiscoveredServers } from '../../src/renderer/components/servers/discovery'
import type { DiscoveredServer } from '../../src/shared/types'

describe('server discovery', () => {
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

  test('filters discovered servers already registered, dismissed, or self', () => {
    const discovered: DiscoveredServer[] = [
      server('100.64.0.10', 'self-installation'),
      server('100.64.0.11', 'saved-installation'),
      server('100.64.0.12', 'dismissed-installation'),
      server('100.64.0.13', 'new-installation'),
      server('100.64.0.14', 'new-installation'),
    ]

    expect(filterNewDiscoveredServers({
      discovered,
      savedServers: [{
        id: 'saved-installation',
        label: 'Saved',
        url: 'http://100.64.0.11:3000',
        sessionToken: 'token',
        installationId: 'saved-installation',
        lastConnected: 1,
      }],
      dismissedInstallationIds: new Set(['dismissed-installation']),
      selfInstallationId: 'self-installation',
    })).toEqual([server('100.64.0.13', 'new-installation')])
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
