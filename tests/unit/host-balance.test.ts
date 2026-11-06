import { describe, expect, test } from 'bun:test'
import { checkBalancedHost, chooseBalancedHost, hostBalanceKey, hostBalancePreference, withHostBalancePreference } from '@solus/client-core/host-balance'
import type { HostResources } from '@solus/contracts/host-resources'

// Auto balance moves a person's work to a machine they did not name, so a
// wrong choice is costly: it must never pick a full host, a host they kept for
// manual use, or a host that did not answer.

function load(change: Partial<HostResources> = {}): HostResources {
  return { sampledAt: 1, cpuUtilization: 0.2, cpuCount: 8, availableMemoryBytes: 8, totalMemoryBytes: 16, ...change }
}

describe('chooseBalancedHost', () => {
  test('prefers the host with more free capacity', () => {
    expect(chooseBalancedHost([
      { hostId: 'busy', preference: 'normal', resources: load({ cpuUtilization: 0.8 }) },
      { hostId: 'idle', preference: 'normal', resources: load({ cpuUtilization: 0.1 }) },
    ])).toBe('idle')
  })

  test('a preference moves the choice, but it is not a fixed share', () => {
    const pair = (preference: 'prefer' | 'less') => [
      { hostId: 'chosen', preference, resources: load({ cpuUtilization: 0.5 }) },
      { hostId: 'other', preference: 'normal' as const, resources: load({ cpuUtilization: 0.4 }) },
    ]
    expect(chooseBalancedHost(pair('prefer'))).toBe('chosen')
    expect(chooseBalancedHost(pair('less'))).toBe('other')
  })

  test('never chooses Manual only, however idle the host is', () => {
    expect(chooseBalancedHost([
      { hostId: 'kept', preference: 'manual', resources: load({ cpuUtilization: 0, cpuCount: 128 }) },
      { hostId: 'other', preference: 'less', resources: load({ cpuUtilization: 0.9 }) },
    ])).toBe('other')
  })

  test('a full host is not chosen, so a person chooses when all are full', () => {
    expect(chooseBalancedHost([
      { hostId: 'cpu', preference: 'prefer', resources: load({ cpuUtilization: 0.95 }) },
      { hostId: 'memory', preference: 'prefer', resources: load({ availableMemoryBytes: 0.8 }) },
    ])).toBeNull()
  })

  test('a host with no answer or no CPU reading is not chosen', () => {
    expect(chooseBalancedHost([
      { hostId: 'silent', preference: 'normal', resources: null },
      { hostId: 'unmeasured', preference: 'normal', resources: load({ cpuUtilization: null }) },
    ])).toBeNull()
  })
})

describe('checkBalancedHost', () => {
  test('a host that fails or hangs does not stop the choice among the others', async () => {
    const chosen = await checkBalancedHost([
      { hostId: 'failed', preference: 'prefer', read: () => Promise.reject(new Error('down')) },
      { hostId: 'hung', preference: 'prefer', read: () => new Promise(() => {}) },
      { hostId: 'up', preference: 'less', read: async () => load() },
    ], 10)
    expect(chosen).toBe('up')
  })
})

describe('balance preferences', () => {
  const desktopLocal = { id: 'local', installationId: 'install-1' }

  test('name a host by its installation id, so each client reads the same key', () => {
    const balancing = withHostBalancePreference({ enabled: true, preferences: {} }, desktopLocal, 'prefer')
    expect(balancing.preferences).toEqual({ 'install-1': 'prefer' })
    // Mobile knows the same host by its installation id alone.
    expect(hostBalancePreference(balancing, { id: 'install-1' })).toBe('prefer')
  })

  test('a host with no installation id yet keeps its preference on this client', () => {
    expect(hostBalanceKey({ id: 'server-2' })).toBe('server-2')
  })

  test('normal is the default and stores nothing, so the synced document stays small', () => {
    const balancing = withHostBalancePreference({ enabled: true, preferences: { 'install-1': 'less' } }, desktopLocal, 'normal')
    expect(balancing.preferences).toEqual({})
  })
})
