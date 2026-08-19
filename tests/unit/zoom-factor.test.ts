import { describe, expect, test } from 'bun:test'
import {
  clampZoomFactor,
  defaultZoomFactorForScreen,
  LAPTOP_SCREEN_MAX_WIDTH,
  stepZoomFactor,
  ZOOM_FACTOR_DEFAULT,
  ZOOM_FACTOR_MAX,
  ZOOM_FACTOR_MIN,
} from '@solus/contracts/zoom'

// Zoom replaced the fluid root font-size (ADR-0010): the factor is the one
// whole-UI scale knob, persisted across restarts and applied to webContents.
// These tests pin the behaviors the shortcuts and the settings blob rely on.

describe('clampZoomFactor', () => {
  test('holds the factor inside the usable window range', () => {
    expect(clampZoomFactor(0.1)).toBe(ZOOM_FACTOR_MIN)
    expect(clampZoomFactor(5)).toBe(ZOOM_FACTOR_MAX)
    expect(clampZoomFactor(1.3)).toBe(1.3)
  })

  test('a corrupt persisted value falls back to 100%, not an unreadable scale', () => {
    expect(clampZoomFactor(Number.NaN)).toBe(ZOOM_FACTOR_DEFAULT)
    expect(clampZoomFactor(Number.POSITIVE_INFINITY)).toBe(ZOOM_FACTOR_DEFAULT)
  })
})

describe('defaultZoomFactorForScreen', () => {
  // The fixed 16px root renders ~7% larger on a laptop than the fluid root it
  // replaced (ADR-0010). A laptop should not have to zoom out by hand on every
  // fresh install, so the first-run default carries that one step.
  test('a laptop-class screen opens one step out', () => {
    expect(defaultZoomFactorForScreen(1512)).toBe(0.9) // 14" MacBook Pro
    expect(defaultZoomFactorForScreen(1440)).toBe(0.9)
    expect(defaultZoomFactorForScreen(LAPTOP_SCREEN_MAX_WIDTH)).toBe(0.9)
  })

  test('a desktop monitor keeps 100% — the OS already chose that density', () => {
    expect(defaultZoomFactorForScreen(LAPTOP_SCREEN_MAX_WIDTH + 1)).toBe(ZOOM_FACTOR_DEFAULT)
    expect(defaultZoomFactorForScreen(1920)).toBe(ZOOM_FACTOR_DEFAULT)
    expect(defaultZoomFactorForScreen(3440)).toBe(ZOOM_FACTOR_DEFAULT)
  })

  test('an unreadable screen width never seeds a surprise scale', () => {
    expect(defaultZoomFactorForScreen(undefined)).toBe(ZOOM_FACTOR_DEFAULT)
    expect(defaultZoomFactorForScreen(Number.NaN)).toBe(ZOOM_FACTOR_DEFAULT)
    expect(defaultZoomFactorForScreen(0)).toBe(ZOOM_FACTOR_DEFAULT)
  })

  test('the seed is a real zoom step, so mod+plus lands back on 100%', () => {
    expect(stepZoomFactor(defaultZoomFactorForScreen(1512), 1)).toBe(ZOOM_FACTOR_DEFAULT)
  })
})

describe('stepZoomFactor', () => {
  test('steps are predictable 10% increments', () => {
    expect(stepZoomFactor(1, 1)).toBe(1.1)
    expect(stepZoomFactor(1, -1)).toBe(0.9)
  })

  test('repeated steps stay on clean decimals — no float drift in the persisted blob', () => {
    let factor = ZOOM_FACTOR_DEFAULT
    for (let i = 0; i < 8; i++) factor = stepZoomFactor(factor, 1)
    expect(factor).toBe(1.8)
    for (let i = 0; i < 16; i++) factor = stepZoomFactor(factor, -1)
    expect(factor).toBe(ZOOM_FACTOR_MIN)
  })

  test('stepping at a bound stays at the bound', () => {
    expect(stepZoomFactor(ZOOM_FACTOR_MAX, 1)).toBe(ZOOM_FACTOR_MAX)
    expect(stepZoomFactor(ZOOM_FACTOR_MIN, -1)).toBe(ZOOM_FACTOR_MIN)
  })
})
