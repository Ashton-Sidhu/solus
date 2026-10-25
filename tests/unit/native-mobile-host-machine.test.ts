import { describe, expect, test } from 'bun:test'
import { hostDisplayAddress, hostMachineKind } from '../../apps/mobile/src/features/connection/lib/host-machine'
import type { NativeHost } from '../../apps/mobile/src/features/hosts/host-registry'

const host = (overrides: Partial<NativeHost> = {}): NativeHost => ({
  id: 'inst-a',
  label: 'Studio Mac',
  routes: [{ kind: 'direct', url: 'http://10.0.0.8:51234' }],
  lastConnected: 0,
  paired: true,
  ...overrides,
})

describe('host rows: the machine', () => {
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
