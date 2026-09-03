import { describe, expect, test } from 'bun:test'
import { isMobileLayout } from '@solus/workspace-ui/contexts/app/viewport'

describe('mobile layout selection', () => {
  test('keeps a touch phone on the mobile layout after landscape rotation', () => {
    // WHY: rotating a phone makes the viewport wider than the breakpoint, but
    // it does not turn the phone into a desktop workspace.
    expect(isMobileLayout(844, 844, 390, true)).toBe(true)
  })

  test('keeps a wide tablet and a short desktop window on the desktop layout', () => {
    expect(isMobileLayout(1180, 1180, 820, true)).toBe(false)
    expect(isMobileLayout(1200, 1920, 700, false)).toBe(false)
  })

  test('uses the mobile layout for any narrow viewport', () => {
    expect(isMobileLayout(767, 1920, 1080, false)).toBe(true)
  })
})
