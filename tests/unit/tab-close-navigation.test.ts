import { describe, expect, test } from 'bun:test'
import { adjacentTabAfterClose } from '../../src/renderer/lib/sessionUtils'

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
