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
      { opacity: 0 }, { opacity: 1 },
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

    const copy = played.find((entry) => entry.keyframes.at(-1)?.opacity === 0)?.node as HTMLElement
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
