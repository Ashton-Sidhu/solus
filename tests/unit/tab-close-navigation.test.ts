import { describe, expect, test } from 'bun:test'
import {
  nextOpenSidebarTabAfterClose,
  nextTaskAfterLeaving,
} from '@solus/workspace-ui/contexts/workspace/session-sidebar-selection'

describe('nextOpenSidebarTabAfterClose', () => {
  test('moves forward to the row below, not the row above', () => {
    expect(nextOpenSidebarTabAfterClose(
      ['above', 'closing', 'below'],
      ['above', 'below'],
      ['closing'],
      'closing',
    )).toBe('below')
  })

  test('skips a snoozed row below for the next open session', () => {
    expect(nextOpenSidebarTabAfterClose(
      ['above', 'closing', 'snoozed', 'below'],
      ['above', 'below'],
      ['closing'],
      'closing',
    )).toBe('below')
  })

  test('wraps to the top when the last open row closes', () => {
    expect(nextOpenSidebarTabAfterClose(
      ['first', 'second', 'closing'],
      ['first', 'second'],
      ['closing'],
      'closing',
    )).toBe('first')
  })

  test('skips other tabs closing in the same batch', () => {
    expect(nextOpenSidebarTabAfterClose(
      ['first', 'closing', 'also-closing', 'last'],
      ['first', 'also-closing', 'last'],
      ['closing', 'also-closing'],
      'closing',
    )).toBe('last')
  })

  test('returns no session when only snoozed or completed work remains', () => {
    expect(nextOpenSidebarTabAfterClose(
      ['closing', 'snoozed', 'completed'],
      [],
      ['closing'],
      'closing',
    )).toBeNull()
  })
})

describe('nextTaskAfterLeaving', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

  test('snoozing a row moves to the row below it', () => {
    expect(nextTaskAfterLeaving(tasks, 'b', new Set())?.id).toBe('c')
  })

  test('completing rows together skips every row that is leaving', () => {
    expect(nextTaskAfterLeaving(tasks, 'b', new Set(['b', 'c', 'd']))?.id).toBe('a')
  })

  test('returns no row when every row is leaving', () => {
    expect(nextTaskAfterLeaving(tasks, 'a', new Set(['a', 'b', 'c', 'd']))).toBeNull()
  })
})
