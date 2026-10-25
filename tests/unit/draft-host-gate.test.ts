import { describe, expect, test } from 'bun:test'
import type { HostReadiness, HostReadinessState } from '@solus/client-core/host-readiness'
import {
  connectHostHeadline,
  connectHostRow,
  draftHostGate,
  type GatedHost,
} from '@solus/workspace-ui/components/session-draft/lib/host-gate'

// A draft no host can run shows the connect-a-host page in place of its
// composer (docs/plans/draft-connect-host.md). The page must never hide the
// composer on a guess: only a known "nothing answers" replaces it, and that
// answer is the host's readiness (docs/plans/host-readiness.md).

const NOW = 1_000_000

function state(readiness: HostReadiness, overrides: Partial<HostReadinessState> = {}): HostReadinessState {
  return {
    readiness,
    away: readiness === 'unreachable' || readiness === 'refused' || readiness === 'gone',
    unreachableReason: readiness === 'unreachable' ? 'no-answer' : null,
    refusedReason: null,
    lastSeenAt: null,
    ...overrides,
  }
}

const host = (readiness: HostReadiness, overrides: Partial<GatedHost> = {}): GatedHost => ({
  id: 'bills',
  label: 'Bills',
  url: 'http://bills:4000',
  local: false,
  readiness,
  routes: [],
  state: state(readiness, { lastSeenAt: NOW - 60_000 }),
  isPreparing: false,
  ...overrides,
})

describe('the draft host gate', () => {
  test('one ready host is enough to compose', () => {
    expect(draftHostGate([host('unreachable'), host('ready', { id: 'mbp' })], 'compose')).toBe('compose')
  })

  test('no host at all asks for one', () => {
    expect(draftHostGate([], 'compose')).toBe('connect')
  })

  test('every host unreachable, refused, or gone asks for one', () => {
    expect(draftHostGate([host('unreachable'), host('refused', { id: 'mbp' }), host('gone', { id: 'old' })], 'compose')).toBe('connect')
  })

  test('a host inside its grace keeps the composer', () => {
    // WHY: a short drop or a slow first connect must not swap the page out from under the person typing.
    expect(draftHostGate([host('reconnecting')], 'compose')).toBe('compose')
    expect(draftHostGate([host('checking')], 'compose')).toBe('compose')
  })

  test('a retry from the connect page keeps the page while the host dials', () => {
    expect(draftHostGate([host('reconnecting')], 'connect')).toBe('connect')
    expect(draftHostGate([host('checking')], 'connect')).toBe('connect')
  })

  test('the composer comes back from the connect page once a host answers', () => {
    expect(draftHostGate([host('ready')], 'connect')).toBe('compose')
  })
})

describe('a host card on the connect page', () => {
  test('an offline host offers a retry and says when it was last seen', () => {
    expect(connectHostRow(host('unreachable'), NOW)).toEqual({
      hostId: 'bills',
      label: 'Bills',
      detail: 'Offline · last seen 1 min ago',
      action: 'retry',
    })
  })

  test('a host that is dialing has nothing to do but wait', () => {
    expect(connectHostRow(host('reconnecting'), NOW)).toMatchObject({ detail: 'Reconnecting…', action: null })
  })

  test('a stopped cloud host offers to start it, not to retry it', () => {
    const row = connectHostRow(host('unreachable', { uplink: { kind: 'managed', hostId: 'h1', directoryUrl: 'https://app.solus.sh', managedState: 'stopped' } }), NOW)
    expect(row).toMatchObject({ detail: 'Cloud host · stopped', action: 'start' })
  })

  test('a cloud host on its way up has no action', () => {
    const row = connectHostRow(host('checking', { uplink: { kind: 'managed', hostId: 'h1', directoryUrl: 'https://app.solus.sh', managedState: 'starting' } }), NOW)
    expect(row).toMatchObject({ detail: 'Cloud host · starting', action: null })
  })

  test('a host that answers as another server must be paired again', () => {
    const refused = host('refused', { state: state('refused', { refusedReason: 'identity-mismatch' }) })
    expect(connectHostRow(refused, NOW)).toMatchObject({ detail: 'Different server', action: 'pair-again' })
  })
})

describe('the connect page headline', () => {
  test('names the host it waits on', () => {
    expect(connectHostHeadline([host('unreachable')], 'Bills')).toBe('Connecting to Bills')
  })

  test('names a single offline host so the person knows which machine to wake', () => {
    expect(connectHostHeadline([host('unreachable')], null)).toBe('Bills is offline')
  })

  test('asks for a first host when none is saved', () => {
    expect(connectHostHeadline([], null)).toBe('Connect a host to start')
  })
})

describe('a host still setting this person up (docs/plans/member-isolation.md §8.1)', () => {
  const preparing = host('ready', { isPreparing: true })

  test('is not a host the draft can run on: the page shows, not the composer', () => {
    // WHY: a turn there is refused with WORKSPACE_PREPARING; a composer would take text it cannot send.
    expect(draftHostGate([preparing], 'compose')).toBe('connect')
    expect(connectHostHeadline([preparing], null)).toBe('Setting up your workspace for the first time')
  })

  test('another host that is ready is enough to compose', () => {
    expect(draftHostGate([preparing, host('ready', { id: 'mbp' })], 'compose')).toBe('compose')
  })

  test('the composer comes back once the host is ready', () => {
    expect(draftHostGate([{ ...preparing, isPreparing: false }], 'compose')).toBe('compose')
  })
})
