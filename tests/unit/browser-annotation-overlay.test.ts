import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import {
  BROWSER_ANNOTATION_TOOLS,
  type BrowserAnnotateOp,
  type BrowserAnnotationTool,
} from '@solus/contracts/browser-types'
import {
  annotationOpExpression,
  annotationSyncExpression,
} from '@solus/server/browser/annotation-script'

/**
 * The annotation overlay, actually run.
 *
 * It is a string of JavaScript evaluated inside the guest, so nothing in the
 * type system or the build touches it — every bug it has ever had shipped
 * silently and was found by hand. These tests put it in a real DOM and drive it
 * with real events, because the defects worth guarding are behavioural: a
 * half-drawn stroke surviving the pane's poll, a gesture ending off the edge of
 * the page, a mark arriving from a client that could not deliver a drag.
 */

interface OverlayAnnotation {
  id: string
  tool: string
  rect: { x: number; y: number; width: number; height: number }
  path?: { x: number; y: number }[]
  elements?: {
    role: string
    label: string
    rect: { x: number; y: number; width: number; height: number }
    ref: string
    identifier?: string
    source?: { file: string; line: number; column: number }
  }[]
  number?: number
}

interface TestElementInput {
  tag: 'button' | 'div' | 'input' | 'span'
  rect: { x: number; y: number; width: number; height: number }
  label?: string
  id?: string
  hidden?: boolean
  source?: { file: string; line: number; column: number }
}

function overlay() {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    runScripts: 'outside-only',
  })
  const { window } = dom
  Object.defineProperty(window, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    },
  })

  function run(expression: string): { annotations: OverlayAnnotation[] } {
    // SAFETY: every expression here ends in `state.read()`, which returns the
    // JSON string the registry parses on the real path.
    return JSON.parse(window.eval(expression) as string)
  }

  /** The overlay listens in the capture phase on `window`, so what it reads off
   *  an event is `clientX`/`clientY` and nothing else. A MouseEvent carries both
   *  and jsdom constructs it; the listener never asks which class it came from. */
  function pointer(type: string, x: number, y: number) {
    window.dispatchEvent(
      new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }),
    )
  }

  function addElement(input: TestElementInput) {
    const element = window.document.createElement(input.tag)
    if (input.label) element.setAttribute('aria-label', input.label)
    if (input.id) element.id = input.id
    if (input.hidden) element.style.display = 'none'
    if (input.source) {
      Object.defineProperty(element, '__svelte_meta', {
        value: { loc: input.source },
      })
    }
    const { x, y, width, height } = input.rect
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({
        x,
        y,
        width,
        height,
        top: y,
        right: x + width,
        bottom: y + height,
        left: x,
      }),
    })
    window.document.querySelector('main')?.appendChild(element)
    return element
  }

  return {
    arm: (tool: BrowserAnnotationTool | null) => run(annotationSyncExpression(tool)),
    /** What the pane's 500ms poll does: read the marks, re-arming on the way in
     *  so a reloaded page gets its overlay back. */
    poll: (tool: BrowserAnnotationTool | null) => run(annotationSyncExpression(tool)),
    apply: (op: BrowserAnnotateOp) => run(annotationOpExpression(op)),
    /** What the overlay actually painted. Reading the marks back proves the
     *  bookkeeping; only this proves anything reached the page. */
    painted: () =>
      window.document.querySelector('[data-solus-browser-annotations]')?.innerHTML ?? '',
    down: (x: number, y: number) => pointer('pointerdown', x, y),
    move: (x: number, y: number) => pointer('pointermove', x, y),
    up: (x: number, y: number) => pointer('pointerup', x, y),
    cancel: (x: number, y: number) => pointer('pointercancel', x, y),
    blur: () => window.dispatchEvent(new window.Event('blur')),
    addElement,
  }
}

