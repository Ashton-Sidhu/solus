import { describe, expect, test } from 'bun:test'
import {
  canScrollHorizontally,
  HistorySwipe,
  isMomentumTail,
  type ScrollableElement,
  type SwipeDirection,
  type SwipeStep,
  type SwipeTarget,
} from '@solus/workspace-ui/components/layout/lib/history-swipe'

// A two-finger swipe navigates once, when the fingers lift, and only when the
// user meant it: far enough, not reversed, not held, not over content that
// scrolls sideways.

const OPEN_PAGE: SwipeTarget = { takesHorizontalWheel: () => false, canNavigate: () => true }

/** Feed horizontal wheel deltas 16ms apart; answers every step and the clock. */
function swipe(machine: HistorySwipe, deltas: number[], options: { target?: SwipeTarget; at?: number } = {}) {
  let at = options.at ?? 0
  const steps: SwipeStep[] = []
  for (const deltaX of deltas) {
    at += 16
    const event = { deltaX, deltaY: 0, ctrlKey: false, isPixelDelta: true, clientY: 200, timeStamp: at }
    steps.push(machine.wheel(event, () => options.target ?? OPEN_PAGE))
  }
  return { steps, at }
}

function navigations(steps: SwipeStep[]): SwipeDirection[] {
  return steps.flatMap((step) => (step.navigate ? [step.navigate] : []))
}

// Fingers move about 20px a step; the coasting tail after they lift shrinks by 0.92.
const FINGERS = [20, 22, 18, 24, 21, 19, 23]
const MOMENTUM = [30, 27.6, 25.4, 23.4, 21.5, 19.8]

describe('isMomentumTail', () => {
  test.each([
    ['steady momentum decay', [40, 37, 34, 31.3, 28.8], true],
    ['fingers still moving', [12, 18, 9, 15, 11], false],
    ['fingers slowing unevenly', [30, 22, 20, 12, 11], false],
    ['reversing', [10, 8, 6, 4, -2], false],
    ['too few samples', [40, 37, 34], false],
  ])('%s', (_name, deltas, expected) => {
    expect(isMomentumTail(deltas)).toBe(expected)
  })
})

