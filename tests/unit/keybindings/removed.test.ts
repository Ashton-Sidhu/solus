import { describe, test, expect } from 'bun:test'
import { KEYBINDINGS } from '@solus/workspace-ui/lib/keybindings/manifest'
import { defaultCombo } from '@solus/workspace-ui/lib/keybindings/match'
import { KeybindingsContext } from '@solus/workspace-ui/lib/keybindings/dispatcher.svelte'
import {
  effectiveCombo,
  isOverridden,
  withBinding,
  withBindingRemoved,
  withoutBinding,
} from '@solus/workspace-ui/lib/keybindings/editing'

describe('removing a shortcut', () => {
  test('leaves a shipped binding with no key, and Reset brings the default back', () => {
    // WHY: a user who never wants ⌥W to continue in a worktree must be able to
    // turn it off, see that it is off, and undo that later.
    const removed = withBindingRemoved('global.continue-worktree', {})
    expect(effectiveCombo('global.continue-worktree', removed)).toBeNull()
    expect(isOverridden('global.continue-worktree', removed)).toBe(true)

    const restored = withoutBinding('global.continue-worktree', removed)
    expect(effectiveCombo('global.continue-worktree', restored))
      .toEqual(defaultCombo(KEYBINDINGS['global.continue-worktree']))
  })

  test('stores nothing for a binding that already ships without a key', () => {
    // WHY: an override is a difference from the default. Storing one here would
    // mark the row "changed" when it looks exactly like a fresh install.
    const assigned = withBinding('global.open-prs', { alt: true, shift: true, code: 'F9' }, {})
    expect('global.open-prs' in withBindingRemoved('global.open-prs', assigned)).toBe(false)
  })
})

describe('dispatching a removed shortcut', () => {
  // No DOM in the bun runtime; every event targets null, so a stand-in is enough.
  const globals = globalThis as { HTMLElement?: unknown }
  globals.HTMLElement ??= class {}

  test('its old key no longer fires the action or reaches the dispatcher', () => {
    const kb = new KeybindingsContext()
    kb.pushScope('global')
    let ran = 0
    kb.register('global.continue-worktree', () => { ran += 1 })
    let prevented = false
    const altW = {
      code: 'KeyW', altKey: true, shiftKey: false, metaKey: false, ctrlKey: false,
      repeat: false, target: null, preventDefault: () => { prevented = true },
    } as unknown as KeyboardEvent

    kb.setOverrides(withBindingRemoved('global.continue-worktree', {}))
    kb.dispatch(altW)
    expect(ran).toBe(0)
    expect(prevented).toBe(false)

    kb.setOverrides({})
    kb.dispatch(altW)
    expect(ran).toBe(1)
  })
})
