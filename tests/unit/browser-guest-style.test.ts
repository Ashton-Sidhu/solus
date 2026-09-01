import { describe, expect, test } from 'bun:test'
import { browserGuestStyleScript } from '@solus/server/browser/guest-style'

/**
 * The scrollbar Solus injects into a browser guest must read as the app's — a
 * thin rounded overlay pill that follows light and dark — rather than Chromium's
 * default chunky bar. It is deliberately static (always visible), so the two
 * rules worth pinning are that it stays a hairline pill and that it switches on
 * the emulated colour scheme.
 */

describe('browser guest scrollbar style', () => {
  const source = browserGuestStyleScript()

  test('paints a thin rounded overlay thumb, not the default bar', () => {
    expect(source).toContain('::-webkit-scrollbar-thumb {')
    expect(source).toContain('border-radius: 9999px')
    // A transparent padding-box border shrinks the ink to a hairline pill inside
    // the gutter — the app's overlay look.
    expect(source).toContain('border: 3px solid transparent')
    expect(source).toContain('background-clip: padding-box')
  })

  test('follows the emulated colour scheme, as the app switches on theme', () => {
    expect(source).toContain('@media (prefers-color-scheme: dark)')
    expect(source).toContain('rgba(0, 0, 0, 0.18)')
    expect(source).toContain('rgba(255, 255, 255, 0.18)')
  })

  test('sizes in px and never sets scrollbar-width', () => {
    // The guest's root font size is the site's, so rem would make the bar a
    // different width on every page. And any non-`auto` `scrollbar-width` opts
    // Chromium out of ::-webkit-scrollbar entirely — the chunky bar returns.
    expect(source).toContain('width: 10px')
    expect(source).not.toMatch(/[0-9]rem/)
    expect(source).not.toContain('scrollbar-width')
  })

  test('installs one sheet, idempotently, without touching page behaviour', () => {
    const guest = fakeGuest()
    guest.run(source)
    guest.run(source)

    const styles = guest.styleElements()
    expect(styles).toHaveLength(1)
    expect(styles[0].textContent).toContain('::-webkit-scrollbar')

    // The static styling adds no listeners to the guest — that reliability is the
    // whole reason it is static rather than a scroll-driven reveal.
    expect(guest.listeners.filter((l) => l.type === 'scroll')).toHaveLength(0)
  })
})

interface ListenerOptions {
  capture?: boolean
  passive?: boolean
  once?: boolean
}

interface FakeListener {
  type: string
  handler: (event: { target: unknown }) => void
  opts: ListenerOptions
}

/** The one global the install script sets, so a fresh guest re-runs it and a
 *  second run on the same guest is a no-op. */
interface GuestWindow {
  __solusBrowserScrollbar?: boolean
}

class FakeElement {
  id = ''
  textContent = ''
  readonly children: FakeElement[] = []
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child)
    return child
  }
}

/**
 * A minimal guest the install script can run against, so "one sheet, no
 * listeners" is proven by behaviour rather than by matching a string.
 */
function fakeGuest() {
  const documentElement = new FakeElement()
  const head = new FakeElement()
  const listeners: FakeListener[] = []

  const document = {
    documentElement,
    head,
    createElement: () => new FakeElement(),
    getElementById: (id: string) =>
      [...head.children, ...documentElement.children].find((el) => el.id === id) ?? null,
    addEventListener: (type: string, handler: FakeListener['handler'], opts: ListenerOptions) =>
      listeners.push({ type, handler, opts }),
  }
  const win: GuestWindow = {}

  return {
    documentElement,
    document,
    listeners,
    styleElements: () => [...head.children, ...documentElement.children],
    run(script: string) {
      // Bind the script's free identifiers as parameters rather than touching
      // globalThis, so a run leaves the test environment untouched.
      const factory = new Function('window', 'document', `return (${script})`)
      factory(win, document)
    },
  }
}
