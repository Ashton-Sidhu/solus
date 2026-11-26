import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createSidebarListMotion } from '@solus/workspace-ui/components/session/lib/sidebar-list-motion.svelte'

type Played = { node: Element; keyframes: Keyframe[]; options?: KeyframeAnimationOptions }

function setup(options: { reducedMotion?: boolean } = {}) {
  const dom = new JSDOM('<div id="list"></div>', { pretendToBeVisual: true })
  const window = dom.window
  window.matchMedia = () => ({ matches: options.reducedMotion ?? false }) as MediaQueryList
  const played: Played[] = []
  window.HTMLElement.prototype.animate = function (keyframes: Keyframe[], options?: KeyframeAnimationOptions) {
    played.push({ node: this, keyframes, options })
    const listeners: Array<() => void> = []
    return {
      playState: 'running',
      effect: { getComputedTiming: () => ({ progress: 0 }) },
      cancel() {},
      addEventListener(_type: string, listener: () => void) { listeners.push(listener) },
    } as unknown as Animation
  }
  const list = window.document.getElementById('list')!
  // JSDOM does not report a layout box for visible elements.
  let isVisible = true
  list.getClientRects = () => (isVisible ? [list.getBoundingClientRect()] : []) as unknown as DOMRectList
  // JSDOM has no layout: each row's top comes from its index in the list.
  const rowHeight = 40
  const layOut = () => {
    Array.from(list.children).forEach((child, index) => {
      Object.defineProperty(child, 'offsetTop', { configurable: true, value: index * rowHeight })
      Object.defineProperty(child, 'offsetLeft', { configurable: true, value: 0 })
      Object.defineProperty(child, 'offsetWidth', { configurable: true, value: 200 })
      Object.defineProperty(child, 'offsetHeight', { configurable: true, value: rowHeight })
    })
  }
  const row = (name: string) => {
    const element = window.document.createElement('div')
    element.innerHTML = `<button role="treeitem" data-task-key="${name}" tabindex="0">${name}</button>`
    return element
  }
  const setVisible = (visible: boolean) => { isVisible = visible }
  return { list, played, layOut, row, rowHeight, setVisible, window }
}

