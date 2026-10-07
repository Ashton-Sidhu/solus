import { describe, expect, test } from 'bun:test'
import type { HostConnectionState } from '../../apps/mobile/src/features/hosts/host-connections'
import type { NativeHost } from '../../apps/mobile/src/features/hosts/host-registry'
import {
  connectHostAction,
  connectHostHeadline,
  newTaskHostGate,
} from '../../apps/mobile/src/features/threads/new-task-host-gate'

// The new-task sheet shows the connect-a-host screen in place of its composer
// when no host can run the task (docs/plans/draft-connect-host.md). It must
// never take the composer away on a guess: only the supervisor's "offline"
// after its retry ladder, or no host at all, counts.

const host = (overrides: Partial<NativeHost> = {}): NativeHost => ({
  id: 'bills',
  label: 'Bills',
  routes: [{ kind: 'direct', url: 'http://10.0.0.8:51234' }],
  lastConnected: 0,
  paired: true,
  ...overrides,
})

const state = (phase: HostConnectionState['phase']): HostConnectionState => ({
  phase,
  attempt: 0,
  blockedReason: null,
  sessionGeneration: 0,
})

describe('the new-task host gate', () => {
  test('one connected host is enough to compose', () => {
    expect(newTaskHostGate(['offline', 'connected'])).toBe('compose')
  })

  test('no host at all asks for one', () => {
    expect(newTaskHostGate([])).toBe('connect')
  })

  test('every host offline, stopped, or refused asks for one', () => {
    expect(newTaskHostGate(['offline', 'blocked', 'waiting-for-compute', 'no-route'])).toBe('connect')
  })

  test('a host still dialing keeps the composer', () => {
    expect(newTaskHostGate(['offline', 'reconnecting'])).toBe('compose')
  })

  test('a host not yet dialed keeps the composer, because nothing is known yet', () => {
    expect(newTaskHostGate([null])).toBe('compose')
  })
})

describe('a host card on the connect screen', () => {
  test('an offline host offers a retry', () => {
    expect(connectHostAction(host(), state('offline'))).toBe('retry')
  })

  test('a dialing host has nothing to do but wait', () => {
    expect(connectHostAction(host(), state('connecting'))).toBeNull()
  })

  test('a stopped cloud host offers to start it, not to retry it', () => {
    const stopped = host({ uplink: { kind: 'managed', hostId: 'h1', directoryUrl: 'https://app.solus.sh', managedState: 'stopped' } })
    expect(connectHostAction(stopped, state('waiting-for-compute'))).toBe('start')
  })

  test('a refused host must be paired again', () => {
    expect(connectHostAction(host(), state('blocked'))).toBe('pair-again')
  })
})

describe('the connect screen headline', () => {
  test('names a single offline host so the person knows which machine to wake', () => {
    expect(connectHostHeadline([host()], null)).toBe('Bills is offline')
  })

  test('asks for a first host when none is saved', () => {
    expect(connectHostHeadline([], null)).toBe('Connect a host to start')
  })
})
