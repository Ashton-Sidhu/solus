import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { maximizeTargetPaneId } from '@solus/workspace-ui/components/layout/lib/workspace-body'
import { KEYBINDINGS, bindingsForScope } from '@solus/workspace-ui/lib/keybindings/manifest'
import { KeybindingsContext } from '@solus/workspace-ui/lib/keybindings/dispatcher.svelte'
import type { BindingDef } from '@solus/workspace-ui/lib/keybindings/types'

describe('which pane the maximize key acts on', () => {
  test('follows focus into a companion pane', () => {
    // WHY: the key used to belong to the diff panel alone. Whatever the user is
    // working in on the right — a review, a plan, a split chat — is what a
    // maximize request means, so the target is the focused companion.
    expect(maximizeTargetPaneId(['aside-1', 'aside-2'], 'aside-2', null)).toBe('aside-2')
  })

  test('takes the last companion when focus is in the leading pane', () => {
    // WHY: typing in the composer is the normal state. The key must still reach
    // the pane beside it rather than doing nothing while the caret is in a chat.
    expect(maximizeTargetPaneId(['aside-1', 'aside-2'], 'lead', null)).toBe('aside-2')
  })

  test('restores the maximized pane from anywhere', () => {
    // WHY: a maximized pane covers the window, so focus can be sitting in a pane
    // the user cannot see. The same press must always be the way back.
    expect(maximizeTargetPaneId(['aside-1', 'aside-2'], 'lead', 'aside-1')).toBe('aside-1')
  })

  test('has no target when nothing sits beside the leading pane', () => {
    // WHY: only a companion pane is maximizable — the leading pane already owns
    // the column. With none open the key must fall through to the project panel.
    expect(maximizeTargetPaneId([], 'lead', null)).toBeNull()
  })
})

describe('the maximize key across the whole secondary pane', () => {
  // The dispatcher yields to text fields via `target instanceof HTMLElement`,
  // which the bun runtime has no DOM for; a bare stand-in reaches the scope scan.
  const globals = globalThis as { HTMLElement?: unknown }
  globals.HTMLElement ??= class {}

  const altM = () =>
    ({
      code: 'KeyM',
      altKey: true,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      repeat: false,
      target: null,
      preventDefault: () => {},
    }) as unknown as KeyboardEvent

  test('is one binding rather than one per surface', () => {
    // WHY: every companion surface needs the same way out of a half-width
    // column. A per-surface binding is how the diff panel ended up with the only
    // working key and the files pane with an unassigned one.
    expect(KEYBINDINGS['pane.maximize']).toMatchObject({
      combo: { alt: true, code: 'KeyM' },
      scope: 'global',
    })
    expect('diff-panel.maximize' in KEYBINDINGS).toBe(false)
  })

  test('claims ⌥M ahead of the project panel while a companion is open', () => {
    // WHY: both live in the global scope, so declaration order decides. A
    // companion minimizes the project rail anyway, which is why the pane wins.
    const kb = new KeybindingsContext()
    kb.pushScope('global')
    let maximized = 0
    let railToggled = 0
    let hasCompanion = true
    kb.register('pane.maximize', () => { maximized += 1 }, { enabled: () => hasCompanion })
    kb.register('global.toggle-project-panel', () => { railToggled += 1 })

    kb.dispatch(altM())
    expect([maximized, railToggled]).toEqual([1, 0])

    hasCompanion = false
    kb.dispatch(altM())
    expect([maximized, railToggled]).toEqual([1, 1])
  })

  test('reaches through a pane scope that no longer spends ⌥M', () => {
    // WHY: the files pane and the file editor claimed ⌥M for the Markdown view,
    // and a pane scope sits above the global one — so the shared key silently
    // did something else in exactly the two panes narrow enough to need it. Both
    // toggles moved to ⌥R so one key means one thing in every pane.
    const kb = new KeybindingsContext()
    kb.pushScope('global')
    kb.pushScope('files-pane')
    kb.pushScope('file-editor')
    let maximized = 0
    let markdownToggled = 0
    kb.register('pane.maximize', () => { maximized += 1 })
    kb.register('files-pane.toggle-markdown', () => { markdownToggled += 1 })
    kb.register('file-editor.toggle-markdown', () => { markdownToggled += 1 })

    kb.dispatch(altM())
    expect([maximized, markdownToggled]).toEqual([1, 0])

    kb.dispatch({ ...altM(), code: 'KeyR' } as KeyboardEvent)
    expect([maximized, markdownToggled]).toEqual([1, 1])
  })

  test('survives an exclusive scope that would otherwise swallow the keyboard', () => {
    // WHY: a plan or document shell opens inline in a companion pane and pushes
    // an exclusive scope, so nothing below it fires. That is the one pane most in
    // need of the full window, and the key that widens it would have been eaten.
    const kb = new KeybindingsContext()
    kb.pushScope('global')
    kb.pushScope('plan-modal', true)
    let maximized = 0
    let commentsToggled = 0
    kb.register('pane.maximize', () => { maximized += 1 })
    kb.register('plan-modal.toggle-comments', () => { commentsToggled += 1 })

    kb.dispatch(altM())
    expect([maximized, commentsToggled]).toEqual([1, 0])

    // The exclusive scope still owns everything it did not give away.
    let sidebarToggled = 0
    kb.register('global.toggle-sidebar', () => { sidebarToggled += 1 })
    kb.dispatch({ ...altM(), code: 'KeyB', altKey: false, metaKey: true } as KeyboardEvent)
    expect(sidebarToggled).toBe(0)
  })

  test('is the only binding allowed to claim ⌥M', () => {
    // WHY: the key is reserved. A scope-local ⌥M silently wins over it wherever
    // that scope is up, which is exactly the bug the files pane shipped.
    const claimants = Object.entries(KEYBINDINGS as Record<string, BindingDef>).filter(
      ([, def]) => def.combo?.code === 'KeyM' && def.combo.alt === true && def.combo.shift !== true,
    )
    for (const [id, def] of claimants) {
      // The project panel shares the key by declaration order in the same scope:
      // it answers only when no companion pane is open. Nothing else may.
      expect(['pane.maximize', 'global.toggle-project-panel']).toContain(id)
      expect(def.scope).toBe('global')
    }
  })

  test('leaves the diff panel with no maximize binding of its own', () => {
    // WHY: a surviving diff-panel entry would shadow the shared key in exactly
    // the pane the generalization started from.
    const diffPanel = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/components/diff/DiffPanel.svelte'),
      'utf8',
    )
    expect(diffPanel).not.toContain('onToggleMaximize')
    expect(bindingsForScope('diff-panel').some(([id]) => id.endsWith('.maximize'))).toBe(false)
  })
})