describe('sidebar list motion', () => {
  test('opening a section at the end fades in its rows while the rows above stay in place', () => {
    const { list, played, layOut, row } = setup()
    list.append(row('active session'), row('Completed'))
    layOut()
    const motion = createSidebarListMotion(list, () => 150)
    motion.update(false)

    const completedRow = row('completed session')
    list.append(completedRow)
    layOut()
    motion.update(true)

    expect(played).toHaveLength(1)
    expect(played[0]?.node).toBe(completedRow)
    // It rides with the row above it, which stays where it is.
    expect(played[0]?.keyframes).toEqual([
      { opacity: 0, transform: 'translateY(0px)' }, { opacity: 1, transform: 'translateY(0px)' },
    ])
  })

  test('a new row at the top fades in and pushes the rows below down smoothly', () => {
    const { list, played, layOut, row, rowHeight } = setup()
    const older = row('older')
    list.append(older)
    layOut()
    const motion = createSidebarListMotion(list, () => 150)
    motion.update(false)
    expect(played).toHaveLength(0)

    const newest = row('newest')
    list.prepend(newest)
    layOut()
    motion.update(true)

    // With no row above it to ride with, it comes down from one row above.
    expect(played.find((entry) => entry.node === newest)?.keyframes).toEqual([
      { opacity: 0, transform: `translateY(${-rowHeight}px)` }, { opacity: 1, transform: 'translateY(0px)' },
    ])
    // The displaced row starts where it was and slides to its new slot.
    expect(played.find((entry) => entry.node === older)?.keyframes).toEqual([
      { transform: `translateY(${-rowHeight}px)` }, { transform: 'translateY(0px)' },
    ])
  })

  test('a removed row fades as an inert copy the keyboard cannot reach', () => {
    const { list, played, layOut, row } = setup()
    const leaving = row('leaving')
    list.append(leaving, row('staying'))
    layOut()
    const motion = createSidebarListMotion(list, () => 150)
    motion.update(false)

    leaving.remove()
    layOut()
    motion.update(true)

    const fade = played.find((entry) => entry.keyframes.at(-1)?.opacity === 0)!
    const copy = fade.node as HTMLElement
    // With no row above it to ride with, it fades as it moves one row down.
    expect(fade.keyframes).toEqual([
      { opacity: 1, transform: 'translateY(0px)' }, { opacity: 0, transform: 'translateY(40px)' },
    ])
    expect(copy.parentElement).toBe(list)
    expect(copy.inert).toBe(true)
    expect(copy.style.position).toBe('absolute')
    // The sidebar's tree navigation queries `[role="treeitem"]`.
    expect(list.querySelectorAll('[role="treeitem"]')).toHaveLength(1)
  })

  test('a large swap, such as a filter change, updates without motion', () => {
    const { list, played, layOut, row } = setup()
    for (let index = 0; index < 41; index++) list.append(row(`old-${index}`))
    layOut()
    const motion = createSidebarListMotion(list, () => 150)
    motion.update(false)

    list.replaceChildren(row('only'))
    layOut()
    motion.update(true)

    expect(played).toHaveLength(0)
    expect(list.children).toHaveLength(1)
  })

  test('reduced motion updates without animation', () => {
    const { list, played, layOut, row } = setup({ reducedMotion: true })
    list.append(row('older'))
    layOut()
    const motion = createSidebarListMotion(list, () => 150)
    motion.update(false)

    list.prepend(row('newest'))
    layOut()
    motion.update(true)

    expect(played).toHaveLength(0)
  })

  test('the duration comes from the setting, read at each change of order', () => {
    // WHY: the timing is a user setting. A change must reach the next change
    // of order without remounting the list.
    const { list, played, layOut, row } = setup()
    let durationMs = 150
    list.append(row('older'))
    layOut()
    const motion = createSidebarListMotion(list, () => durationMs)
    motion.update(false)

    durationMs = 320
    list.prepend(row('newest'))
    layOut()
    motion.update(true)

    expect(played.length).toBeGreaterThan(0)
    expect(played.every((entry) => entry.options?.duration === 320)).toBe(true)
  })

  test('in a list that overflows, only rows that pass through the view animate', () => {
    // WHY: a row that goes to the Completed shelf displaces every row between
    // its two places. In a long list most of them are below the fold, and one
    // animation for each of them made the change lag where nobody saw it.
    const { list, played, layOut, row, rowHeight } = setup()
    const rows = Array.from({ length: 100 }, (_, index) => row(`row-${index}`))
    list.append(...rows)
    layOut()
    // The scroller shows the first ten rows; the list starts at its top.
    const scroller = list.ownerDocument.createElement('div')
    Object.defineProperty(scroller, 'clientHeight', { value: 10 * rowHeight })
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    list.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    const motion = createSidebarListMotion(list, () => 150, () => scroller)
    motion.update(false)

    const completed = rows[2]!
    list.append(completed)
    layOut()
    motion.update(true)

    const animated = new Set(played.map((entry) => entry.node))
    // The moved row slides from its drawn place, which is in view, to its new
    // place below the fold. The rows below it in view slide up.
    expect(played.find((entry) => entry.node === completed)?.keyframes[0]).toEqual({ transform: `translateY(${(2 - 99) * rowHeight}px)` })
    for (const index of [3, 4, 5, 6, 7, 8, 9, 10]) expect(animated.has(rows[index]!)).toBe(true)
    // Rows that stay below the fold go to their places at once.
    expect(animated.has(rows[11]!)).toBe(false)
    expect(animated.has(rows[50]!)).toBe(false)
    expect(animated.size).toBe(9)
  })

  test('a row that moves to the top glides there, and the rows it passes slide down', () => {
    // WHY: T3 Code moves every row that changes place, so the eye can follow
    // a session to where it went. A fade lost it.
    const { list, played, layOut, row, rowHeight } = setup()
    const first = row('first')
    const second = row('second')
    const moved = row('moved')
    list.append(first, second, moved)
    layOut()
    const motion = createSidebarListMotion(list, () => 150)
    motion.update(false)

    list.prepend(moved)
    layOut()
    motion.update(true)

    expect(played.some((entry) => entry.keyframes.some((frame) => 'opacity' in frame))).toBe(false)
    expect(played.find((entry) => entry.node === moved)?.keyframes).toEqual([
      { transform: `translateY(${2 * rowHeight}px)` }, { transform: 'translateY(0px)' },
    ])
    for (const node of [first, second]) {
      expect(played.find((entry) => entry.node === node)?.keyframes).toEqual([
        { transform: `translateY(${-rowHeight}px)` }, { transform: 'translateY(0px)' },
      ])
    }
  })

  test('a duration of 0 turns the motion off', () => {
    const { list, played, layOut, row } = setup()
    list.append(row('older'))
    layOut()
    const motion = createSidebarListMotion(list, () => 0)
    motion.update(false)

    list.prepend(row('newest'))
    layOut()
    motion.update(true)

    expect(played).toHaveLength(0)
  })

  test('removing a row at the bottom keeps the rows above it at their drawn positions', async () => {
    const { list, played, layOut, row, rowHeight, window } = setup()
    const scroller = list.ownerDocument.createElement('div')
    scroller.append(list)
    const rows = Array.from({ length: 10 }, (_, index) => row(`row-${index}`))
    list.append(...rows)
    layOut()
    Object.defineProperty(scroller, 'clientHeight', { value: 5 * rowHeight })
    Object.defineProperty(scroller, 'scrollHeight', {
      get: () => rows.filter((element) => element.parentElement === list).length * rowHeight,
    })
    list.getBoundingClientRect = () => ({ top: -scroller.scrollTop }) as DOMRect
    const motion = createSidebarListMotion(list, () => 150, () => scroller)
    motion.update(false)

    scroller.scrollTop = 5 * rowHeight
    scroller.dispatchEvent(new window.Event('scroll'))
    rows[8]!.remove()
    layOut()
    motion.scheduleUpdate()
    // The browser can deliver the clamp's scroll event before the animation frame.
    scroller.scrollTop = 4 * rowHeight
    scroller.dispatchEvent(new window.Event('scroll'))
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))

    expect(played.find((entry) => entry.node === rows[7])?.keyframes).toEqual([
      { transform: `translateY(${-rowHeight}px)` }, { transform: 'translateY(0px)' },
    ])
    expect(played.some((entry) => entry.node === rows[9])).toBe(false)
    const copy = played.find((entry) => entry.keyframes.at(-1)?.opacity === 0)?.node as HTMLElement
    expect(copy.style.top).toBe(`${7 * rowHeight}px`)
    motion.dispose()
  })

  test('reopening a hidden list takes a fresh reading without animating hidden changes', () => {
    const { list, played, layOut, row, setVisible } = setup()
    const existing = row('existing')
    list.append(existing)
    layOut()
    const motion = createSidebarListMotion(list, () => 150)
    motion.update(false)

    setVisible(false)
    list.prepend(row('first hidden arrival'))
    layOut()
    motion.update(true)
    expect(played).toHaveLength(0)

    setVisible(true)
    list.prepend(row('second hidden arrival'))
    layOut()
    motion.update(true)
    expect(played).toHaveLength(0)
  })
})

