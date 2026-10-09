import type { GuestShortcut } from '@solus/contracts/host-api'
import { KEYBINDINGS, type BindingId } from './manifest'
import { effectiveCombo, type BindingOverrides } from './editing'
import type { BindingDef, KeyCombo, Scope } from './types'

/** The scopes that still apply while a browser page has focus. */
const GUEST_SCOPES: ReadonlySet<Scope> = new Set(['global', 'browser-pane'])

/**
 * The Solus shortcuts a focused browser page gives up.
 *
 * Only combos with ⌥ qualify: that is the Solus shortcut namespace (⌥⇧ for
 * global commands, ⌥ for a sub-page). ⌘ and ⌃ combos stay with the page,
 * because pages bind them themselves — ⌘K, ⌘F, ⌘B in an editor — and a
 * person working in a page expects the page to answer them.
 *
 * Follows the user's overrides, so a rebound shortcut is the one forwarded.
 */
export function guestShortcuts(overrides: BindingOverrides, mac: boolean): GuestShortcut[] {
  const shortcuts: GuestShortcut[] = []
  const seen = new Set<string>()
  // SAFETY: KEYBINDINGS is a closed const object, so its keys are BindingIds.
  for (const id of Object.keys(KEYBINDINGS) as BindingId[]) {
    const def: BindingDef = KEYBINDINGS[id]
    if (!GUEST_SCOPES.has(def.scope)) continue
    const combo = effectiveCombo(id, overrides)
    // A removed shortcut drops its aliases too, as in the dispatcher.
    const combos = overrides[id] === null ? [] : [combo, ...(def.aliases ?? [])]
    for (const candidate of combos) {
      if (!candidate?.alt) continue
      const shortcut = resolve(candidate, mac)
      const key = JSON.stringify(shortcut)
      if (seen.has(key)) continue
      seen.add(key)
      shortcuts.push(shortcut)
    }
  }
  return shortcuts
}

function resolve(combo: KeyCombo, mac: boolean): GuestShortcut {
  return {
    code: combo.code,
    alt: !!combo.alt,
    shift: !!combo.shift,
    meta: !!combo.meta || (!!combo.mod && mac),
    ctrl: !!combo.ctrl || (!!combo.mod && !mac),
  }
}

/** The keystroke the guest gave up, as the dispatcher reads one. It has no
 *  target, so the dispatcher never treats it as typing in a field. */
export function guestShortcutEvent(shortcut: GuestShortcut): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    code: shortcut.code,
    altKey: shortcut.alt,
    shiftKey: shortcut.shift,
    metaKey: shortcut.meta,
    ctrlKey: shortcut.ctrl,
    cancelable: true,
  })
}
