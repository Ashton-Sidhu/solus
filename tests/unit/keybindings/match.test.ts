import { describe, test, expect } from 'bun:test'
import {
  IS_WEB,
  defaultCombo,
  comboFromEvent,
  comboEquals,
  comboToAccelerator,
  eventMatches,
  formatCombo,
  formatComboText,
} from '@solus/workspace-ui/lib/keybindings/match'
import {
  LINUX_KEYS,
  MAC_KEYS,
  WINDOWS_KEYS,
  keyPlatformForNavigator,
  keyPlatformForNode,
  type KeyPlatform,
} from '@solus/workspace-ui/lib/keybindings/key-platform'
import { KEYBINDINGS } from '@solus/workspace-ui/lib/keybindings/manifest'
import type { BindingDef, KeyCombo } from '@solus/workspace-ui/lib/keybindings/types'

// Each platform's keys are passed in, so every case runs on every machine. In
// the bun runtime there is no `document`, so IS_WEB is false.

const ev = (init: Partial<KeyboardEvent> & { code: string }): KeyboardEvent =>
  ({ altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, ...init }) as KeyboardEvent

const ALL_KEYS: Array<[string, KeyPlatform]> = [['macOS', MAC_KEYS], ['Windows', WINDOWS_KEYS], ['Linux', LINUX_KEYS]]

describe('the key platform', () => {
  test('a browser and a Node process name the same three platforms', () => {
    expect(keyPlatformForNavigator('MacIntel')).toBe(MAC_KEYS)
    expect(keyPlatformForNavigator('Win32')).toBe(WINDOWS_KEYS)
    expect(keyPlatformForNavigator('Linux x86_64')).toBe(LINUX_KEYS)
    expect(keyPlatformForNode('darwin')).toBe(MAC_KEYS)
    expect(keyPlatformForNode('win32')).toBe(WINDOWS_KEYS)
    expect(keyPlatformForNode('linux')).toBe(LINUX_KEYS)
  })
})

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

  test('the Windows and Linux default applies where mod is Ctrl', () => {
    const nonMac: KeyCombo = { mod: true, shift: true, code: 'KeyC' }
    const interrupt: BindingDef = { combo: { ctrl: true, code: 'KeyC' }, nonMac, scope: 'global', label: 'Stop', group: 'g' }
    expect(defaultCombo(interrupt, MAC_KEYS)).toEqual({ ctrl: true, code: 'KeyC' })
    expect(defaultCombo(interrupt, WINDOWS_KEYS)).toBe(nonMac)
    expect(defaultCombo(interrupt, LINUX_KEYS)).toBe(nonMac)
  })
})

describe('comboFromEvent', () => {
  test.each(ALL_KEYS)('returns null for modifier-only presses on %s', (_name, keys) => {
    expect(comboFromEvent(ev({ code: 'ShiftLeft', shiftKey: true }), keys)).toBeNull()
    expect(comboFromEvent(ev({ code: 'MetaRight', metaKey: true }), keys)).toBeNull()
  })

  test.each(ALL_KEYS)('captures plain keys with alt/shift flags on %s', (_name, keys) => {
    expect(comboFromEvent(ev({ code: 'Space', altKey: true }), keys)).toEqual({ code: 'Space', alt: true })
    expect(comboFromEvent(ev({ code: 'KeyT' }), keys)).toEqual({ code: 'KeyT' })
  })

  test('collapses the platform primary modifier into mod', () => {
    expect(comboFromEvent(ev({ code: 'KeyK', shiftKey: true, metaKey: true }), MAC_KEYS)).toEqual({ code: 'KeyK', shift: true, mod: true })
    expect(comboFromEvent(ev({ code: 'KeyK', shiftKey: true, ctrlKey: true }), WINDOWS_KEYS)).toEqual({ code: 'KeyK', shift: true, mod: true })
  })

  test('keeps the non-primary modifier as an explicit flag', () => {
    // On macOS ctrl is the secondary modifier; elsewhere it is the Windows or Super key.
    expect(comboFromEvent(ev({ code: 'KeyK', ctrlKey: true }), MAC_KEYS)).toEqual({ code: 'KeyK', ctrl: true })
    expect(comboFromEvent(ev({ code: 'KeyK', metaKey: true }), LINUX_KEYS)).toEqual({ code: 'KeyK', meta: true })
  })
})

describe('multi-modifier shortcuts', () => {
  test('keeps an explicit secondary modifier beside the platform modifier on macOS', () => {
    const combo = { mod: true, ctrl: true, code: 'KeyC' }
    expect(eventMatches(ev({ code: 'KeyC', metaKey: true, ctrlKey: true }), combo, MAC_KEYS)).toBe(true)
    expect(formatCombo(combo, MAC_KEYS)).toEqual(['⌘', '⌃', 'C'])
    expect(comboEquals(combo, { mod: true, code: 'KeyC' }, MAC_KEYS)).toBe(false)
    expect(comboToAccelerator(combo, MAC_KEYS)).toBe('CommandOrControl+Control+C')
  })

  test('where mod is Ctrl, mod with ctrl is one key', () => {
    const combo = { mod: true, ctrl: true, code: 'KeyC' }
    expect(eventMatches(ev({ code: 'KeyC', ctrlKey: true }), combo, WINDOWS_KEYS)).toBe(true)
    expect(formatCombo(combo, WINDOWS_KEYS)).toEqual(['Ctrl', 'C'])
    expect(comboEquals(combo, { mod: true, code: 'KeyC' }, WINDOWS_KEYS)).toBe(true)
    expect(comboToAccelerator(combo, WINDOWS_KEYS)).toBe('CommandOrControl+C')
  })
})

