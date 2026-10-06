import { describe, expect, test } from 'bun:test'
import { hostConnectionStatus, hostDisplayAddress, hostMachineKind } from '../../apps/mobile/src/features/connection/lib/host-connection-status'
import type { HostConnectionState } from '../../apps/mobile/src/features/hosts/host-connections'
import type { NativeHost } from '../../apps/mobile/src/features/hosts/host-registry'

const host = (overrides: Partial<NativeHost> = {}): NativeHost => ({
  id: 'inst-a',
  label: 'Studio Mac',
  routes: [{ kind: 'direct', url: 'http://10.0.0.8:51234' }],
  lastConnected: 0,
  paired: true,
  ...overrides,
})

const state = (phase: HostConnectionState['phase'], blockedReason: HostConnectionState['blockedReason'] = null): HostConnectionState =>
  ({ phase, attempt: 0, blockedReason, sessionGeneration: 0 })

describe('host connection rows', () => {
  test('a host that refuses this device is a failure that names the way out', () => {
    expect(hostConnectionStatus(host(), state('blocked', 'auth'))).toEqual({ dot: 'error', text: 'Access ended. Pair again.', failed: true, retrying: false })
    expect(hostConnectionStatus(host({ paired: false }), state('blocked', 'auth')).text).toBe('Access refused')
    expect(hostConnectionStatus(host(), state('blocked', 'identity-mismatch')).text).toBe('A different machine answered at this address')
  })

  test('only a dial in progress pulses; a stopped host is not a failure', () => {
    expect(hostConnectionStatus(host(), state('connecting')).retrying).toBe(true)
    expect(hostConnectionStatus(host(), state('reconnecting')).retrying).toBe(true)
    expect(hostConnectionStatus(host(), state('offline'))).toMatchObject({ failed: true, retrying: false })
    expect(hostConnectionStatus(host(), state('waiting-for-compute'))).toMatchObject({ dot: 'available', failed: false })
    expect(hostConnectionStatus(host(), null)).toMatchObject({ dot: 'available', text: 'Not connected' })
  })

  test('a paired host shows the address it was reached at; a cloud host shows none', () => {
    expect(hostDisplayAddress(host())).toBe('10.0.0.8:51234')
    expect(hostDisplayAddress(host({ routes: [{ kind: 'tunnel', url: 'https://build.tunnel.solus.sh' }] }))).toBeNull()
  })

  test('a managed cloud host wears the cloud glyph', () => {
    expect(hostMachineKind(host({ uplink: { hostId: 'h', directoryUrl: 'https://d', kind: 'managed' } }))).toBe('cloud')
    expect(hostMachineKind(host({ os: 'linux' }))).toBe('linux')
    expect(hostMachineKind(host({ os: 'macos' }))).toBe('desktop')
  })
})
