import { expect, test } from 'bun:test'
import { HtmlFullscreen, isAppFullscreenElement } from '../../apps/desktop/src/main/html-fullscreen'

test('an app video takes the screen and gives it back', () => {
  const fullscreen = new HtmlFullscreen()
  expect(isAppFullscreenElement({ tagName: 'VIDEO' })).toBe(true)
  expect(fullscreen.request(true, false)).toBe(true)
  expect(fullscreen.request(false, true)).toBe(false)
  fullscreen.windowLeftFullScreen()
  expect(fullscreen.request(false, false)).toBeNull()
})

test('a browser pane webview keeps its fullscreen inside the window', () => {
  expect(isAppFullscreenElement({ tagName: 'WEBVIEW' })).toBe(false)
  expect(isAppFullscreenElement(null)).toBe(false)
})

test('a window the user made fullscreen stays fullscreen', () => {
  const fullscreen = new HtmlFullscreen()
  expect(fullscreen.request(true, true)).toBeNull()
  expect(fullscreen.request(false, true)).toBeNull()
})

test('leaving OS fullscreen another way gives the window back to the user', () => {
  const fullscreen = new HtmlFullscreen()
  fullscreen.request(true, false)
  fullscreen.windowLeftFullScreen()
  // The user made the window fullscreen again during playback.
  expect(fullscreen.request(false, true)).toBeNull()
})

test('a video that returns during the macOS exit animation takes the screen again', () => {
  const fullscreen = new HtmlFullscreen()
  fullscreen.request(true, false)
  expect(fullscreen.request(false, true)).toBe(false)
  // The window still reports fullscreen until leave-full-screen.
  expect(fullscreen.request(true, true)).toBe(true)
  fullscreen.windowLeftFullScreen()
  expect(fullscreen.request(false, true)).toBe(false)
})
