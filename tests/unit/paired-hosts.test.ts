import { describe, expect, test } from 'bun:test'
import { canReadPairings, pairedHostRoute, pairingHealthState, pairingHealthText } from '@solus/client-core/paired-hosts'
import type { HostPairingHealth } from '@solus/contracts/host-pairing'

// WHY: docs/host-pairing.md, "Pairing health". A person sees a pairing that will
// not work before an agent tries it, and a pairing names its real route kind.

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

function health(change: Partial<HostPairingHealth> = {}): HostPairingHealth {
  return { lastReachedAt: NOW - DAY, lastError: null, expiresAt: NOW + 20 * DAY, ...change }
}

describe('the health of a pairing', () => {
  test('a pairing whose last use worked is working, and says when it ends within a week', () => {
    expect(pairingHealthText(pairingHealthState(health(), NOW))).toBe('Working')
    expect(pairingHealthText(pairingHealthState(health({ expiresAt: NOW + 3 * DAY }), NOW))).toBe('Expires in 3 days')
  })

  test('a pairing whose last use failed is failing, with the reason', () => {
    expect(pairingHealthState(health({ lastError: 'It refused the credential of this pairing.' }), NOW))
      .toEqual({ kind: 'failing', detail: 'It refused the credential of this pairing.' })
  })

  test('an ended pairing is expired, and a host that sends no health says so', () => {
    expect(pairingHealthState(health({ expiresAt: null }), NOW).kind).toBe('expired')
    expect(pairingHealthState(health({ expiresAt: NOW }), NOW).kind).toBe('expired')
    expect(pairingHealthText(pairingHealthState(undefined, NOW))).toBe('Health unknown')
  })
})

test('only the local owner reads the pairings of a host', () => {
  expect(canReadPairings({ principal: 'local-owner', permissions: ['host.local.reach'] })).toBe(true)
  expect(canReadPairings({ principal: 'remote-owner', permissions: ['host.local.reach'] })).toBe(false)
  expect(canReadPairings({ principal: 'local-owner', permissions: ['read.transcript'] })).toBe(false)
})

test('a pairing names the route kind its saved route has, so a Tailscale address is not a VPN', () => {
  const url = 'http://100.101.4.12:7777'
  const tailnet = { listing: { id: 'mini', installationId: 'mini', label: 'mini', routes: [{ kind: 'tailnet' as const, url }], lastConnected: 0 }, pairedAt: 1, url }
  expect(pairedHostRoute(tailnet)?.kind).toBe('tailnet')
  expect(pairedHostRoute({ ...tailnet, listing: { ...tailnet.listing, routes: [] } })?.url).toBe(url)
})
