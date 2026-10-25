import { describe, expect, test } from 'bun:test'
import type { HostReadiness } from '@solus/client-core/host-readiness'
import { newTaskHostGate } from '../../apps/mobile/src/features/threads/lib/new-task-host-gate'

// The new-task sheet shows the connect-a-host page in place of its composer
// when no host can run the task (docs/plans/host-readiness.md "Draft gate").
// It must never take the composer away on a guess: only a host that is away
// (past the grace, refused, or removed), or no host at all, counts.

const host = (readiness: HostReadiness, away = readiness === 'unreachable' || readiness === 'refused' || readiness === 'gone') => ({ readiness, away })

describe('the new-task host gate', () => {
  test('one ready host is enough to compose', () => {
    expect(newTaskHostGate([host('unreachable'), host('ready')], 'compose')).toBe('compose')
  })

  test('no host at all asks for one', () => {
    expect(newTaskHostGate([], 'compose')).toBe('connect')
  })

  test('every host unreachable, refused, or removed asks for one', () => {
    expect(newTaskHostGate([host('unreachable'), host('refused'), host('gone')], 'compose')).toBe('connect')
  })

  test('a host inside the grace keeps the composer, so a short drop does not take it away', () => {
    expect(newTaskHostGate([host('unreachable'), host('reconnecting')], 'compose')).toBe('compose')
    expect(newTaskHostGate([host('checking')], 'compose')).toBe('compose')
  })

  test('a host that is away and dialed again does not open the composer', () => {
    // WHY: a retry from a thread leaves the host away; the sheet opened during
    // that dial must not offer a composer the host may never answer.
    expect(newTaskHostGate([host('checking', true)], 'compose')).toBe('connect')
  })

  test('a retry from the connect page keeps the page while the host dials', () => {
    // WHY: the composer must not flash back for a dial that then fails. A
    // retried refused host has a new link that is not away yet.
    expect(newTaskHostGate([host('checking')], 'connect')).toBe('connect')
    expect(newTaskHostGate([host('reconnecting')], 'connect')).toBe('connect')
  })

  test('the composer comes back from the connect page once a host is ready', () => {
    expect(newTaskHostGate([host('unreachable'), host('ready')], 'connect')).toBe('compose')
  })
})
