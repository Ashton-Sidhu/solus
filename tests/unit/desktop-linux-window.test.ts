import { expect, test } from 'bun:test'
import { initialWindowBounds } from '@solus/desktop-main/window-platform'
import type { Display } from 'electron'

test('Wayland startup does not query the global pointer or set window coordinates', () => {
  const screen = {
    getPrimaryDisplay: () => ({ workArea: { x: 100, y: 200, width: 1000, height: 800 } }) as Display,
    getCursorScreenPoint: () => { throw new Error('unsupported on Wayland') },
    getDisplayNearestPoint: () => { throw new Error('unsupported on Wayland') },
  }
  expect(initialWindowBounds(screen, true)).toEqual({ width: 920, height: 720 })
})
