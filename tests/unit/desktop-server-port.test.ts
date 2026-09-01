import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DESKTOP_SERVER_PORT,
  desktopServerPort,
} from '@solus/desktop-main/server-port'

describe('desktop server port', () => {
  test('does not use the common web development port by default', () => {
    expect(DEFAULT_DESKTOP_SERVER_PORT).toBe(3001)
    expect(DEFAULT_DESKTOP_SERVER_PORT).not.toBe(3000)
    expect(desktopServerPort('')).toBe(DEFAULT_DESKTOP_SERVER_PORT)
  })

  test('keeps the SOLUS_PORT override', () => {
    expect(desktopServerPort('4100')).toBe(4100)
  })
})
