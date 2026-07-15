import { describe, expect, test } from 'bun:test'
import { actionOrbWouldOverflow } from '../../src/renderer/components/layout/lib/action-orb-layout'

describe('action orb fit', () => {
  test('collapses labels when the project panel leaves less room than the action row needs', () => {
    expect(actionOrbWouldOverflow(720, 760)).toBe(true)
  })

  test('keeps labels when the complete action row fits inside the available column', () => {
    expect(actionOrbWouldOverflow(900, 760)).toBe(false)
  })

  test('collapses labels before the centered row reaches the action orb', () => {
    expect(actionOrbWouldOverflow(820, 700)).toBe(true)
  })

  test('collapses labels before the centered row reaches the current activity strip', () => {
    expect(actionOrbWouldOverflow(900, 600, 180)).toBe(true)
  })

  test('does not collapse based on an arbitrary width before the row is measured', () => {
    expect(actionOrbWouldOverflow(320, null)).toBe(false)
  })
})
