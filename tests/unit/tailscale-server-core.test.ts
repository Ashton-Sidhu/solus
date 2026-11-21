import { expect, test, mock } from 'bun:test'
import type { NetworkInterfaceInfo } from 'os'
import { DatabaseSync } from './helpers/bun-sqlite'

// Bun has no node:sqlite; this code reaches the database through the host's installation id (admission/auth.ts).
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { detectCloudMachine } = await import('@solus/server/host/cloud-machine')
const { cloudRoutes, discoverTailnetServers, tailnetAddressesFromStatus, tailnetEndpointFromInterfaces } = await import('@solus/server/transport/endpoints')

function address(address: string, family: 'IPv4' | 'IPv6'): NetworkInterfaceInfo {
  return { address, family, internal: false, mac: '00:00:00:00:00:00', netmask: family === 'IPv4' ? '255.255.255.255' : 'ffff:ffff:ffff:ffff::', cidr: null }
}

test('an interface needs both Tailscale ranges to identify this machine', () => {
  const paired = [address('100.87.157.17', 'IPv4'), address('fd7a:115c:a1e0::1', 'IPv6')]
  expect(tailnetEndpointFromInterfaces({ utun1: paired }, 3001)).toMatchObject({ kind: 'tailnet', host: '100.87.157.17', port: 3001 })
  expect(tailnetEndpointFromInterfaces({ utun1: [paired[0]], utun2: [paired[1]] }, 3001)).toBeNull()
  expect(tailnetEndpointFromInterfaces({ vpn0: [address('100.127.1.1', 'IPv4'), address('fd00::1', 'IPv6')] }, 3001)).toBeNull()
})

test('tailnet trust includes self and own peers but excludes shared and foreign peers', () => {
  const status = {
    Self: { UserID: 7, TailscaleIPs: ['100.64.0.1'] },
    Peer: {
      own: { UserID: 7, TailscaleIPs: ['100.64.0.2'] },
      shared: { UserID: 7, ShareeNode: true, TailscaleIPs: ['100.64.0.3'] },
      foreign: { UserID: 8, TailscaleIPs: ['100.64.0.4'] },
    },
  }
  expect([...tailnetAddressesFromStatus(status)]).toEqual(['100.64.0.1', '100.64.0.2'])
  expect([...tailnetAddressesFromStatus({ Peer: status.Peer })]).toEqual([])
})

test('cloud metadata checks all providers and accepts any response', async () => {
  const requests: { url: string; method: string; headers: Headers }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
    if (String(input).includes('computeMetadata')) return new Response('', { status: 404 })
    throw new Error('unavailable')
  }
  expect(await detectCloudMachine(fetchImpl)).toBe(true)
  expect(requests).toHaveLength(3)
  expect(requests[0].method).toBe('PUT')
  expect(requests[1].headers.get('Metadata-Flavor')).toBe('Google')
  expect(requests[2].headers.get('Metadata')).toBe('true')
  expect(await detectCloudMachine(async () => { throw new Error('unavailable') })).toBe(false)
})

test('cloud routes keep only tailnet, but preserve current routes without it', () => {
  const lan = { kind: 'lan' as const, url: 'http://10.0.0.2:3000' }
  const tailnet = { kind: 'tailnet' as const, url: 'http://100.64.0.2:3000' }
  expect(cloudRoutes([lan, tailnet], true)).toEqual([tailnet])
  expect(cloudRoutes([lan], true)).toEqual([lan])
  expect(cloudRoutes([lan, tailnet], false)).toEqual([lan, tailnet])
})

test('tailnet discovery probes the standalone, desktop, and bound ports', async () => {
  const oldPort = process.env.SOLUS_PORT
  const seen: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    seen.push(String(input))
    return new Response(JSON.stringify({ installationId: String(input).includes(':3001') ? 'found' : 'own' }), { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    // SOLUS_PORT is captured at module load. The test checks the stable ports and bound port.
    const found = await discoverTailnetServers({
      boundPort: 4321, ownInstallationId: 'own', fetchImpl,
      status: { Peer: { phone: { Online: true, HostName: 'localhost', DNSName: 'iphone.tailnet.ts.net.', TailscaleIPs: ['100.64.0.20'] } } },
    })
    expect(seen).toContain('http://100.64.0.20:3000/health')
    expect(seen).toContain('http://100.64.0.20:3001/health')
    expect(seen).toContain('http://100.64.0.20:4321/health')
    expect(found).toEqual([{ host: '100.64.0.20', port: 3001, name: 'iphone', installationId: 'found', os: undefined, source: 'tailnet' }])
  } finally {
    if (oldPort === undefined) delete process.env.SOLUS_PORT
    else process.env.SOLUS_PORT = oldPort
  }
})