describe('comboEquals', () => {
  test('treats mod as the platform meta/ctrl', () => {
    const a: KeyCombo = { mod: true, shift: true, code: 'KeyW' }
    expect(comboEquals(a, { meta: true, shift: true, code: 'KeyW' }, MAC_KEYS)).toBe(true)
    expect(comboEquals(a, { ctrl: true, shift: true, code: 'KeyW' }, LINUX_KEYS)).toBe(true)
  })

  test.each(ALL_KEYS)('distinguishes different keys and modifier sets on %s', (_name, keys) => {
    expect(comboEquals({ mod: true, code: 'KeyT' }, { code: 'KeyT' }, keys)).toBe(false)
    expect(comboEquals({ alt: true, code: 'KeyT' }, { code: 'KeyT' }, keys)).toBe(false)
    expect(comboEquals({ code: 'KeyA' }, { code: 'KeyB' }, keys)).toBe(false)
  })
})

describe('comboToAccelerator', () => {
  test.each(ALL_KEYS)('maps mod to CommandOrControl and orders modifiers on %s', (_name, keys) => {
    expect(comboToAccelerator({ mod: true, shift: true, code: 'KeyK' }, keys)).toBe('CommandOrControl+Shift+K')
  })

  test('maps explicit modifiers and named keys', () => {
    expect(comboToAccelerator({ alt: true, code: 'Space' })).toBe('Alt+Space')
    expect(comboToAccelerator({ ctrl: true, code: 'Tab' }, MAC_KEYS)).toBe('Control+Tab')
    expect(comboToAccelerator({ code: 'F5' })).toBe('F5')
    expect(comboToAccelerator({ mod: true, code: 'Comma' })).toBe('CommandOrControl+,')
  })

  test('returns null for keys with no accelerator name', () => {
    expect(comboToAccelerator({ code: 'IntlBackslash' })).toBeNull()
  })

  test('the meta key is Command on macOS and Super elsewhere', () => {
    // WHY: Electron's `Command` exists on macOS only, so the shortcut never registered.
    expect(comboToAccelerator({ meta: true, code: 'KeyS' }, MAC_KEYS)).toBe('Command+S')
    expect(comboToAccelerator({ meta: true, code: 'KeyS' }, WINDOWS_KEYS)).toBe('Super+S')
    expect(comboToAccelerator({ meta: true, code: 'KeyS' }, LINUX_KEYS)).toBe('Super+S')
  })
})

describe('labels', () => {
  test('macOS prints symbols with no separator', () => {
    expect(formatCombo({ mod: true, shift: true, code: 'KeyK' }, MAC_KEYS)).toEqual(['⌘', '⇧', 'K'])
    expect(formatComboText({ mod: true, alt: true, code: 'Backspace' }, MAC_KEYS)).toBe('⌘⌥⌫')
  })

  test('Windows and Linux print key names joined with +', () => {
    // WHY: ⌘ and ⌥ name no key on a Windows or Linux keyboard.
    expect(formatCombo({ mod: true, shift: true, code: 'KeyK' }, WINDOWS_KEYS)).toEqual(['Ctrl', 'Shift', 'K'])
    expect(formatComboText({ mod: true, alt: true, code: 'KeyN' }, LINUX_KEYS)).toBe('Ctrl+Alt+N')
    expect(formatComboText({ mod: true, code: 'Backspace' }, WINDOWS_KEYS)).toBe('Ctrl+Backspace')
  })

  test('the meta key is the Windows key on Windows and Super on Linux', () => {
    expect(formatCombo({ alt: true, meta: true, code: 'KeyM' }, WINDOWS_KEYS)).toEqual(['Alt', 'Win', 'M'])
    expect(formatCombo({ alt: true, meta: true, code: 'KeyM' }, LINUX_KEYS)).toEqual(['Alt', 'Super', 'M'])
  })
})

describe('defaults where mod is Ctrl', () => {
  test('the summon shortcut adds Shift, because Alt+Space opens the window menu', () => {
    expect(MAC_KEYS.summonCombo).toEqual({ alt: true, code: 'Space' })
    expect(WINDOWS_KEYS.summonCombo).toEqual({ alt: true, shift: true, code: 'Space' })
    expect(LINUX_KEYS.summonCombo).toEqual({ alt: true, shift: true, code: 'Space' })
  })

  test.each([['Windows', WINDOWS_KEYS], ['Linux', LINUX_KEYS]] as const)('Stop agent leaves Ctrl+C to copy, and no two Ctrl defaults collide on %s', (_name, keys) => {
    expect(defaultCombo(KEYBINDINGS['conversation.interrupt'], keys)).toEqual({ mod: true, shift: true, code: 'KeyC' })
    const globals = Object.values(KEYBINDINGS).filter((binding) => binding.scope === 'global')
    // WHY: on macOS ctrl and mod are two keys; here they are one, so Ctrl+/ was both
    // the sidebar search and the shortcuts list.
    const combos = globals.map((binding) => defaultCombo(binding, keys)).filter((combo): combo is KeyCombo => !!combo && !!(combo.mod || combo.ctrl))
    for (const [index, combo] of combos.entries()) {
      for (const other of combos.slice(index + 1)) expect(comboEquals(combo, other, keys)).toBe(false)
    }
  })
})