describe('HistorySwipe', () => {
  test('commits forward on the momentum tail, once', () => {
    const machine = new HistorySwipe()
    const { steps } = swipe(machine, [...FINGERS, ...MOMENTUM, 18, 16])
    expect(navigations(steps)).toEqual(['forward'])
    // The indicator is armed before the lift and gone after it.
    expect(steps[FINGERS.length - 1].indicator?.progress).toBe(1)
    expect(steps.at(-1)?.indicator).toBeNull()
  })

  test('a leftward swipe goes back', () => {
    const machine = new HistorySwipe()
    const { steps } = swipe(machine, [...FINGERS, ...MOMENTUM].map((delta) => -delta))
    expect(navigations(steps)).toEqual(['back'])
  })

  test('an empty wheel event or the scroll end is a lift', () => {
    const empty = new HistorySwipe()
    expect(navigations(swipe(empty, [...FINGERS, 0]).steps)).toEqual(['forward'])

    const ended = new HistorySwipe()
    const { at } = swipe(ended, FINGERS)
    expect(ended.scrollEnd(at + 16).navigate).toBe('forward')
  })

  test('a short swipe shows the indicator but does not navigate', () => {
    const machine = new HistorySwipe()
    const { steps, at } = swipe(machine, [20, 20, 20])
    expect(steps.at(-1)?.indicator?.progress).toBeLessThan(1)
    expect(machine.scrollEnd(at + 16).navigate).toBeNull()
  })

  test('swiping back before lifting cancels', () => {
    const machine = new HistorySwipe()
    const { steps, at } = swipe(machine, [...FINGERS, -25, -25, -25, -25, -25])
    expect(navigations(steps)).toEqual([])
    expect(machine.scrollEnd(at + 16).navigate).toBeNull()
  })

  test('holding still before lifting cancels', () => {
    const machine = new HistorySwipe()
    const { at } = swipe(machine, FINGERS)
    expect(machine.scrollEnd(at + 500).navigate).toBeNull()
  })

  test('a vertical scroll is not a swipe', () => {
    const machine = new HistorySwipe()
    const event = { deltaX: 3, deltaY: 30, ctrlKey: false, isPixelDelta: true, clientY: 0, timeStamp: 0 }
    expect(machine.wheel(event, () => OPEN_PAGE).indicator).toBeNull()
    const { steps } = swipe(machine, [...FINGERS, ...MOMENTUM])
    expect(navigations(steps)).toEqual([])
  })

  test('content that scrolls sideways keeps the wheel', () => {
    const machine = new HistorySwipe()
    const diff: SwipeTarget = { takesHorizontalWheel: () => true, canNavigate: () => true }
    const { steps } = swipe(machine, [...FINGERS, ...MOMENTUM], { target: diff })
    expect(steps.every((step) => step.indicator === null && step.navigate === null)).toBe(true)
  })

  test('nowhere to go is not a swipe', () => {
    const machine = new HistorySwipe()
    const newest: SwipeTarget = { takesHorizontalWheel: () => false, canNavigate: (d) => d === 'back' }
    expect(navigations(swipe(machine, [...FINGERS, ...MOMENTUM], { target: newest }).steps)).toEqual([])
  })

  test('the next gesture starts fresh after a scroll begin', () => {
    const machine = new HistorySwipe()
    const first = swipe(machine, [...FINGERS, ...MOMENTUM])
    // Leftover momentum of the first gesture stays ignored.
    expect(navigations(swipe(machine, FINGERS, { at: first.at }).steps)).toEqual([])
    machine.scrollEnd(first.at + 400)
    machine.scrollBegin()
    expect(navigations(swipe(machine, [...FINGERS, ...MOMENTUM], { at: first.at + 500 }).steps)).toEqual([
      'forward',
    ])
  })

  test('pinch-zoom and mouse wheels are ignored', () => {
    const machine = new HistorySwipe()
    const pinch = { deltaX: 40, deltaY: 0, ctrlKey: true, isPixelDelta: true, clientY: 0, timeStamp: 0 }
    expect(machine.wheel(pinch, () => OPEN_PAGE).indicator).toBeNull()
    expect(navigations(swipe(machine, [...FINGERS, ...MOMENTUM]).steps)).toEqual([])
  })
})

describe('canScrollHorizontally', () => {
  interface FakeElement extends ScrollableElement<FakeElement> {}
  function element(
    scroll: { scrollLeft: number; scrollWidth: number; clientWidth: number },
    parentElement: FakeElement | null = null,
  ): FakeElement {
    return { ...scroll, parentElement }
  }
  const auto = () => 'auto'

  test('a scrollable ancestor that can still move this way takes the wheel', () => {
    const codeBlock = element({ scrollLeft: 0, scrollWidth: 900, clientWidth: 400 })
    const leaf = element({ scrollLeft: 0, scrollWidth: 100, clientWidth: 100 }, codeBlock)
    expect(canScrollHorizontally(leaf, 30, auto)).toBe(true)
    // At its left edge it cannot move left, so a back swipe is free.
    expect(canScrollHorizontally(leaf, -30, auto)).toBe(false)
  })

  test('at its right edge it cannot move right', () => {
    const table = element({ scrollLeft: 500, scrollWidth: 900, clientWidth: 400 })
    expect(canScrollHorizontally(table, 30, auto)).toBe(false)
    expect(canScrollHorizontally(table, -30, auto)).toBe(true)
  })

  test('overflow that is clipped, not scrollable, does not count', () => {
    const clipped = element({ scrollLeft: 0, scrollWidth: 900, clientWidth: 400 })
    expect(canScrollHorizontally(clipped, 30, () => 'hidden')).toBe(false)
  })
})