describe('drawing on the guest overlay', () => {
  test('keeps a stroke that the pane polls in the middle of', () => {
    // WHY: this is the bug. The pane reads the marks twice a second while a tool
    // is armed, and that read re-arms the tool on the way in. Re-arming used to
    // reset the gesture state, so every freehand stroke was wiped from under the
    // user's own hand within half a second of starting it. Freehand was, in
    // practice, impossible.
    const page = overlay()
    page.arm('draw')

    page.down(10, 10)
    page.move(40, 40)

    page.poll('draw')

    page.move(80, 80)
    page.up(80, 80)

    const state = page.arm('draw')
    expect(state.annotations).toHaveLength(1)
    expect(state.annotations[0]?.tool).toBe('draw')
    // Every point, including the two from before the poll.
    expect(state.annotations[0]?.path?.[0]).toEqual({ x: 10, y: 10 })
    expect(state.annotations[0]?.path?.at(-1)).toEqual({ x: 80, y: 80 })
  })

  test('keeps a box selection that the pane polls in the middle of', () => {
    const page = overlay()
    page.addElement({
      tag: 'button',
      rect: { x: 30, y: 30, width: 60, height: 30 },
      label: 'Save',
    })
    page.arm('region')
    page.down(20, 20)
    page.move(60, 50)
    page.poll('region')
    page.move(120, 90)
    page.up(120, 90)

    const state = page.arm('region')
    expect(state.annotations).toHaveLength(1)
    expect(state.annotations[0]?.rect).toEqual({ x: 30, y: 30, width: 60, height: 30 })
    expect(state.annotations[0]?.elements?.map((element) => element.label)).toEqual(['Save'])
  })

  test('still re-arms when the tool actually changes', () => {
    // WHY: the guard above must not turn setTool into a no-op. A page that
    // reloaded comes back with no tool armed, and the poll is what gives it one
    // back — that path is the whole reason the read re-arms at all.
    const page = overlay()
    page.arm('draw')
    page.down(10, 10)
    page.move(40, 40)
    // Switching tools abandons the gesture, which is the correct reading of
    // "I meant to do something else".
    page.arm('region')
    page.up(40, 40)
    expect(page.arm('region').annotations).toHaveLength(0)
  })

  test('finishes a stroke that ends off the edge of the page', () => {
    // WHY: release outside the guest never reports a pointerup. Without this the
    // drag stays live forever and the next press continues the abandoned stroke
    // from wherever it was left.
    const page = overlay()
    page.arm('draw')
    page.down(10, 10)
    page.move(50, 50)
    page.cancel(50, 50)
    expect(page.arm('draw').annotations).toHaveLength(1)

    page.down(200, 200)
    page.move(240, 240)
    page.blur()
    const state = page.arm('draw')
    expect(state.annotations).toHaveLength(2)
    expect(state.annotations[1]?.path?.[0]).toEqual({ x: 200, y: 200 })
  })

  test('drops a press that never became a gesture', () => {
    // WHY: a mistimed click is not a rectangle and a tap is not a stroke. Either
    // one kept would be an invisible entry in the message sent to the agent.
    const page = overlay()
    page.arm('region')
    page.down(30, 30)
    page.up(31, 31)
    expect(page.arm('region').annotations).toHaveLength(0)
  })

  test('drops a box that contains no elements', () => {
    // WHY: the box is a DOM selection, not a rectangle annotation. An empty
    // marquee must not create a blank comment target.
    const page = overlay()
    page.arm('region')
    page.down(20, 20)
    page.move(120, 90)
    page.up(120, 90)
    expect(page.arm('region').annotations).toHaveLength(0)
  })
})

