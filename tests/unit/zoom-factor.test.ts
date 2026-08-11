import { describe, expect, test } from 'bun:test'
import {
  clampZoomFactor,
  stepZoomFactor,
  ZOOM_FACTOR_DEFAULT,
  ZOOM_FACTOR_MAX,
  ZOOM_FACTOR_MIN,
} from '../../src/shared/zoom'

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
