import { describe, expect, test } from 'bun:test'
import {
  desktopServerPort,
} from '@solus/desktop-main/server-port'

describe('desktop server port', () => {
  test('does not use the common web development port by default', () => {
    expect(desktopServerPort('')).not.toBe(3000)
  })

  test('keeps the SOLUS_PORT override', () => {
    expect(desktopServerPort('4100')).toBe(4100)
  })
})
