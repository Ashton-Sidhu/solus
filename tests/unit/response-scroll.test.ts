import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createEndFollow, settleScroll } from '@solus/workspace-ui/components/conversation/lib/response-scroll'

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
