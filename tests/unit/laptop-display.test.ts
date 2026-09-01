import { describe, expect, test } from 'bun:test'
import { isLaptopDisplay } from '@solus/workspace-ui/contexts/app/viewport'
import { LAPTOP_SCREEN_MAX_WIDTH } from '@solus/contracts/zoom'


// `screen.width` is reported in zoomed CSS pixels, so a display of width W at
// zoom Z reads back as W / Z. These helpers make each case state the real
// hardware and let the test derive what the renderer would see.
const asSeenAtZoom = (displayWidth: number, zoomFactor: number) => displayWidth / zoomFactor

describe('isLaptopDisplay', () => {
  test('classifies the hardware, not the window', () => {
    expect(isLaptopDisplay(1512, 1)).toBe(true) // 14" MacBook Pro
    expect(isLaptopDisplay(1920, 1)).toBe(false)
    expect(isLaptopDisplay(LAPTOP_SCREEN_MAX_WIDTH, 1)).toBe(true)
    expect(isLaptopDisplay(LAPTOP_SCREEN_MAX_WIDTH + 1, 1)).toBe(false)
  })

  // WHY: the old `(max-width: 1800px)` media query measured the window, and zoom
  // changes how many CSS pixels a window reports. A 1920px monitor at 110% zoom
  // reported 1745 and silently crossed onto the laptop branch, so one zoom
  // keystroke also resized the pill and stripped the plan modal's borders.
  test('zoom cannot move a display across the threshold', () => {
    for (const zoomFactor of [0.5, 0.8, 0.9, 1, 1.1, 1.5, 2]) {
      expect(isLaptopDisplay(asSeenAtZoom(1512, zoomFactor), zoomFactor)).toBe(true)
      expect(isLaptopDisplay(asSeenAtZoom(1920, zoomFactor), zoomFactor)).toBe(false)
    }
  })

  test('the window-measuring bug would have flipped the 1920 monitor', () => {
    // Guards the premise of the test above: at 110% the old query really did
    // classify this monitor as a laptop, so the fix is not cosmetic.
    expect(asSeenAtZoom(1920, 1.1)).toBeLessThanOrEqual(1800)
  })

  test('an unreadable screen width is unknown, not narrow', () => {
    expect(isLaptopDisplay(undefined, 1)).toBe(false)
    expect(isLaptopDisplay(Number.NaN, 1)).toBe(false)
    expect(isLaptopDisplay(0, 1)).toBe(false)
  })
})
