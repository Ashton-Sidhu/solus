import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import {
  floatingLayerOf,
  keyboardHoldsComposerOpen,
  selectionHoldsComposerOpen,
  shouldCollapseComposer,
} from '@solus/workspace-ui/components/input/lib/composer-collapse'

describe('a selection in the transcript', () => {
  const dom = new JSDOM(`<div id="transcript"><p id="line">hello there</p></div><p id="outside">x</p>`)
  const doc = dom.window.document
  const transcript = doc.getElementById('transcript')!
  const selectionIn = (node: Node, collapsed = false) => ({
    isCollapsed: collapsed,
    rangeCount: 1,
    getRangeAt: () => ({ commonAncestorContainer: node }) as Range,
  })

  test('a live selection inside the transcript holds the bar open', () => {
    // WHY: a drag-select blurs the editor. Folding mid-gesture moves the page
    // under the selection the user is still making.
    expect(selectionHoldsComposerOpen(selectionIn(doc.getElementById('line')!), transcript)).toBe(true)
  })

  test('a caret, an empty selection, or one elsewhere does not', () => {
    expect(selectionHoldsComposerOpen(selectionIn(doc.getElementById('line')!, true), transcript)).toBe(false)
    expect(selectionHoldsComposerOpen(null, transcript)).toBe(false)
    expect(selectionHoldsComposerOpen(selectionIn(doc.getElementById('outside')!), transcript)).toBe(false)
    expect(selectionHoldsComposerOpen(selectionIn(doc.getElementById('line')!), null)).toBe(false)
  })
})

describe('when the composer collapses', () => {
  const idle = { enabled: true, focused: false, recording: false }

  test('an idle bar collapses only when the setting allows it', () => {
    // WHY: the collapse is a preference with a way out. A user who turns it
    // off must get the full card back at rest, not a different collapse.
    expect(shouldCollapseComposer(idle)).toBe(true)
    expect(shouldCollapseComposer({ ...idle, enabled: false })).toBe(false)
  })

  test('a focused bar never collapses', () => {
    expect(shouldCollapseComposer({ ...idle, focused: true })).toBe(false)
  })

  test('a live mic holds the bar open', () => {
    // WHY: the waveform stands in for the text well, and its cancel and
    // confirm controls must not move under the hand that is about to use them.
    expect(shouldCollapseComposer({ ...idle, recording: true })).toBe(false)
  })
})

describe('where the keyboard is once a leave settles', () => {
  const dom = new JSDOM(`
    <div id="app">
      <div id="bar"><textarea id="editor"></textarea><button id="chip">Model</button></div>
      <button id="elsewhere">Transcript</button>
    </div>
    <div data-bits-floating-content-wrapper><div role="menu"><button id="menu-item">Opus</button></div></div>
    <div role="dialog"><input id="dialog-field" /></div>
  `)
  const doc = dom.window.document
  const root = doc.getElementById('bar')!
  const el = (id: string) => doc.getElementById(id)!
  const holds = (activeElement: Element | null, documentHasFocus = true) =>
    keyboardHoldsComposerOpen({ root, activeElement, documentHasFocus })

  test('focus on the bar’s own controls holds it open', () => {
    expect(holds(el('editor'))).toBe(true)
    expect(holds(el('chip'))).toBe(true)
  })

  test('a menu or dialog opened from the bar holds it open', () => {
    // WHY: the model chip and permission picker are portalled. Folding while
    // one is open would hide the trigger the menu is anchored to and returns
    // focus to.
    expect(holds(el('menu-item'))).toBe(true)
    expect(holds(el('dialog-field'))).toBe(true)
    expect(floatingLayerOf(el('menu-item'))?.hasAttribute('data-bits-floating-content-wrapper')).toBe(true)
    expect(floatingLayerOf(el('elsewhere'))).toBeNull()
  })

  test('focus elsewhere in the page, or on nothing, lets the bar fold', () => {
    // WHY: read from `activeElement` at the deadline, not from a focusout's
    // `relatedTarget`: Safari reports a clicked chip as a leave to nowhere,
    // and a return handed back a frame later was never a leave at all.
    expect(holds(el('elsewhere'))).toBe(false)
    expect(holds(doc.body)).toBe(false)
    expect(holds(null)).toBe(false)
  })

  test('a hidden window holds the bar’s shape', () => {
    // WHY: hiding the Electron window blurs the editor with no next target,
    // and there the bar must keep its shape for the return.
    expect(holds(doc.body, false)).toBe(true)
    expect(holds(null, false)).toBe(true)
  })
})
