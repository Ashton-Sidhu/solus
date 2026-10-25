import { describe, expect, test } from 'bun:test'
import { hostReadinessCopy, type HostReadinessState } from '@solus/client-core/host-readiness'

// Every surface on desktop, web, and mobile says a host's state with these
// words (docs/plans/host-readiness.md). One table, so one host never reads as
// two different states on two surfaces.

const NOW = 10_000_000
const base: HostReadinessState = { readiness: 'ready', away: false, unreachableReason: null, refusedReason: null, lastSeenAt: null }

describe('host readiness copy', () => {
  test('an offline host says when it was last seen and offers a retry', () => {
    const copy = hostReadinessCopy({ ...base, readiness: 'unreachable', unreachableReason: 'no-answer', lastSeenAt: NOW - 4 * 60_000 }, 'Raiders', NOW)
    expect(copy).toEqual({
      label: 'Offline',
      headline: 'Raiders is offline',
      detail: 'Last seen 4 min ago. Solus keeps trying.',
      action: 'retry',
    })
  })

  test('a host inside its grace offers nothing to do but wait', () => {
    // WHY: a Retry while the ladder already dials adds nothing and invites a double dial.
    expect(hostReadinessCopy({ ...base, readiness: 'checking' }, 'Raiders').action).toBeNull()
    expect(hostReadinessCopy({ ...base, readiness: 'reconnecting' }, 'Raiders').headline).toBe('Reconnecting to Raiders')
  })

  test('a stopped cloud host offers to start it, not to retry it', () => {
    expect(hostReadinessCopy({ ...base, readiness: 'unreachable', unreachableReason: 'not-running' }, 'Raiders').action).toBe('start')
  })

  test('a refused host asks to pair again, whatever refused it', () => {
    // WHY: a dial cannot fix a refused credential or a different server at the address.
    expect(hostReadinessCopy({ ...base, readiness: 'refused', refusedReason: 'auth' }, 'Raiders').action).toBe('pair-again')
    expect(hostReadinessCopy({ ...base, readiness: 'refused', refusedReason: 'identity-mismatch' }, 'Raiders').action).toBe('pair-again')
  })

  test('a removed host has no action', () => {
    expect(hostReadinessCopy({ ...base, readiness: 'gone' }, 'Raiders')).toMatchObject({ label: 'Removed', action: null })
  })
})
