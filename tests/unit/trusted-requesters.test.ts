import { describe, expect, test } from 'bun:test'
import { isPrivateLanAddress, isTrustedRequesterAddress } from '../../src/main/server/trusted-requesters'

// Per-requester trust is what lets the served web client connect to its own
// origin without a pairing code even on a require-auth bind. Loopback is the
// invariant half of that policy (the tailnet half depends on a live tailscale
// daemon, and the LAN half on the trust-local-network server setting, so
// neither is asserted end-to-end here).
describe('trusted requester addresses', () => {
  test('the machine itself is always trusted — a loopback caller already owns the data dir', async () => {
    expect(await isTrustedRequesterAddress('127.0.0.1')).toBe(true)
    expect(await isTrustedRequesterAddress('::1')).toBe(true)
    expect(await isTrustedRequesterAddress('::ffff:127.0.0.1')).toBe(true)
  })

  test('a missing address is never trusted', async () => {
    expect(await isTrustedRequesterAddress(undefined)).toBe(false)
  })
})

// The trust-local-network setting widens trust to exactly these ranges; a
// public address must never qualify no matter what the owner opted into.
describe('private LAN addresses', () => {
  test('covers RFC1918, link-local, and IPv6 local ranges', () => {
    expect(isPrivateLanAddress('10.0.0.5')).toBe(true)
    expect(isPrivateLanAddress('192.168.1.42')).toBe(true)
    expect(isPrivateLanAddress('172.16.0.1')).toBe(true)
    expect(isPrivateLanAddress('172.31.255.1')).toBe(true)
    expect(isPrivateLanAddress('169.254.10.10')).toBe(true)
    expect(isPrivateLanAddress('fe80::1')).toBe(true)
    expect(isPrivateLanAddress('fd7a:115c:a1e0::1')).toBe(true)
  })

  test('public and near-miss addresses stay outside', () => {
    expect(isPrivateLanAddress('8.8.8.8')).toBe(false)
    expect(isPrivateLanAddress('172.32.0.1')).toBe(false)
    expect(isPrivateLanAddress('172.15.0.1')).toBe(false)
    expect(isPrivateLanAddress('100.100.1.1')).toBe(false)
    expect(isPrivateLanAddress('2600:1700::1')).toBe(false)
  })
})
