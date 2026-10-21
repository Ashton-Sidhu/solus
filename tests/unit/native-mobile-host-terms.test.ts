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

describe('native Home while a host sets this person up (docs/plans/member-isolation.md §8.1)', () => {
  test('says it is setting up the workspace, and names no host', () => {
    const state = empty([{ ...host('Studio', 'connected'), isPreparing: true }])
    expect(state).toMatchObject({ title: 'Setting up your workspace for the first time', action: null, loading: true })
    expect(state.detail).not.toContain('Studio')
  })

  test('a ready host wins over one still setting up', () => {
    const state = empty([{ ...host('Studio', 'connected'), isPreparing: true }, host('Laptop', 'connected')])
    expect(state.title).not.toBe('Setting up your workspace for the first time')
  })
})


describe('native Home distinguishes a list failure from a lost connection', () => {
  const message = '[RPC error] Could not read sessions'
  const previous = { threads: [], projects: [], indexing: false } as const

  test('a connected host with a failed read shows a warning and keeps the error out of the header', () => {
    const catalog = deriveWorkspaceState([host('Studio', 'connected', { kind: 'error', message, previous: null })])
    expect(catalog.hasReadyEnvironment).toBe(true)
    expect(workspaceConnectionStatusPresentation(catalog)).toEqual({ label: 'Could not load threads', kind: 'load-error' })
    expect(deriveHomeEmptyState({ catalogState: catalog, projectCount: 0 })).toMatchObject({
      title: 'Could not load threads', loading: false, action: 'retry-hosts',
    })
    expect(deriveHomeEmptyState({ catalogState: catalog, projectCount: 0 }).detail).toContain(message)
  })

  test('a failed refresh of an empty list does not claim there are no threads or projects', () => {
    for (const projectCount of [0, 2]) {
      expect(empty([host('Studio', 'connected', { kind: 'error', message, previous })], projectCount))
        .toMatchObject({ title: 'Could not load threads', action: 'retry-hosts' })
    }
  })

  test('retrying and recovering clear the warning', () => {
    const catalog = deriveWorkspaceState([host('Studio', 'connected', { kind: 'loading', previous: null })])
    expect(workspaceConnectionStatusPresentation(catalog)).toEqual({ label: 'Loading threads...', kind: 'progress' })
    expect(empty([host('Studio', 'connected', { kind: 'loading', previous: null })]).loading).toBe(true)
    const recovered = deriveWorkspaceState([host('Studio', 'connected', { kind: 'loaded', value: previous })])
    expect(workspaceConnectionStatusPresentation(recovered)).toBeNull()
    expect(deriveHomeEmptyState({ catalogState: recovered, projectCount: 2 }).title).toBe('No threads yet')
  })

  test('a connected host that failed to load keeps its warning while another host reconnects', () => {
    // WHY: the header speaks for the host the list comes from. A second
    // host's retry is on the Hosts screen (pingdotgg/t3code#21388).
    const catalog = deriveWorkspaceState([
      host('Studio', 'connected', { kind: 'error', message, previous: null }),
      host('Laptop', 'reconnecting'),
    ])
    expect(workspaceConnectionStatusPresentation(catalog)).toEqual({ label: 'Could not load threads', kind: 'load-error' })
  })
})

describe('native Home header keeps the brand while a second host retries (pingdotgg/t3code#21388)', () => {
  const loaded = { kind: 'loaded', value: { threads: [], projects: [], indexing: false } } as const

  test('a usable host keeps the brand while another host connects, reconnects, or is offline', () => {
    // WHY: a sleeping laptop must not replace the brand with "Reconnecting"
    // while the Mac it sits beside lists threads and runs work.
    for (const phase of ['connecting', 'reconnecting', 'offline', 'blocked', undefined] as const) {
      const catalog = deriveWorkspaceState([host('Studio', 'connected', loaded), host('Laptop', phase)])
      expect(workspaceConnectionStatusPresentation(catalog)).toBeNull()
    }
  })

  test('a usable host still shows its own list loading while another host is down', () => {
    const catalog = deriveWorkspaceState([
      host('Studio', 'connected', { kind: 'loading', previous: loaded.value }),
      host('Laptop', 'reconnecting'),
    ])
    expect(workspaceConnectionStatusPresentation(catalog)).toEqual({ label: 'Syncing threads...', kind: 'progress' })
  })

  test('with no usable host, the header still says the hosts reconnect or are not connected', () => {
    expect(workspaceConnectionStatusPresentation(deriveWorkspaceState([host('Laptop', 'reconnecting')])))
      .toEqual({ label: 'Reconnecting to Laptop', kind: 'progress' })
    expect(workspaceConnectionStatusPresentation(deriveWorkspaceState([host('Laptop', 'offline')])))
      .toEqual({ label: 'Not connected', kind: 'offline' })
  })
})
