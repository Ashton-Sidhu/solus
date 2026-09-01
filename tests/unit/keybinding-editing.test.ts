import { describe, expect, test } from 'bun:test'
import {
  ALL_LISTED_SCOPES,
  KEYBINDING_CATEGORIES,
  conflictLabels,
  effectiveCombo,
  matchesQuery,
  withBinding,
  withoutBinding,
  type BindingOverrides,
} from '../../packages/workspace-ui/src/lib/keybindings/editing'
import { KEYBINDINGS } from '../../packages/workspace-ui/src/lib/keybindings/manifest'
import { defaultCombo } from '../../packages/workspace-ui/src/lib/keybindings/match'

describe('binding overrides', () => {
  /**
   * Intent: an override is a *difference* from the shipped default. If rebinding
   * an action back to its own default stored a row anyway, the settings rail
   * would count it as changed, the row would say "changed" forever, and Reset
   * would appear to do nothing — the user could never get back to a clean state.
   */
  test('rebinding an action to its own default clears the override instead of storing it', () => {
    const fallback = defaultCombo(KEYBINDINGS['global.toggle-sidebar'])!
    const overrides = withBinding('global.toggle-sidebar', { alt: true, code: 'KeyY' }, {})
    expect(overrides['global.toggle-sidebar']).toBeDefined()

    const back = withBinding('global.toggle-sidebar', fallback, overrides)
    expect('global.toggle-sidebar' in back).toBe(false)
  })

  test('clearing an override restores the shipped default', () => {
    const overrides = withBinding('global.toggle-sidebar', { alt: true, code: 'KeyY' }, {})
    expect(effectiveCombo('global.toggle-sidebar', overrides)).toEqual({ alt: true, code: 'KeyY' })
    expect(effectiveCombo('global.toggle-sidebar', withoutBinding('global.toggle-sidebar', overrides)))
      .toEqual(defaultCombo(KEYBINDINGS['global.toggle-sidebar']))
  })
})

describe('binding list coverage', () => {
  test('lists every declared binding in the shortcuts modal and settings', () => {
    // WHY: both surfaces render the shared category list. A new scope that is
    // missing from it makes valid shortcuts impossible to discover or rebind.
    const declaredScopes = new Set(Object.values(KEYBINDINGS).map((binding) => binding.scope))
    const listedBindingIds = ALL_LISTED_SCOPES.flatMap((scope) =>
      Object.entries(KEYBINDINGS)
        .filter(([, binding]) => binding.scope === scope)
        .map(([bindingId]) => bindingId),
    )
    expect(new Set(ALL_LISTED_SCOPES)).toEqual(declaredScopes)
    expect(ALL_LISTED_SCOPES.length).toBe(declaredScopes.size)
    expect(KEYBINDING_CATEGORIES.flatMap((category) => category.scopes)).toEqual(ALL_LISTED_SCOPES)
    expect(new Set(listedBindingIds)).toEqual(new Set(Object.keys(KEYBINDINGS)))
    expect(listedBindingIds.length).toBe(Object.keys(KEYBINDINGS).length)
  })
})

describe('conflict reporting', () => {
  /**
   * Intent: conflicts are reported, not blocked — the user's last binding wins
   * and *both* rows say so. A one-sided report would leave the action that
   * silently lost the key looking healthy, which is exactly the state a user
   * cannot debug.
   */
  test('a rebind onto an occupied combo names the other command on both rows', () => {
    const settingsCombo = defaultCombo(KEYBINDINGS['global.settings'])!
    const overrides: BindingOverrides = withBinding('global.toggle-sidebar', settingsCombo, {})
    const conflicts = conflictLabels(overrides)

    expect(conflicts.get('global.toggle-sidebar')).toBe(KEYBINDINGS['global.settings'].label)
    expect(conflicts.get('global.settings')).toBe(KEYBINDINGS['global.toggle-sidebar'].label)
  })

  /**
   * Intent: a few shipped defaults collide deliberately (⌥M is claimed by both
   * the pane maximize and the project panel, resolved by `reserved` and by
   * handler `enabled`). Flagging those on a fresh install would put a conflict
   * warning in front of every user with nothing they could do about it.
   */
  test('shipped defaults alone report no conflicts', () => {
    expect(conflictLabels({}).size).toBe(0)
  })
})

describe('row search', () => {
  test('"unassigned" finds the actions that ship without a key', () => {
    const def = KEYBINDINGS['global.design-mode']
    expect(effectiveCombo('global.design-mode', {})).toBeNull()
    expect(matchesQuery(def, null, 'unassigned')).toBe(true)
    expect(matchesQuery(KEYBINDINGS['global.settings'], defaultCombo(KEYBINDINGS['global.settings']), 'unassigned'))
      .toBe(false)
  })

  test('a row is found by its keys as well as its name', () => {
    const def = KEYBINDINGS['global.toggle-sidebar']
    const combo = defaultCombo(def)!
    expect(matchesQuery(def, combo, 'sidebar')).toBe(true)
    expect(matchesQuery(def, combo, 'view')).toBe(true) // its group
    expect(matchesQuery(def, combo, 'nothing-like-this')).toBe(false)
  })
})
