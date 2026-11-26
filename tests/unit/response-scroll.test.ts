import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createEndFollow, newTurnMinHeight, settleScroll } from '@solus/workspace-ui/components/conversation/lib/response-scroll'

describe('following the end of a conversation', () => {
  let dom: JSDOM
  let previousWindow: PropertyDescriptor | undefined
  let element: HTMLElement
  let requests: ScrollToOptions[]
  let now: number
  const realNow = performance.now.bind(performance)
  let follower: ReturnType<typeof createEndFollow>

  function setup(reducedMotion: boolean, startAtEnd = true) {
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: reducedMotion }) })
    follower = createEndFollow(element, startAtEnd)
  }

  beforeEach(() => {
    dom = new JSDOM('<div></div>')
    previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
    now = 1000
    performance.now = () => now
    element = dom.window.document.querySelector('div')!
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 400 })
    requests = []
    element.scrollTo = ((options: ScrollToOptions) => { requests.push(options) }) as HTMLElement['scrollTo']
  })

  afterEach(() => {
    follower.destroy()
    performance.now = realNow
    dom.window.close()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })

  test('uses finite smooth motion and stops it when the reader scrolls', () => {
    setup(false)
    follower.follow(true)
    expect(requests).toEqual([{ top: 1000, behavior: 'smooth' }])
    expect(follower.moving).toBe(true)
    element.dispatchEvent(new dom.window.Event('wheel'))
    expect(follower.moving).toBe(false)
    expect(requests.at(-1)).toEqual({ top: 0, behavior: 'instant' })
  })

  test('reduced motion makes automatic following immediate', () => {
    setup(true)
    follower.follow(true)
    expect(requests[0]?.behavior).toBe('instant')
    expect(follower.moving).toBe(false)
  })

  // WebKit scrolls off the main thread: a write during the reader's own
  // scroll stops its momentum and lands on a stale position.
  test('never writes while the reader scrolls, and follows again once the scroll settles', () => {
    setup(true)
    element.dispatchEvent(new dom.window.Event('wheel'))
    follower.follow(false)
    now += 100
    element.dispatchEvent(new dom.window.Event('scroll'))
    now += 100
    follower.follow(false)
    expect(requests).toEqual([])
    now += 200
    follower.follow(false)
    expect(requests).toEqual([{ top: 1000, behavior: 'instant' }])
  })

  test('a reader who scrolled away is not pulled back; a jump follows again', () => {
    setup(true)
    element.scrollTop = 200
    follower.measure()
    expect(follower.atEnd).toBe(false)
    follower.follow(false)
    expect(requests).toEqual([])
    follower.jump()
    expect(follower.atEnd).toBe(true)
    follower.follow(false)
    expect(requests).toHaveLength(2)
  })

  test('a hold lets content open below the reader before following resumes', () => {
    setup(true)
    follower.hold()
    follower.follow(false)
    expect(requests).toEqual([])
    now += 200
    follower.follow(false)
    expect(requests).toHaveLength(1)
  })

  test('a view restored to a saved place does not follow the end', () => {
    setup(true, false)
    follower.follow(false)
    expect(requests).toEqual([])
  })

  // Rows below a sent prompt measure during its glide. A second smooth
  // scroll restarts the browser's easing from rest and the glide stutters;
  // an instant write cuts it off. The glide finishes, then glides on.
  test('content that grows during a glide waits for it, then the view glides on to the new end', () => {
    setup(false)
    follower.jump(true)
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1200 })
    follower.follow(false)
    follower.follow(false)
    expect(requests).toEqual([{ top: 1000, behavior: 'smooth' }])
    element.dispatchEvent(new dom.window.Event('scrollend'))
    expect(requests).toEqual([{ top: 1000, behavior: 'smooth' }, { top: 1200, behavior: 'smooth' }])
    element.dispatchEvent(new dom.window.Event('scrollend'))
    follower.follow(false)
    expect(requests.at(-1)).toEqual({ top: 1200, behavior: 'instant' })
  })

  test('a reader who takes over during a glide drops the growth it was waiting for', () => {
    setup(false)
    follower.jump(true)
    follower.follow(false)
    element.dispatchEvent(new dom.window.Event('wheel'))
    element.dispatchEvent(new dom.window.Event('scrollend'))
    expect(requests).toEqual([{ top: 1000, behavior: 'smooth' }, { top: 0, behavior: 'instant' }])
  })

  // Smooth scrolling runs on time. A glide that starts before a slow first
  // paint is half done when that paint shows, and the sent message seems to
  // appear in the middle of the view instead of rising into it.
  test('a sent prompt glides only after its rows paint, and nothing starts a glide before then', async () => {
    const scope = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown }
    const previous = { request: scope.requestAnimationFrame, cancel: scope.cancelAnimationFrame }
    const frames: FrameRequestCallback[] = []
    scope.requestAnimationFrame = (callback: FrameRequestCallback) => frames.push(callback)
    scope.cancelAnimationFrame = () => {}
    const paint = () => { for (const callback of frames.splice(0)) callback(0) }
    try {
      setup(false)
      follower.glideAfterPaint()
      follower.follow(true)
      expect(requests).toEqual([])
      paint()
      paint()
      await Promise.resolve()
      expect(requests).toEqual([{ top: 1000, behavior: 'smooth' }])
    } finally {
      scope.requestAnimationFrame = previous.request
      scope.cancelAnimationFrame = previous.cancel
    }
  })
})

describe('the room a sent turn keeps', () => {
  // The end of the conversation must show the sent turn at the top of the
  // view: the room is the view under the band and the composer, less a gap.
  test('fills the view under the floating band and the composer', () => {
    expect(newTurnMinHeight(800, 58)).toBe('max(0px, calc(726px - var(--solus-composer-inset, 0px)))')
    expect(newTurnMinHeight(800, 0)).toBe('max(0px, calc(784px - var(--solus-composer-inset, 0px)))')
  })
})

describe('settling a conversation as it opens', () => {
  const realFrame = globalThis.requestAnimationFrame
  let frames: FrameRequestCallback[]
  let element: { scrollTop: number; scrollHeight: number; clientHeight: number }

  beforeEach(() => {
    frames = []
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => frames.push(callback)) as typeof requestAnimationFrame
    element = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }
  })
  afterEach(() => { globalThis.requestAnimationFrame = realFrame })

  const runFrame = () => frames.shift()?.(0)
  const toEnd = () => element.scrollHeight - element.clientHeight

  test('follows rows that measure late, and settles only once the end holds still', async () => {
    let settled = false
    void settleScroll(element as HTMLElement, toEnd, () => false).then(() => { settled = true })
    // Highlighted code below the first jump measures a frame later.
    element.scrollHeight = 1300
    runFrame()
    expect(element.scrollTop).toBe(900)
    runFrame()
    await Promise.resolve()
    expect(settled).toBe(false)
    runFrame()
    await Promise.resolve()
    expect(settled).toBe(true)
    expect(element.scrollTop).toBe(900)
  })

  test('a view that never holds still stops settling within its frame budget', async () => {
    let settled = false
    void settleScroll(element as HTMLElement, toEnd, () => false).then(() => { settled = true })
    for (let frame = 0; frame < 61 && !settled; frame++) {
      element.scrollHeight += 50
      runFrame()
      await Promise.resolve()
    }
    expect(settled).toBe(true)
  })

  test('a new arrival cancels the old one without writing', async () => {
    let settled = false
    void settleScroll(element as HTMLElement, () => 0, () => true).then(() => { settled = true })
    runFrame()
    await Promise.resolve()
    expect(settled).toBe(true)
    expect(element.scrollTop).toBe(600)
  })
})