describe('a gesture from a client that cannot deliver a drag', () => {
  test('commits a whole stroke as one mark', () => {
    // WHY: a streamed surface is a picture of the page — the guest never sees
    // the pointer. Freehand and region simply did not exist on web or mobile
    // until the client could hand the finished gesture over in one op.
    const page = overlay()
    page.arm('draw')
    const state = page.apply({
      kind: 'mark',
      tool: 'draw',
      path: [
        { x: 5, y: 5 },
        { x: 25, y: 45 },
        { x: 60, y: 20 },
      ],
    })
    expect(state.annotations).toHaveLength(1)
    expect(state.annotations[0]?.tool).toBe('draw')
    // The bounds are computed in the guest, so both clients describe a mark the
    // same way whichever side captured it.
    expect(state.annotations[0]?.rect).toEqual({ x: 5, y: 5, width: 55, height: 40 })
  })

  test('a box collects every visible element fully inside it as one mark', () => {
    const page = overlay()
    page.addElement({
      tag: 'button',
      rect: { x: 20, y: 20, width: 30, height: 20 },
      label: 'Save',
      id: 'save',
      source: { file: 'src/Save.svelte', line: 12, column: 2 },
    })
    page.addElement({
      tag: 'span',
      rect: { x: 60, y: 25, width: 20, height: 10 },
      label: 'Status',
    })
    // It overlaps the right edge, so it is not within the box.
    page.addElement({
      tag: 'input',
      rect: { x: 80, y: 20, width: 30, height: 20 },
      label: 'Partly outside',
    })
    page.addElement({
      tag: 'div',
      rect: { x: 30, y: 30, width: 10, height: 10 },
      label: 'Hidden',
      hidden: true,
    })
    page.arm('region')
    const state = page.apply({
      kind: 'mark',
      tool: 'region',
      rect: { x: 10, y: 12, width: 80, height: 40 },
    })
    expect(state.annotations).toHaveLength(1)
    expect(state.annotations[0]?.tool).toBe('region')
    expect(state.annotations[0]?.elements?.map((element) => element.label)).toEqual([
      'Save',
      'Status',
    ])
    expect(state.annotations[0]?.elements?.[0]?.source).toEqual({
      file: 'src/Save.svelte',
      line: 12,
      column: 2,
    })
    expect(state.annotations[0]?.rect).toEqual({ x: 20, y: 20, width: 60, height: 20 })
  })

  test('a remote box browser outlines included elements before it commits', () => {
    // WHY: a streamed surface cannot inspect the DOM itself. Its coalesced
    // browser rectangle must still make the guest show the current membership,
    // and it must remain transient until release.
    const page = overlay()
    page.addElement({
      tag: 'button',
      rect: { x: 20, y: 20, width: 30, height: 20 },
      label: 'Save',
    })
    const browser = page.apply({
      kind: 'browserRegion',
      rect: { x: 10, y: 10, width: 60, height: 50 },
    })
    expect(browser.annotations).toHaveLength(0)
    expect(page.painted()).toContain('1 element')

    const committed = page.apply({
      kind: 'browserRegion',
      rect: { x: 10, y: 10, width: 60, height: 50 },
      commit: true,
    })
    expect(committed.annotations).toHaveLength(1)
    expect(committed.annotations[0]?.elements?.[0]?.label).toBe('Save')
  })

  test('holds a forwarded gesture to the same rules as a drawn one', () => {
    // WHY: the drop rules live in the guest, not in the client, so a stray tap
    // forwarded by a phone is discarded exactly where a stray click on the
    // desktop is.
    const page = overlay()
    page.arm('draw')
    page.apply({ kind: 'mark', tool: 'draw', path: [{ x: 5, y: 5 }] })
    page.apply({ kind: 'mark', tool: 'region', rect: { x: 5, y: 5, width: 2, height: 2 } })
    expect(page.arm('draw').annotations).toHaveLength(0)
  })
})

/**
 * The tools beyond pick/region/draw: a word on the page and the pointer handed
 * back.
 */
describe('the rest of the annotation tools', () => {
  test('hands the pointer back to the page under select', () => {
    // WHY: this is the whole tool. The marks stay up and the tools stay open,
    // but a click goes where it was aimed — which is how a user gets through a
    // flow to the screen they actually want to mark.
    const page = overlay()
    page.arm('select')
    page.down(50, 50)
    page.move(90, 90)
    page.up(90, 90)
    expect(page.arm('select').annotations).toHaveLength(0)
  })
})

