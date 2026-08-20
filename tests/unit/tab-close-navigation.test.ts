import { describe, expect, test } from 'bun:test'
import { adjacentTabAfterClose } from '@solus/workspace-ui/lib/sessionUtils'
import { closestOpenSidebarTabAfterClose } from '@solus/workspace-ui/contexts/workspace/session-sidebar-selection'

describe('adjacentTabAfterClose', () => {
  test('selects the tab immediately left in the displayed grouped order', () => {
    const groupedOrder = ['waiting', 'running', 'completed', 'idle']

    expect(adjacentTabAfterClose(groupedOrder, 'completed')).toBe('running')
  })

  test('falls back to the right when the first displayed tab closes', () => {
    expect(adjacentTabAfterClose(['active', 'next'], 'active')).toBe('next')
  })

  test('returns no target when the closing tab has no displayed neighbour', () => {
    expect(adjacentTabAfterClose(['only'], 'only')).toBeNull()
  })
})

describe('closestOpenSidebarTabAfterClose', () => {
  test('skips a snoozed neighbour for the nearest open session', () => {
    expect(closestOpenSidebarTabAfterClose(
      ['open-left', 'closing', 'snoozed', 'open-right'],
      ['open-left', 'open-right'],
      ['closing'],
      'closing',
    )).toBe('open-left')
  })

  test('skips a completed neighbour when the open session is on the other side', () => {
    expect(closestOpenSidebarTabAfterClose(
      ['completed', 'closing', 'open-right'],
      ['open-right'],
      ['closing'],
      'closing',
    )).toBe('open-right')
  })

  test('returns no session when only snoozed or completed work remains', () => {
    expect(closestOpenSidebarTabAfterClose(
      ['closing', 'snoozed', 'completed'],
      [],
      ['closing'],
      'closing',
    )).toBeNull()
  })
})
