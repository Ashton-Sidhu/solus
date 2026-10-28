import type { BindingDef, KeyCombo } from './types'
import { CURRENT_KEYS, type KeyPlatform } from './key-platform'

/** True on macOS. For a key fact, ask the `KeyPlatform` (`key-platform.ts`). */
export const isMac = CURRENT_KEYS.id === 'mac'

// The web shell tags the document root with `solus-web` (same signal
// settings.context uses). Browsers reserve combos like ⌘T/⌘W/⌘N that a page
// can't preventDefault, so web bindings fall back to a non-reserved default.
export const IS_WEB = globalThis.document?.documentElement.classList.contains('solus-web') ?? false

/**
 * The effective default combo for the platform (web variant on web, then the
 * variant for platforms where `mod` is Ctrl). `null` when the binding ships
 * unassigned.
 */
export function defaultCombo(def: BindingDef, keys: KeyPlatform = CURRENT_KEYS): KeyCombo | null {
  if (IS_WEB && def.web) return def.web
  if (keys.primaryModifier === 'ctrl' && def.nonMac) return def.nonMac
  return def.combo
}

export function eventMatches(e: KeyboardEvent, combo: KeyCombo, keys: KeyPlatform = CURRENT_KEYS): boolean {
  if (e.code !== combo.code) return false
  if (!!combo.alt !== e.altKey) return false
  if (!!combo.shift !== e.shiftKey) return false
  // `mod` names the platform's primary modifier. Explicit secondary modifiers
  // still apply, so `mod + ctrl` means Command-Control on macOS rather than
  // silently dropping Control.
  const wanted = effectiveMods(combo, keys)
  if (wanted.meta !== e.metaKey) return false
  if (wanted.ctrl !== e.ctrlKey) return false
  return true
}

// Codes that produce a character when typed. A binding on one of these with no
// non-shift modifier is indistinguishable from plain typing, so it must yield to
// an editable target (Shift alone still produces text, so it doesn't exempt).
const TEXT_INPUT_CODES = new Set([
  'Slash', 'Backslash', 'Backquote', 'Comma', 'Period', 'Semicolon',
  'Quote', 'Equal', 'Minus', 'BracketLeft', 'BracketRight', 'Space',
  'IntlBackslash',
])

/**
 * True when this combo is indistinguishable from typing a character: a printable
 * key (letter, digit, or punctuation) with no ⌘/⌃/⌥. Such bindings must not fire
 * while an editable element is focused, or they swallow the character.
 */
export function comboIsTextInput(combo: KeyCombo): boolean {
  if (combo.mod || combo.meta || combo.ctrl || combo.alt) return false
  return (
    /^Key[A-Z]$/.test(combo.code) ||
    /^Digit\d$/.test(combo.code) ||
    TEXT_INPUT_CODES.has(combo.code)
  )
}

const KEY_SYMBOLS = new Map<string, string>(Object.entries({
  Escape: 'Esc',
  Enter: '↵',
  Tab: '⇥',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Backquote: '`',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  Equal: '=',
  Period: '.',
  Backslash: '\\',
}))

function codeToLabel(code: string, keys: KeyPlatform): string {
  const symbol = keys.keyLabel(code) ?? KEY_SYMBOLS.get(code)
  if (symbol) return symbol
  const m = code.match(/^Key([A-Z])$/)
  if (m) return m[1]
  const d = code.match(/^Digit(\d)$/)
  if (d) return d[1]
  return code
}

/** The key labels of a combo: Mac symbols on macOS, key names elsewhere. */
export function formatCombo(combo: KeyCombo, keys: KeyPlatform = CURRENT_KEYS): string[] {
  return [...keys.modifierLabels(combo), codeToLabel(combo.code, keys)]
}

/** A combo as one inline label: `⌘⇧K` on macOS, `Ctrl+Shift+K` elsewhere. */
export function formatComboText(combo: KeyCombo, keys: KeyPlatform = CURRENT_KEYS): string {
  return formatCombo(combo, keys).join(keys.separator)
}

const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight',
  'ControlLeft', 'ControlRight',
])

/**
 * Build a KeyCombo from a keydown event. Returns null for modifier-only presses
 * so record-mode waits for a real key. Meta/Ctrl collapse into `mod` when they
 * match the platform's primary modifier, matching the manifest's convention.
 */
export function comboFromEvent(e: KeyboardEvent, keys: KeyPlatform = CURRENT_KEYS): KeyCombo | null {
  if (MODIFIER_CODES.has(e.code)) return null
  const combo: KeyCombo = { code: e.code }
  if (e.altKey) combo.alt = true
  if (e.shiftKey) combo.shift = true
  if (keys.primaryModifier === 'meta') {
    if (e.metaKey) combo.mod = true
    if (e.ctrlKey) combo.ctrl = true
  } else {
    if (e.ctrlKey) combo.mod = true
    if (e.metaKey) combo.meta = true
  }
  return combo
}

/** Resolve a combo's primary (meta) / secondary (ctrl) modifiers for the platform. */
interface EffectiveModifiers {
  meta: boolean
  ctrl: boolean
}

function effectiveMods(combo: KeyCombo, keys: KeyPlatform): EffectiveModifiers {
  return {
    meta: !!combo.meta || (!!combo.mod && keys.primaryModifier === 'meta'),
    ctrl: !!combo.ctrl || (!!combo.mod && keys.primaryModifier === 'ctrl'),
  }
}

/** Structural equality treating `mod` as the platform's meta/ctrl. */
export function comboEquals(a: KeyCombo, b: KeyCombo, keys: KeyPlatform = CURRENT_KEYS): boolean {
  if (a.code !== b.code) return false
  if (!!a.alt !== !!b.alt) return false
  if (!!a.shift !== !!b.shift) return false
  const ma = effectiveMods(a, keys)
  const mb = effectiveMods(b, keys)
  return ma.meta === mb.meta && ma.ctrl === mb.ctrl
}

const ACCEL_KEY_NAMES = new Map<string, string>(Object.entries({
  Space: 'Space',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Semicolon: ';',
  Quote: "'",
  Equal: '=',
  Minus: '-',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
}))

function codeToAcceleratorKey(code: string): string | null {
  const name = ACCEL_KEY_NAMES.get(code)
  if (name) return name
  const m = code.match(/^Key([A-Z])$/)
  if (m) return m[1]
  const d = code.match(/^Digit(\d)$/)
  if (d) return d[1]
  const f = code.match(/^F(\d{1,2})$/)
  if (f) return code
  return null
}

/**
 * Convert a KeyCombo to an Electron accelerator string (main-process only,
 * used for the OS summon shortcuts). Returns null if the key isn't expressible
 * as an accelerator. `mod` maps to CommandOrControl. The main process passes
 * the keys of the operating system it runs on (`DesktopPlatform.keys`).
 */
export function comboToAccelerator(combo: KeyCombo, keys: KeyPlatform = CURRENT_KEYS): string | null {
  const key = codeToAcceleratorKey(combo.code)
  if (!key) return null
  const parts: string[] = []
  if (combo.mod) parts.push('CommandOrControl')
  if (combo.meta && !(combo.mod && keys.primaryModifier === 'meta')) parts.push(keys.metaAccelerator)
  if (combo.ctrl && !(combo.mod && keys.primaryModifier === 'ctrl')) parts.push('Control')
  if (combo.alt) parts.push('Alt')
  if (combo.shift) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}
