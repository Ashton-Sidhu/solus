import { describe, test, expect } from 'bun:test'
import { KEYBINDINGS, bindingsForScope, comboHint } from '../../../src/renderer/lib/keybindings/manifest'
import { defaultCombo } from '../../../src/renderer/lib/keybindings/match'
import { KeybindingsContext } from '../../../src/renderer/lib/keybindings/dispatcher.svelte'
import type { BindingId } from '../../../src/renderer/lib/keybindings/manifest'

// Actions that are otherwise pointer- or palette-only. They ship unassigned so
// they claim no key from anyone, but they must still be registrable — the whole
// point is that a user can give one a key in Settings → Keybindings.
const UNASSIGNED: BindingId[] = [
  'global.switch-branch',
  'global.new-session-worktree',
  'global.new-session-in',
  'global.working-tree-diff',
  'global.open-prs',
  'global.review-pr',
  'global.open-plan',
  'global.open-document',
  'global.open-automation',
  'global.open-task',
  'global.create-task-in',
  'global.permission-menu',
  'global.add-server',
  'global.switch-server',
  'global.find-hosts',
]

describe('unassigned bindings', () => {
  test('resolve to no default combo, so nothing fires until a user assigns one', () => {
    for (const id of UNASSIGNED) {
      expect(defaultCombo(KEYBINDINGS[id])).toBeNull()
    }
  })

  test('claim no key from a binding that already has one', () => {
    // WHY: an unassigned action added later must never silently steal a
    // shortcut a user already relies on. A null default cannot collide, so the
    // guard is that no unassigned entry grew a combo — or a back-door alias —
    // by accident.
    const unassigned = new Set<string>(UNASSIGNED)
    const globals = bindingsForScope('global')
    expect(globals.some(([, def]) => def.combo !== null)).toBe(true)
    for (const [id, def] of globals) {
      if (!unassigned.has(id)) continue
      expect(def.combo).toBeNull()
      expect(def.aliases).toBeUndefined()
    }
  })

  test('render an empty inline hint rather than a stray bracket pair', () => {
    // WHY: comboHint feeds tooltips like `Attach file (⌥⇧A)`. An unassigned
    // action has nothing to teach, so the hint must be empty, not "null".
    for (const id of UNASSIGNED) {
      expect(comboHint(id)).toBe('')
    }
  })

  test('are listed in the global scope so Settings can offer them', () => {
    const globalIds = new Set(bindingsForScope('global').map(([id]) => id))
    for (const id of UNASSIGNED) {
      expect(globalIds.has(id)).toBe(true)
    }
  })
})

describe('dispatching an unassigned binding', () => {
  // The dispatcher yields to text fields via `target instanceof HTMLElement`,
  // which the bun runtime has no DOM for. Every event below targets null, so a
  // bare stand-in is enough to reach the scope scan.
  const globals = globalThis as { HTMLElement?: unknown }
  globals.HTMLElement ??= class {}

  const keydown =(init: { code: string; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }) => {
    let prevented = false
    return {
      event: {
        altKey: false,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        repeat: false,
        target: null,
        preventDefault: () => { prevented = true },
        ...init,
      } as unknown as KeyboardEvent,
      wasPrevented: () => prevented,
    }
  }

  test('stays silent until the user assigns a combo, then fires on it', () => {
    // WHY: this is the entire contract of shipping an action unassigned. It has
    // to be inert out of the box — no key of its own, nothing swallowed — and
    // it has to become a real shortcut the moment a user picks one.
    const kb = new KeybindingsContext()
    kb.pushScope('global')
    let ran = 0
    kb.register('global.open-prs', () => { ran += 1 })

    const first = keydown({ code: 'F9', altKey: true, shiftKey: true })
    kb.dispatch(first.event)
    expect(ran).toBe(0)
    expect(first.wasPrevented()).toBe(false)

    kb.setOverrides({ 'global.open-prs': { alt: true, shift: true, code: 'F9' } })
    const second = keydown({ code: 'F9', altKey: true, shiftKey: true })
    kb.dispatch(second.event)
    expect(ran).toBe(1)
    expect(second.wasPrevented()).toBe(true)
  })
})
