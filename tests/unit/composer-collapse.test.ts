import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import {
  floatingLayerOf,
  focusDestinationAfterFocusOut,
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
  const idle = { enabled: true, focused: false, recording: false, refocusPending: false }

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

  test('a mic that has just settled holds the bar open until the keyboard is back', () => {
    // WHY: the waveform lets go and the editor is refocused a frame or two
    // later. Folding in that gap painted a collapsed bar that sprang open
    // again as soon as focus landed — a visible stutter after every dictation.
    expect(shouldCollapseComposer({ ...idle, refocusPending: true })).toBe(false)
  })
})

describe('where focus went when the bar lost it', () => {
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

  test('moving between the bar’s own controls is not leaving', () => {
    expect(
      focusDestinationAfterFocusOut({ root, relatedTarget: el('chip'), documentHasFocus: true }),
    ).toBe('inside')
  })

  test('a menu opened from the bar keeps it open', () => {
    // WHY: the model chip and permission picker are portalled. Collapsing on
    // that focusout would hide the trigger the open menu is anchored to and
    // returns focus to.
    expect(
      focusDestinationAfterFocusOut({ root, relatedTarget: el('menu-item'), documentHasFocus: true }),
    ).toBe('menu')
    expect(
      focusDestinationAfterFocusOut({ root, relatedTarget: el('dialog-field'), documentHasFocus: true }),
    ).toBe('menu')
    expect(floatingLayerOf(el('menu-item'))?.hasAttribute('data-bits-floating-content-wrapper')).toBe(true)
    expect(floatingLayerOf(el('elsewhere'))).toBeNull()
  })

  test('focus landing elsewhere in the page is leaving', () => {
    expect(
      focusDestinationAfterFocusOut({ root, relatedTarget: el('elsewhere'), documentHasFocus: true }),
    ).toBe('left')
  })

  test('a click on nothing focusable is leaving, but a hidden window is not', () => {
    // WHY: clicking the transcript blurs the editor with no next target and
    // should collapse the bar. Hiding the Electron window also blurs it with
    // no next target, and there the bar must keep its shape for the return.
    expect(
      focusDestinationAfterFocusOut({ root, relatedTarget: null, documentHasFocus: true }),
    ).toBe('left')
    expect(
      focusDestinationAfterFocusOut({ root, relatedTarget: null, documentHasFocus: false }),
    ).toBe('window')
  })
})
