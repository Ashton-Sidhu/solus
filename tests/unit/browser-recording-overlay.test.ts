import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { recordingOverlayExpression } from '@solus/server/browser/recording-overlay-script'

/**
 * A modal dialog or a popover paints in the browser top layer, above any
 * z-index. The recording overlay must be in the top layer too, and move back
 * to its front each time the page adds to it, or the video shows no input
 * while a dialog is open.
 */

function guest() {
  const { window } = new JSDOM('<!doctype html><html><body><dialog></dialog></body></html>', {
    runScripts: 'outside-only',
  })
  // jsdom has no popover API. Record each show and hide in order: the last
  // element shown is the front of the top layer.
  const events: string[] = []
  const open = new WeakSet<Element>()
  const proto = window.HTMLElement.prototype as HTMLElement
  const matches = proto.matches
  Object.assign(proto, {
    showPopover(this: HTMLElement) {
      open.add(this)
      events.push('show')
    },
    hidePopover(this: HTMLElement) {
      open.delete(this)
      events.push('hide')
    },
    matches(this: HTMLElement, selector: string) {
      return selector === ':popover-open' ? open.has(this) : matches.call(this, selector)
    },
  })
  const root = () => window.document.querySelector<HTMLElement>('[data-solus-recording-overlay]')
  return { window, events, root, isOpen: (el: Element) => open.has(el) }
}

describe('recording overlay top layer', () => {
  test('the root is a manual popover that is shown after it is appended', () => {
    const { window, events, root, isOpen } = guest()
    window.eval(recordingOverlayExpression(true))

    const overlay = root()
    expect(overlay?.popover).toBe('manual')
    expect(overlay && isOpen(overlay)).toBe(true)
    expect(overlay?.style.pointerEvents).toBe('none')
    expect(overlay?.style.margin).toBe('0px')
    expect(events).toEqual(['show'])
  })

  test('a dialog that opens sends the overlay back to the front', async () => {
    const { window, events } = guest()
    window.eval(recordingOverlayExpression(true))

    window.document.querySelector('dialog')?.setAttribute('open', '')
    await Promise.resolve()

    expect(events).toEqual(['show', 'hide', 'show'])
  })

  test('a page popover that opens raises the overlay, its own toggle does not', () => {
    const { window, events, root } = guest()
    window.eval(recordingOverlayExpression(true))

    const toggle = (target: Element) => {
      const event = new window.Event('toggle')
      Object.defineProperty(event, 'newState', { value: 'open' })
      target.dispatchEvent(event)
    }
    const overlay = root()
    if (overlay) toggle(overlay)
    expect(events).toEqual(['show'])

    const menu = window.document.createElement('div')
    window.document.body.appendChild(menu)
    toggle(menu)
    expect(events).toEqual(['show', 'hide', 'show'])
  })

  test('remove() stops raising the overlay', async () => {
    const { window, events, root } = guest()
    window.eval(recordingOverlayExpression(true))
    window.eval(recordingOverlayExpression(false))

    window.document.querySelector('dialog')?.setAttribute('open', '')
    await Promise.resolve()

    expect(root()).toBeNull()
    expect(events).toEqual(['show'])
  })
})
