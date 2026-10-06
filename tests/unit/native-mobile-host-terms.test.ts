import { describe, expect, test } from 'bun:test'
import { hostConnectionStatus } from '../../apps/mobile/src/features/connection/lib/host-connection-status'
import { deriveHomeEmptyState } from '../../apps/mobile/src/features/home/home-empty-state'
import { deriveWorkspaceState, workspaceConnectionStatusPresentation, type WorkspaceHostState } from '../../apps/mobile/src/features/home/workspace-connection-status'
import type { HostConnectionState } from '../../apps/mobile/src/features/hosts/host-connections'
import type { NativeHost } from '../../apps/mobile/src/features/hosts/host-registry'

const host = (label: string, phase: WorkspaceHostState['phase'], threads: WorkspaceHostState['threads'] = { kind: 'idle' }): WorkspaceHostState => ({ label, phase, threads })
const empty = (hosts: WorkspaceHostState[], projectCount = 0) => deriveHomeEmptyState({ catalogState: deriveWorkspaceState(hosts), projectCount })

describe('native Home empty state speaks of hosts and offers the right way out', () => {
  test('no saved host: add one', () => {
    expect(empty([])).toMatchObject({ title: 'No hosts connected', action: 'add-host' })
  })

  test('a saved host that does not answer is tried again, not paired a second time', () => {
    const state = empty([host('Studio', 'offline')])
    expect(state).toMatchObject({ title: 'Host unavailable', action: 'retry-hosts', loading: false })
  })

  test('while the host connects there is nothing to press', () => {
    expect(empty([host('Studio', 'connecting')])).toMatchObject({ title: 'Connecting to your host', action: null, loading: true })
  })

  test('no user-facing state says "environment"', () => {
    const states = [
      empty([]),
      empty([host('Studio', 'offline')]),
      empty([host('Studio', 'connecting')]),
      empty([host('Studio', 'connected', { kind: 'loaded', value: { threads: [], projects: [], indexing: false } })]),
      empty([host('Studio', 'connected', { kind: 'loaded', value: { threads: [], projects: [], indexing: false } })], 2),
    ]
    for (const state of states) expect(`${state.title} ${state.detail}`).not.toMatch(/environment/i)
  })

  test('the header names hosts while several reconnect', () => {
    const label = workspaceConnectionStatusPresentation(deriveWorkspaceState([host('A', 'reconnecting'), host('B', 'reconnecting')]))?.label
    expect(label).toBe('Reconnecting 2 hosts')
  })
})

describe('host row: when Try again can help', () => {
  const saved = { id: 'h', label: 'Studio', paired: true, routes: [], os: 'macos' } as unknown as NativeHost
  const state = (phase: HostConnectionState['phase'], blockedReason: HostConnectionState['blockedReason'] = null) =>
    ({ phase, attempt: 1, blockedReason, sessionGeneration: 0 }) as HostConnectionState

  test('an offline or never-dialled host can be tried again', () => {
    expect(hostConnectionStatus(saved, state('offline')).retryable).toBe(true)
    expect(hostConnectionStatus(saved, null).retryable).toBe(true)
  })

  test('a refused, stopped, or working connection offers no retry', () => {
    expect(hostConnectionStatus(saved, state('blocked', 'auth')).retryable).toBeFalsy()
    expect(hostConnectionStatus(saved, state('waiting-for-compute')).retryable).toBeFalsy()
    expect(hostConnectionStatus(saved, state('connecting')).retryable).toBeFalsy()
    expect(hostConnectionStatus(saved, state('connected')).retryable).toBeFalsy()
  })
})
