import { describe, expect, test } from 'bun:test'
import { KeybindingsContext } from '@solus/workspace-ui/lib/keybindings/dispatcher.svelte'
import { isMac } from '@solus/workspace-ui/lib/keybindings/match'

// The bun runtime has no DOM. A stand-in element answers `closest` for the one
// selector the dispatcher asks about: whether it sits in a native modal dialog.
// Another test file may have installed a bare `HTMLElement` already, so the
// stand-in extends whichever one is there.
const globals = globalThis as { HTMLElement?: new () => object }
globals.HTMLElement ??= class {}
class Element extends globals.HTMLElement {
  constructor(readonly inModalDialog: boolean) { super() }
  closest(selector: string): Element | null {
    return selector === 'dialog:modal' && this.inModalDialog ? this : null
  }
}

function keydown(code: string, modifiers: { mod?: boolean; alt?: boolean } = {}, target: unknown = null) {
  return {
    code,
    altKey: modifiers.alt ?? false,
    shiftKey: false,
    metaKey: !!modifiers.mod && isMac,
    ctrlKey: !!modifiers.mod && !isMac,
    repeat: false,
    target,
    preventDefault: () => {},
  } as unknown as KeyboardEvent
}

function workspace() {
  const ctx = new KeybindingsContext()
  ctx.pushScope('global')
  const fired: string[] = []
  ctx.register('global.command-palette', () => { fired.push('palette') })
  ctx.register('pane.maximize', () => { fired.push('maximize') })
  ctx.register('document-modal.close', () => { fired.push('close document') })
  return { ctx, fired }
}

describe('shortcuts while a modal dialog is open', () => {
  test('a modal dialog scope keeps ⌘K from opening the palette over it', () => {
    // WHY: a confirmation or history dialog owns the keyboard. A global
    // shortcut that fires behind it opens a second surface the user cannot see
    // or reach until the dialog closes.
    const { ctx, fired } = workspace()
    const closeDialog = ctx.pushScope('modal-dialog', true)
    ctx.dispatch(keydown('KeyK', { mod: true }))
    expect(fired).toEqual([])
    closeDialog()
    ctx.dispatch(keydown('KeyK', { mod: true }))
    expect(fired).toEqual(['palette'])
  })

  test('a dialog opened over a document modal also holds back the document keys', () => {
    // WHY: the history dialog opens from a document modal, which has its own
    // exclusive scope. Escape must close the dialog, not the document under it.
    const { ctx, fired } = workspace()
    ctx.pushScope('document-modal', true)
    ctx.pushScope('modal-dialog', true)
    ctx.dispatch(keydown('Escape'))
    expect(fired).toEqual([])
  })

  test('a native modal dialog holds back every scope, even an exclusive one', () => {
    // WHY: a `showModal()` dialog sits in the top layer, above every surface
    // that pushed a scope, so a keystroke typed in it belongs to it alone.
    const { ctx, fired } = workspace()
    ctx.pushScope('document-modal', true)
    const inDialog = new Element(true)
    ctx.dispatch(keydown('Escape', {}, inDialog))
    ctx.dispatch(keydown('KeyK', { mod: true }, inDialog))
    expect(fired).toEqual([])
    ctx.dispatch(keydown('Escape', {}, new Element(false)))
    expect(fired).toEqual(['close document'])
  })

  test('a reserved binding still works over a modal', () => {
    // WHY: a reserved binding means the same thing under every surface; the
    // exclusive rule already lets it through, and a modal follows that rule.
    const { ctx, fired } = workspace()
    ctx.pushScope('modal-dialog', true)
    ctx.dispatch(keydown('KeyM', { alt: true }))
    ctx.dispatch(keydown('KeyM', { alt: true }, new Element(true)))
    expect(fired).toEqual(['maximize', 'maximize'])
  })
})
