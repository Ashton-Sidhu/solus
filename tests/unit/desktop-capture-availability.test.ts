import { expect, test } from 'bun:test'
import { desktopCaptureSupport } from '@solus/client-core/desktop-capture'

test('Linux, macOS, and Windows desktops take screenshots; web has no native capture', () => {
  expect(desktopCaptureSupport('linux').screenshot).toBe(true)
  expect(desktopCaptureSupport('darwin').screenshot).toBe(true)
  expect(desktopCaptureSupport('win32').screenshot).toBe(true)
  expect(desktopCaptureSupport('web').screenshot).toBe(false)
})
