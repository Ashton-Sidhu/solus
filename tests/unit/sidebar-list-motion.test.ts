import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createSidebarListMotion } from '@solus/workspace-ui/components/session/lib/sidebar-list-motion.svelte'

type Played = { node: Element; keyframes: Keyframe[]; options?: KeyframeAnimationOptions }

function setup(options: { reducedMotion?: boolean } = {}) {
  const dom = new JSDOM('<div id="list"></div>')
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
  return { list, played, layOut, row, rowHeight }
}

describe('sidebar list motion', () => {
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

    expect(played.find((entry) => entry.node === newest)?.keyframes).toEqual([
      { opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 },
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
    // The copy is gone by 40% of the motion, before an entering row shows at
    // 60%, so the two never overlap.
    expect(fade.keyframes).toEqual([{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }])
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
    // The moved row fades out as a copy at its old place; its new place is
    // below the fold. The rows below it in view slide up.
    const copy = played.find((entry) => entry.keyframes.at(-1)?.opacity === 0)?.node
    expect(copy?.parentElement).toBe(list)
    expect(animated.has(completed)).toBe(false)
    for (const index of [3, 4, 5, 6, 7, 8, 9, 10]) expect(animated.has(rows[index]!)).toBe(true)
    // Rows that stay below the fold go to their places at once.
    expect(animated.has(rows[11]!)).toBe(false)
    expect(animated.has(rows[50]!)).toBe(false)
    expect(animated.size).toBe(9)
  })

  test('a row that moves to the top fades out and in, and does not slide through the others', () => {
    // WHY: a row that changes order crosses its neighbours. A slide drew it
    // through the rows it passed; two fades that do not overlap never do.
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

    const fades = played.filter((entry) => entry.keyframes.some((frame) => 'opacity' in frame))
    expect(fades).toHaveLength(2)
    const slid = played.filter((entry) => entry.keyframes.some((frame) => 'transform' in frame))
    expect(slid.map((entry) => entry.node)).toEqual([first, second])
    expect(played.find((entry) => entry.node === moved)?.keyframes).toEqual([
      { opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 },
    ])
    const copy = fades.find((entry) => entry.node !== moved)!
    expect((copy.node as HTMLElement).inert).toBe(true)
    expect((copy.node as HTMLElement).style.top).toBe(`${2 * rowHeight}px`)
    // The rows it passed slide down one place.
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
})