/**
 * What the overlay paints.
 *
 * Every test above reads the marks back as JSON, which passes just as happily
 * when nothing is drawn on the page at all — the bookkeeping and the picture are
 * separate failures, and only one of them was covered. These assert the picture.
 */
describe('what the overlay paints', () => {
  test('installs a layer with a marks group and a live group', () => {
    // WHY: the two groups are redrawn on different schedules. If the install
    // throws — a syntax error in the injected string, an API the guest lacks —
    // nothing renders and no tool works, which is indistinguishable from the
    // feature being switched off.
    const page = overlay()
    page.arm('pick')
    expect(page.painted()).toContain('<svg')
    expect(page.painted().match(/<g>/g) ?? []).toHaveLength(2)
  })

  test('installs cleanly for every tool the contract declares', () => {
    // WHY: the injected script is a template literal. A backtick or a `${` in a
    // comment inside it ends the string early, and the expression then fails to
    // evaluate in the guest with nothing but a rejected RPC to show for it. That
    // has happened; this is what would have caught it.
    for (const tool of BROWSER_ANNOTATION_TOOLS) {
      const page = overlay()
      expect(() => page.arm(tool)).not.toThrow()
      expect(page.painted()).toContain('<svg')
    }
  })

  test('a box paints every element it selected and states the count', () => {
    // WHY: a marquee that leaves only its outer rectangle gives no proof of
    // which DOM nodes it collected. Each selected node needs its own outline.
    const page = overlay()
    page.addElement({
      tag: 'button',
      rect: { x: 30, y: 30, width: 30, height: 20 },
      label: 'Save',
    })
    page.addElement({
      tag: 'span',
      rect: { x: 70, y: 30, width: 20, height: 20 },
      label: 'Status',
    })
    page.arm('region')
    page.down(20, 20)
    page.move(65, 70)
    expect(page.painted()).toContain('1 element')
    page.move(120, 90)
    // The gesture in progress states both its boundary and its current members
    // while the pointer is still down.
    expect(page.painted()).toContain('stroke-dasharray="4 3"')
    expect(page.painted()).toContain('2 elements')
    expect(page.arm('region').annotations).toHaveLength(0)
    page.up(120, 90)

    const painted = page.painted()
    // One grouped boundary plus one outline per selected element.
    expect(painted.match(/<rect/g) ?? []).toHaveLength(3)
    expect(painted).toContain('2 elements')
    expect(painted).toContain('stroke-dasharray="4 3"')
  })

  test('draws a stroke for freehand', () => {
    const drawn = overlay()
    drawn.arm('draw')
    drawn.down(10, 10)
    drawn.move(40, 40)
    drawn.move(80, 20)
    drawn.up(80, 20)
    expect(drawn.painted()).toContain('<polyline')
  })

  test('paints nothing at all under select', () => {
    // WHY: select hands the pointer back. Marks already made stay painted; the
    // gesture itself leaves nothing.
    const page = overlay()
    page.arm('select')
    page.down(50, 50)
    page.move(90, 90)
    page.up(90, 90)
    expect(page.painted()).not.toContain('<rect')
    expect(page.painted()).not.toContain('<polyline')
  })

  test('takes a mark off the page when it is removed', () => {
    // WHY: the reverse state. Removing a mark from the list and leaving it drawn
    // on the page is worse than not removing it.
    const page = overlay()
    page.addElement({
      tag: 'button',
      rect: { x: 30, y: 30, width: 40, height: 20 },
      label: 'Save',
    })
    page.arm('region')
    page.down(20, 20)
    page.move(120, 90)
    page.up(120, 90)
    const [mark] = page.arm('region').annotations
    expect(page.painted()).toContain('<rect')
    page.apply({ kind: 'remove', annotationId: mark?.id ?? '' })
    expect(page.painted()).not.toContain('<rect')
  })
})
