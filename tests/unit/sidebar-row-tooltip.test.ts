import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { closesRowTooltip } from '../../packages/workspace-ui/src/components/session/lib/row-tooltip'

/**
 * bits-ui closes a tooltip on its trigger's `pointerleave`. The session sidebar
 * moves row nodes when its order changes (a session starts work and its shelf
 * reorders), and the browser sends no `pointerleave` to a node that it moved
 * from under the pointer. The row tooltip then stayed on screen while the
 * person moved away and typed. A row's open tooltip must close on the first
 * pointer move that is not on the row, and must close when the sidebar makes
 * its rows quiet (Settings covers them).
 */
const dom = new JSDOM('<!doctype html><body><div id="row"><span id="title"></span></div><main id="composer"></main></body>')
const saved = { window: globalThis.window, Node: globalThis.Node }
const row = dom.window.document.getElementById('row') as unknown as HTMLElement
let cleanup: void | (() => void)

beforeAll(() => {
  Object.assign(globalThis, { window: dom.window, Node: dom.window.Node })
})
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})
afterAll(() => {
  Object.assign(globalThis, saved)
  dom.window.close()
})

function watch(state: { isOpen: boolean; isQuiet: boolean }) {
  cleanup = closesRowTooltip({
    isOpen: () => state.isOpen,
    isQuiet: () => state.isQuiet,
    close: () => (state.isOpen = false),
  })(row)
}

function moveOver(id: string) {
  dom.window.document.getElementById(id)!.dispatchEvent(new dom.window.Event('pointermove', { bubbles: true }))
}

test('an open row tooltip stays open while the pointer moves on the row', () => {
  const state = { isOpen: true, isQuiet: false }
  watch(state)
  moveOver('title')
  expect(state.isOpen).toBe(true)
})

test('an open row tooltip closes when the pointer moves off the row with no pointerleave', () => {
  const state = { isOpen: true, isQuiet: false }
  watch(state)
  moveOver('composer')
  expect(state.isOpen).toBe(false)
})

test('a row tooltip that goes quiet closes at once', () => {
  const state = { isOpen: true, isQuiet: true }
  watch(state)
  expect(state.isOpen).toBe(false)
})

test('a closed row tooltip ignores the pointer', () => {
  const state = { isOpen: false, isQuiet: false }
  watch(state)
  expect(cleanup).toBeUndefined()
})
