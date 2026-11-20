import { expect, test, mock } from 'bun:test'
import type { NetworkInterfaceInfo } from 'os'
import { DatabaseSync } from './helpers/bun-sqlite'

// Bun has no node:sqlite; this code reaches the database through the host's installation id (admission/auth.ts).
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { statusWhileAddressHeld } = await import('@solus/server/transport/endpoints')

const lastRead = { Self: { TailscaleIPs: ['100.87.157.17', 'fd7a:115c:a1e0::9a01:a8e1'] } }

function ipv4(address: string): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.255', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/32` }
}

test('a failed status read keeps the tailnet while this machine still holds its Tailscale address', () => {
  // WHY: `tailscale status` fails when no local port is free. Treating that as
  // "no tailnet" put only the LAN address in the pairing link, so a phone off
  // the LAN could not pair or reach the host.
  expect(statusWhileAddressHeld(lastRead, { en0: [ipv4('10.10.1.219')], utun6: [ipv4('100.87.157.17')] })).toBe(lastRead)
})

test('a failed status read drops the tailnet once the Tailscale address is gone', () => {
  // WHY: with Tailscale off, its peers' addresses must not stay trusted.
  expect(statusWhileAddressHeld(lastRead, { en0: [ipv4('10.10.1.219')] })).toBeNull()
  expect(statusWhileAddressHeld(null, { utun6: [ipv4('100.87.157.17')] })).toBeNull()
})
