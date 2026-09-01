import type { BindingDef, KeyCombo } from './types'

export const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

// The web shell tags the document root with `solus-web` (same signal
// settings.context uses). Browsers reserve combos like ⌘T/⌘W/⌘N that a page
// can't preventDefault, so web bindings fall back to a non-reserved default.
export const IS_WEB =
  typeof document !== 'undefined' && document.documentElement.classList.contains('solus-web')

/** The effective default combo for the current platform (web variant on web). */
export function defaultCombo(def: BindingDef): KeyCombo {
  return IS_WEB && def.web ? def.web : def.combo
}

export function eventMatches(e: KeyboardEvent, combo: KeyCombo): boolean {
  if (e.code !== combo.code) return false
  if (!!combo.alt !== e.altKey) return false
  if (!!combo.shift !== e.shiftKey) return false
  const wantsMeta = combo.mod ? isMac : !!combo.meta
  const wantsCtrl = combo.mod ? !isMac : !!combo.ctrl
  if (wantsMeta !== e.metaKey) return false
  if (wantsCtrl !== e.ctrlKey) return false
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

const KEY_SYMBOLS: Record<string, string> = {
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
}

function codeToLabel(code: string): string {
  if (code in KEY_SYMBOLS) return KEY_SYMBOLS[code]
  const m = code.match(/^Key([A-Z])$/)
  if (m) return m[1]
  const d = code.match(/^Digit(\d)$/)
  if (d) return d[1]
  return code
}

export function formatCombo(combo: KeyCombo): string[] {
  const keys: string[] = []
  if (combo.mod || (isMac && combo.meta) || (!isMac && combo.ctrl)) keys.push('⌘')
  else if (combo.meta) keys.push('⌘')
  else if (combo.ctrl) keys.push('⌃')
  if (combo.alt) keys.push('⌥')
  if (combo.shift) keys.push('⇧')
  keys.push(codeToLabel(combo.code))
  return keys
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
export function comboFromEvent(e: KeyboardEvent): KeyCombo | null {
  if (MODIFIER_CODES.has(e.code)) return null
  const combo: KeyCombo = { code: e.code }
  if (e.altKey) combo.alt = true
  if (e.shiftKey) combo.shift = true
  if (isMac) {
    if (e.metaKey) combo.mod = true
    if (e.ctrlKey) combo.ctrl = true
  } else {
    if (e.ctrlKey) combo.mod = true
    if (e.metaKey) combo.meta = true
  }
  return combo
}

/** Resolve a combo's primary (meta) / secondary (ctrl) modifiers for the platform. */
function effectiveMods(combo: KeyCombo): { meta: boolean; ctrl: boolean } {
  return {
    meta: combo.mod ? isMac : !!combo.meta,
    ctrl: combo.mod ? !isMac : !!combo.ctrl,
  }
}

/** Structural equality treating `mod` as the platform's meta/ctrl. */
export function comboEquals(a: KeyCombo, b: KeyCombo): boolean {
  if (a.code !== b.code) return false
  if (!!a.alt !== !!b.alt) return false
  if (!!a.shift !== !!b.shift) return false
  const ma = effectiveMods(a)
  const mb = effectiveMods(b)
  return ma.meta === mb.meta && ma.ctrl === mb.ctrl
}

const ACCEL_KEY_NAMES: Record<string, string> = {
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
}

function codeToAcceleratorKey(code: string): string | null {
  if (code in ACCEL_KEY_NAMES) return ACCEL_KEY_NAMES[code]
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
 * as an accelerator. `mod` maps to CommandOrControl.
 */
export function comboToAccelerator(combo: KeyCombo): string | null {
  const key = codeToAcceleratorKey(combo.code)
  if (!key) return null
  const parts: string[] = []
  if (combo.mod) parts.push('CommandOrControl')
  else {
    if (combo.meta) parts.push('Command')
    if (combo.ctrl) parts.push('Control')
  }
  if (combo.alt) parts.push('Alt')
  if (combo.shift) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}
