import { describe, test, expect } from 'bun:test'
import {
  IS_WEB,
  isMac,
  defaultCombo,
  comboFromEvent,
  comboEquals,
  comboToAccelerator,
} from '../../../src/renderer/lib/keybindings/match'
import type { BindingDef, KeyCombo } from '../../../src/renderer/lib/keybindings/types'

// In the bun runtime navigator.platform is "MacIntel" (isMac === true) and there
// is no `document` (IS_WEB === false). The assertions below are written against
// that environment but also pin the platform-relative branches via isMac/IS_WEB
// so they stay correct if the runtime changes.

const ev = (init: Partial<KeyboardEvent> & { code: string }): KeyboardEvent =>
  ({ altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, ...init }) as KeyboardEvent

describe('defaultCombo', () => {
  const desktop: KeyCombo = { mod: true, code: 'KeyT' }
  const web: KeyCombo = { alt: true, shift: true, code: 'KeyT' }
  const def: BindingDef = { combo: desktop, web, scope: 'global', label: 'New tab', group: 'Tabs' }
  const noWeb: BindingDef = { combo: desktop, scope: 'global', label: 'x', group: 'g' }

  test('resolves the web variant on web, desktop combo otherwise', () => {
    expect(defaultCombo(def)).toEqual(IS_WEB ? web : desktop)
  })

  test('falls back to the desktop combo when no web variant exists', () => {
    expect(defaultCombo(noWeb)).toBe(desktop)
  })
})

describe('comboFromEvent', () => {
  test('returns null for modifier-only presses', () => {
    expect(comboFromEvent(ev({ code: 'ShiftLeft', shiftKey: true }))).toBeNull()
    expect(comboFromEvent(ev({ code: 'MetaRight', metaKey: true }))).toBeNull()
  })

  test('captures plain keys with alt/shift flags', () => {
    expect(comboFromEvent(ev({ code: 'Space', altKey: true }))).toEqual({ code: 'Space', alt: true })
    expect(comboFromEvent(ev({ code: 'KeyT' }))).toEqual({ code: 'KeyT' })
  })

  test('collapses the platform primary modifier into mod', () => {
    const combo = comboFromEvent(ev({ code: 'KeyK', shiftKey: true, metaKey: isMac, ctrlKey: !isMac }))
    expect(combo).toEqual({ code: 'KeyK', shift: true, mod: true })
  })

  test('keeps the non-primary modifier as an explicit flag', () => {
    // On mac, ctrl is the secondary modifier (does not collapse to mod).
    const combo = comboFromEvent(ev({ code: 'KeyK', metaKey: !isMac, ctrlKey: isMac }))
    expect(combo).toEqual(isMac ? { code: 'KeyK', ctrl: true } : { code: 'KeyK', meta: true })
  })
})

describe('comboEquals', () => {
  test('treats mod as the platform meta/ctrl', () => {
    const a: KeyCombo = { mod: true, shift: true, code: 'KeyW' }
    const b: KeyCombo = isMac
      ? { meta: true, shift: true, code: 'KeyW' }
      : { ctrl: true, shift: true, code: 'KeyW' }
    expect(comboEquals(a, b)).toBe(true)
  })

  test('distinguishes different keys and modifier sets', () => {
    expect(comboEquals({ mod: true, code: 'KeyT' }, { code: 'KeyT' })).toBe(false)
    expect(comboEquals({ alt: true, code: 'KeyT' }, { code: 'KeyT' })).toBe(false)
    expect(comboEquals({ code: 'KeyA' }, { code: 'KeyB' })).toBe(false)
  })
})

describe('comboToAccelerator', () => {
  test('maps mod to CommandOrControl and orders modifiers', () => {
    expect(comboToAccelerator({ mod: true, shift: true, code: 'KeyK' })).toBe('CommandOrControl+Shift+K')
  })

  test('maps explicit modifiers and named keys', () => {
    expect(comboToAccelerator({ alt: true, code: 'Space' })).toBe('Alt+Space')
    expect(comboToAccelerator({ ctrl: true, code: 'Tab' })).toBe('Control+Tab')
    expect(comboToAccelerator({ code: 'F5' })).toBe('F5')
    expect(comboToAccelerator({ mod: true, code: 'Comma' })).toBe('CommandOrControl+,')
  })

  test('returns null for keys with no accelerator name', () => {
    expect(comboToAccelerator({ code: 'IntlBackslash' })).toBeNull()
  })
})
