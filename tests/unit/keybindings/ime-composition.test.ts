import { describe, expect, test } from 'bun:test'
import { KeybindingsContext } from '@solus/workspace-ui/lib/keybindings/dispatcher.svelte'

// The bun runtime has no DOM. The dispatcher asks `instanceof HTMLElement` of
// the target; another test file may have installed a stand-in already.
const globals = globalThis as { HTMLElement?: new () => object }
globals.HTMLElement ??= class {}

function escape(composition: { isComposing?: boolean; keyCode?: number } = {}) {
  return {
    code: 'Escape',
    key: 'Escape',
    isComposing: composition.isComposing ?? false,
    keyCode: composition.keyCode ?? 27,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    target: null,
    preventDefault: () => {},
  } as unknown as KeyboardEvent
}

describe('shortcuts during an IME composition', () => {
  test('an Escape that belongs to a composition does not run the bound handler', () => {
    // WHY: Escape inside a Japanese or Chinese composition cancels the
    // composition. If it also runs a binding, it closes the palette sub-page,
    // the go-to-file picker, or project search, and the typed text is lost.
    const ctx = new KeybindingsContext()
    ctx.pushScope('global')
    let closed = 0
    ctx.register('pane.close', () => { closed++ })

    ctx.dispatch(escape({ isComposing: true }))
    // Safari reports the key that ends a composition with isComposing false.
    ctx.dispatch(escape({ isComposing: false, keyCode: 229 }))
    expect(closed).toBe(0)

    ctx.dispatch(escape())
    expect(closed).toBe(1)
  })
})
