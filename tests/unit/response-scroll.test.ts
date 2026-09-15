import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createResponseScroll } from '@solus/workspace-ui/components/conversation/lib/response-scroll'

describe('response scrolling', () => {
  test('uses finite smooth motion and stops following when the reader scrolls', () => {
    const dom = new JSDOM('<div></div>')
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false }) })
    const element = dom.window.document.querySelector('div')!
    Object.defineProperty(element, 'scrollHeight', { value: 1000 })
    const requests: ScrollToOptions[] = []
    element.scrollTo = (options: ScrollToOptions) => { requests.push(options) }
    const follower = createResponseScroll(element)
    try {
      follower.follow(true)
      expect(requests).toEqual([{ top: 1000, behavior: 'smooth' }])
      expect(follower.moving).toBe(true)
      element.dispatchEvent(new dom.window.Event('wheel'))
      expect(follower.moving).toBe(false)
      expect(requests.at(-1)).toEqual({ top: 0, behavior: 'instant' })
      follower.follow(true)
      element.dispatchEvent(new dom.window.Event('scrollend'))
      expect(follower.moving).toBe(false)
    } finally {
      follower.destroy()
      dom.window.close()
      if (previous) Object.defineProperty(globalThis, 'window', previous)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
  test('reduced motion makes automatic following immediate', () => {
    const dom = new JSDOM('<div></div>')
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: true }) })
    const element = dom.window.document.querySelector('div')!
    const requests: ScrollToOptions[] = []
    element.scrollTo = (options: ScrollToOptions) => { requests.push(options) }
    const follower = createResponseScroll(element)
    try {
      follower.follow(true)
      expect(requests[0]?.behavior).toBe('instant')
      expect(follower.moving).toBe(false)
    } finally {
      follower.destroy()
      dom.window.close()
      if (previous) Object.defineProperty(globalThis, 'window', previous)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
})
