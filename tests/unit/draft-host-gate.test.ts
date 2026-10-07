import { describe, expect, test } from 'bun:test'
import { RECONNECT_ESCALATE_MS } from '@solus/client-core/connection-display'
import {
  connectHostHeadline,
  connectHostRow,
  draftHostGate,
  type GatedHost,
} from '@solus/workspace-ui/components/session-draft/lib/host-gate'

// A draft no host can run shows the connect-a-host page in place of its
// composer (docs/plans/draft-connect-host.md). The page must never hide the
// composer on a guess: only a known "nothing answers" replaces it.

const NOW = 1_000_000
const host = (overrides: Partial<GatedHost>): GatedHost => ({
  id: 'bills',
  label: 'Bills',
  url: 'http://bills:4000',
  local: false,
  status: 'offline',
  routes: [],
  offlineSince: NOW - 60_000,
  ...overrides,
})

describe('the draft host gate', () => {
  test('one online host is enough to compose', () => {
    expect(draftHostGate([host({}), host({ id: 'mbp', status: 'online' })], NOW)).toBe('compose')
  })

  test('no host at all asks for one', () => {
    expect(draftHostGate([], NOW)).toBe('connect')
  })

  test('every host offline asks for one', () => {
    expect(draftHostGate([host({}), host({ id: 'mbp' })], NOW)).toBe('connect')
  })

  test('a short drop keeps the composer while the host dials again', () => {
    const dropped = host({ status: 'connecting', offlineSince: NOW - 2_000 })
    expect(draftHostGate([dropped], NOW)).toBe('compose')
  })

  test('a drop past the reconnect grace asks for a host', () => {
    const dropped = host({ status: 'connecting', offlineSince: NOW - RECONNECT_ESCALATE_MS })
    expect(draftHostGate([dropped], NOW)).toBe('connect')
  })

  test('a first connect still dialing keeps the composer', () => {
    expect(draftHostGate([host({ status: 'connecting', offlineSince: null })], NOW)).toBe('compose')
  })

  test('a host never checked keeps the composer, because nothing is known yet', () => {
    expect(draftHostGate([host({ status: 'saved', offlineSince: null })], NOW)).toBe('compose')
  })
})

describe('a host card on the connect page', () => {
  test('an offline host offers a retry and says when it was last seen', () => {
    expect(connectHostRow(host({}), NOW)).toEqual({
      hostId: 'bills',
      label: 'Bills',
      detail: 'Offline · last seen 1m ago',
      action: 'retry',
    })
  })

  test('a host that is dialing has nothing to do but wait', () => {
    expect(connectHostRow(host({ status: 'connecting' }), NOW).action).toBeNull()
  })

  test('a stopped cloud host offers to start it, not to retry it', () => {
    const row = connectHostRow(host({ uplink: { kind: 'managed', hostId: 'h1', directoryUrl: 'https://app.solus.sh', managedState: 'stopped' } }), NOW)
    expect(row).toMatchObject({ detail: 'Cloud host · stopped', action: 'start' })
  })

  test('a cloud host on its way up has no action', () => {
    const row = connectHostRow(host({ uplink: { kind: 'managed', hostId: 'h1', directoryUrl: 'https://app.solus.sh', managedState: 'starting' } }), NOW)
    expect(row).toMatchObject({ detail: 'Cloud host · starting', action: null })
  })

  test('a host that answers as another server must be paired again', () => {
    expect(connectHostRow(host({ status: 'different-server' }), NOW).action).toBe('pair-again')
  })
})

describe('the connect page headline', () => {
  test('names the host it waits on', () => {
    expect(connectHostHeadline([host({})], 'Bills')).toBe('Connecting to Bills')
  })

  test('names a single offline host so the person knows which machine to wake', () => {
    expect(connectHostHeadline([host({})], null)).toBe('Bills is offline')
  })

  test('asks for a first host when none is saved', () => {
    expect(connectHostHeadline([], null)).toBe('Connect a host to start')
  })
})
