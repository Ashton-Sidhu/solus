import { describe, expect, test } from 'bun:test'
import { closeTargetPaneId } from '@solus/workspace-ui/components/layout/lib/workspace-body'
import { KEYBINDINGS } from '@solus/workspace-ui/lib/keybindings/manifest'
import { KeybindingsContext } from '@solus/workspace-ui/lib/keybindings/dispatcher.svelte'
import type { RouteRef } from '@solus/workspace-ui/contexts/workspace/routing/route-registry'

/**
 * Escape as the companion pane's key.
 *
 * The browser pane had no keyboard way out at all: every other companion
 * surface bound Escape for itself and the pane it sat in never did. The key now
 * belongs to the pane, whatever it holds — with the limits below, each of
 * which is a way the same press could have destroyed something else.
 */

function pane(id: string, name: RouteRef['name']) {
  return { id, base: { name, params: {} } as RouteRef }
}

describe('which pane Escape closes', () => {
  test('the companion the user is working in', () => {
    // WHY: Escape dismisses the thing you are in. A pane the user has not
    // focused is not that thing.
    const panes = [pane('aside-1', 'files'), pane('aside-2', 'browser')]
    expect(closeTargetPaneId(panes, 'aside-2')).toBe('aside-2')
    expect(closeTargetPaneId(panes, 'aside-1')).toBe('aside-1')
  })

  test('never reaches across from the leading pane', () => {
    // WHY: unlike ⌥M, this key is also the composer's — the slash menu, the
    // mention list, and the attachment preview all spend it. A press meant for
    // one of those must not take the browser beside it down.
    expect(closeTargetPaneId([pane('aside-1', 'browser')], 'lead')).toBeNull()
  })

  test('never closes a conversation', () => {
    // WHY: a split chat is a composer too, and a chat that vanishes under a
    // dismissed menu is the worst version of the bug above.
    expect(closeTargetPaneId([pane('aside-1', 'chat')], 'aside-1')).toBeNull()
    expect(closeTargetPaneId([pane('aside-1', 'draft')], 'aside-1')).toBeNull()
  })
})

describe('the close key against the rest of the keyboard', () => {
  // The dispatcher yields to text fields via `target instanceof HTMLElement`,
  // which the bun runtime has no DOM for; a bare stand-in reaches the scope scan.
  const globals = globalThis as { HTMLElement?: unknown }
  globals.HTMLElement ??= class {}

  const escape = () =>
    ({
      code: 'Escape',
      key: 'Escape',
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      repeat: false,
      target: null,
      preventDefault: () => {},
    }) as unknown as KeyboardEvent

  test('is one binding on the pane rather than one per surface', () => {
    // WHY: the maximize key was moved to the pane for the same reason — a
    // per-surface binding is how the browser pane ended up with none.
    expect(KEYBINDINGS['pane.close']).toMatchObject({ combo: { code: 'Escape' }, scope: 'global' })
    expect('browser-pane.close' in KEYBINDINGS).toBe(false)
    // An exclusive overlay owns Escape outright; the pane must not reach through it.
    expect(KEYBINDINGS['pane.close'].reserved).toBeUndefined()
  })

  test('yields to a surface that spends Escape itself', () => {
    // WHY: the diff panel closes its find bar, then its comment draft, then
    // itself. That ladder lives in its own scope above the pane's, so the pane
    // only answers once no surface in it wants the press.
    const kb = new KeybindingsContext()
    kb.pushScope('global')
    kb.pushScope('diff-panel')
    let paneClosed = 0
    let diffClosed = 0
    kb.register('pane.close', () => { paneClosed += 1 })
    kb.register('diff-panel.close', () => { diffClosed += 1 })

    kb.dispatch(escape())
    expect([paneClosed, diffClosed]).toEqual([0, 1])
  })

  test('lets the conversation find bar go first', () => {
    // WHY: both live in the global scope, so declaration order decides. What is
    // on top is what Escape means.
    const kb = new KeybindingsContext()
    kb.pushScope('global')
    let paneClosed = 0
    let findClosed = 0
    let findOpen = true
    kb.register('conversation.close-find', () => { findClosed += 1 }, { enabled: () => findOpen })
    kb.register('pane.close', () => { paneClosed += 1 })

    kb.dispatch(escape())
    expect([paneClosed, findClosed]).toEqual([0, 1])

    findOpen = false
    kb.dispatch(escape())
    expect([paneClosed, findClosed]).toEqual([1, 1])
  })

  test('does not reach through an exclusive overlay', () => {
    // WHY: the command palette closes on Escape. The pane behind it must still
    // be there when it does.
    const kb = new KeybindingsContext()
    kb.pushScope('global')
    kb.pushScope('command-palette', true)
    let paneClosed = 0
    let paletteClosed = 0
    kb.register('pane.close', () => { paneClosed += 1 })
    kb.register('command-palette.close', () => { paletteClosed += 1 })

    kb.dispatch(escape())
    expect([paneClosed, paletteClosed]).toEqual([0, 1])
  })
})