// Each sidebar section is its own list, so a session that changes section
// leaves one list and arrives in another as a new element. One pass over every
// list that changed in the frame matches the two by row key, and the session
// glides between its two places instead of vanishing from one and appearing
// in the other.
describe('a session that moves to another section', () => {
  function sections(options: { withLayer?: boolean } = {}) {
    const dom = new JSDOM('<div id="tree"><div id="main"></div><div id="shelf"></div></div>', { pretendToBeVisual: true })
    const window = dom.window
    window.matchMedia = () => ({ matches: false }) as MediaQueryList
    const played: Played[] = []
    window.HTMLElement.prototype.animate = function (keyframes: Keyframe[], options?: KeyframeAnimationOptions) {
      played.push({ node: this, keyframes, options })
      return {
        playState: 'running',
        effect: { getComputedTiming: () => ({ progress: 0 }) },
        cancel() {},
        addEventListener() {},
      } as unknown as Animation
    }
    const tree = window.document.getElementById('tree')!
    if (options.withLayer !== false) tree.setAttribute('data-sidebar-motion-layer', '')
    tree.getBoundingClientRect = () => ({ top: 0, left: 0 }) as DOMRect
    // The main list starts at the top of the window, the shelf 400px down.
    const main = window.document.getElementById('main')!
    const shelf = window.document.getElementById('shelf')!
    for (const [list, top] of [[main, 0], [shelf, 400]] as const) {
      list.getBoundingClientRect = () => ({ top, left: 0 }) as DOMRect
      list.getClientRects = () => [list.getBoundingClientRect()] as unknown as DOMRectList
    }
    const layOut = (heights: Map<Element, number> = new Map()) => {
      for (const list of [main, shelf]) {
        let top = 0
        for (const child of Array.from(list.children)) {
          const height = heights.get(child) ?? 40
          Object.defineProperty(child, 'offsetTop', { configurable: true, value: top })
          Object.defineProperty(child, 'offsetLeft', { configurable: true, value: 0 })
          Object.defineProperty(child, 'offsetWidth', { configurable: true, value: 200 })
          Object.defineProperty(child, 'offsetHeight', { configurable: true, value: height })
          top += height
        }
      }
    }
    const row = (sessionKey: string) => {
      const element = window.document.createElement('div')
      element.setAttribute('data-sidebar-row-key', sessionKey)
      element.innerHTML = `<button role="treeitem" tabindex="0">${sessionKey}</button>`
      return element
    }
    const frame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    return { tree, main, shelf, played, layOut, row, frame }
  }

  test('it glides from its place in one list to its place in the other', async () => {
    const { tree, main, shelf, played, layOut, row, frame } = sections()
    const above = row('above')
    const leaving = row('session')
    main.append(above, leaving)
    layOut()
    const mainMotion = createSidebarListMotion(main, () => 150)
    const shelfMotion = createSidebarListMotion(shelf, () => 150)
    mainMotion.update(false)
    shelfMotion.update(false)

    // Svelte removes the row from one list and makes a new one in the other.
    leaving.remove()
    const arrived = row('session')
    shelf.append(arrived)
    layOut()
    mainMotion.scheduleUpdate()
    shelfMotion.scheduleUpdate()
    await frame()

    // A copy of the row travels in the layer above both lists, from 40px to 400px.
    const copy = played.find((entry) => entry.node.parentElement === tree)
    expect(copy?.keyframes).toEqual([
      { opacity: 1, transform: 'translateY(0px)' }, { opacity: 1, transform: 'translateY(360px)' },
    ])
    expect((copy?.node as HTMLElement).style.top).toBe('40px')
    expect((copy?.node as HTMLElement).inert).toBe(true)
    // The row in its new list shows when the copy lands; nothing fades in the old list.
    expect(played.find((entry) => entry.node === arrived)?.keyframes).toEqual([
      { opacity: 0 }, { opacity: 0, offset: 0.99 }, { opacity: 1 },
    ])
    expect(played.some((entry) => entry.node.parentElement === main)).toBe(false)
    // The sidebar's tree navigation still finds the session once.
    expect(tree.querySelectorAll('[role="treeitem"]')).toHaveLength(2)
  })

  test('a row that changes shape cross-fades the two shapes as it glides', async () => {
    // WHY: an open session is a card and a shelved one is slim. The card fades
    // out while the slim row fades in, both on the same path.
    const { tree, main, shelf, played, layOut, row, frame } = sections()
    const card = row('session')
    main.append(card)
    layOut(new Map([[card, 62]]))
    const mainMotion = createSidebarListMotion(main, () => 150)
    const shelfMotion = createSidebarListMotion(shelf, () => 150)
    mainMotion.update(false)
    shelfMotion.update(false)

    card.remove()
    const slim = row('session')
    shelf.append(slim)
    layOut(new Map([[slim, 36]]))
    mainMotion.scheduleUpdate()
    shelfMotion.scheduleUpdate()
    await frame()

    expect(played.find((entry) => entry.node.parentElement === tree)?.keyframes).toEqual([
      { opacity: 1, transform: 'translateY(0px)' }, { opacity: 0, transform: 'translateY(400px)' },
    ])
    expect(played.find((entry) => entry.node === slim)?.keyframes).toEqual([
      { opacity: 0, transform: 'translateY(-400px)' }, { opacity: 1, transform: 'translateY(0px)' },
    ])
  })

  test('without a motion layer the row fades out of one list and into the other', async () => {
    const { main, shelf, played, layOut, row, frame } = sections({ withLayer: false })
    const leaving = row('session')
    main.append(leaving)
    layOut()
    const mainMotion = createSidebarListMotion(main, () => 150)
    const shelfMotion = createSidebarListMotion(shelf, () => 150)
    mainMotion.update(false)
    shelfMotion.update(false)

    leaving.remove()
    const arrived = row('session')
    shelf.append(arrived)
    layOut()
    mainMotion.scheduleUpdate()
    shelfMotion.scheduleUpdate()
    await frame()

    expect(played.find((entry) => entry.node === arrived)?.keyframes.at(-1)).toEqual({ opacity: 1, transform: 'translateY(0px)' })
    expect(played.some((entry) => entry.node.parentElement?.id === 'tree')).toBe(false)
  })
})
