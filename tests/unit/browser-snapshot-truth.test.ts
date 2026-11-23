import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import {
  elementSnapshotExpression,
  guardedExpression,
  refSelector,
  settleExpression,
  snapshotChangesExpression,
  waitConditionExpression,
} from '@solus/server/browser/page-script'

// WHY: an agent judges a page by its snapshot. A snapshot of an app behind its
// loading screen gave a picture of the loading screen and a list of the app's
// buttons, and nothing said that the two disagreed, so the agent trusted one of
// them at random. A snapshot must say what covers an element, what text a
// person can read, whether the document is still loading, and whether the page
// changed while it was read.

type Rect = { x: number; y: number; width: number; height: number }

class Box {
  textContent = ''
  disabled = false
  className = ''
  readonly children: Box[] = []
  style: object = { visibility: 'visible', display: 'block' }
  constructor(readonly tagName: string, readonly id: string, readonly rect: Rect, private readonly label = '') {}
  getAttribute(name: string): string | null {
    return name === 'aria-label' && this.label ? this.label : null
  }
  setAttribute() {}
  removeAttribute() {}
  getBoundingClientRect() {
    const { x, y, width, height } = this.rect
    return { x, y, width, height, top: y, bottom: y + height, left: x, right: x + width }
  }
  contains(other: Box): boolean {
    return other === this || this.children.some((child) => child.contains(other))
  }
}

/** A text node, as the tree walker hands it over. */
type TextNode = { nodeValue: string; parentElement: Box }

/** A content watcher the test can fire, as the page would on a DOM change. */
class FakeMutationObserver {
  static last: FakeMutationObserver | null = null
  connected = false
  constructor(private readonly callback: (records: object[]) => void) {
    FakeMutationObserver.last = this
  }
  observe() { this.connected = true }
  disconnect() { this.connected = false }
  fire(count: number) { if (this.connected) this.callback(Array.from({ length: count }, () => ({}))) }
}

function fakePage(options: {
  elements?: Box[]
  top?: (x: number, y: number) => Box | null
  texts?: TextNode[]
  readyState?: string
  href?: string
  innerText?: string
}) {
  const texts = options.texts ?? []
  // The page code adds its change watch to this object at run time.
  const window = {
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: (el: Box) => el.style,
  }
  return {
    window,
    MutationObserver: FakeMutationObserver,
    location: { href: options.href ?? 'http://127.0.0.1:5188/draft/fixture' },
    document: {
      title: 'Solus',
      readyState: options.readyState ?? 'complete',
      documentElement: {},
      body: { innerText: options.innerText ?? '' },
      querySelectorAll: (selector: string) => (selector.startsWith('[') ? [] : options.elements ?? []),
      querySelector: () => null,
      elementFromPoint: (x: number, y: number) => options.top?.(x, y) ?? null,
      createTreeWalker: () => {
        let index = 0
        return { nextNode: () => texts[index++] ?? null }
      },
    },
  }
}

type Structure = {
  loading: boolean
  visibleText: string
  watching: boolean
  elements: Array<{ label: string; coveredBy?: string }>
}

function readStructure(page: ReturnType<typeof fakePage>): Structure {
  return JSON.parse(runInNewContext(elementSnapshotExpression(50), page))
}

describe('what covers an element', () => {
  test('a loading screen in front of the app is named on every element it covers', () => {
    const toggle = new Box('BUTTON', '', { x: 82, y: 7, width: 26, height: 26 }, 'Collapse sidebar')
    const splash = new Box('DIV', 'solus-boot-shell', { x: 0, y: 0, width: 1440, height: 900 })
    const structure = readStructure(fakePage({ elements: [toggle], top: () => splash }))
    expect(structure.elements).toEqual([expect.objectContaining({ label: 'Collapse sidebar', coveredBy: 'div#solus-boot-shell' })])
  })

  test('an element on top, or with its own child on top, is not covered', () => {
    const icon = new Box('SVG', '', { x: 90, y: 12, width: 16, height: 16 })
    const toggle = new Box('BUTTON', '', { x: 82, y: 7, width: 26, height: 26 }, 'Collapse sidebar')
    toggle.children.push(icon)
    const send = new Box('BUTTON', '', { x: 500, y: 800, width: 40, height: 40 }, 'Send')
    const structure = readStructure(fakePage({
      elements: [toggle, send],
      top: (x) => (x < 200 ? icon : send),
    }))
    expect(structure.elements.map((element) => element.coveredBy)).toEqual([undefined, undefined])
  })
})

describe('what the page says', () => {
  test('the snapshot carries the readable text on screen, without masked or off-screen text', () => {
    const status = new Box('DIV', '', { x: 570, y: 8, width: 299, height: 34 })
    const below = new Box('P', '', { x: 0, y: 2000, width: 300, height: 20 })
    const pin = new Box('SPAN', '', { x: 10, y: 10, width: 60, height: 20 })
    pin.style = { visibility: 'visible', display: 'inline', webkitTextSecurity: 'disc' }
    const structure = readStructure(fakePage({
      readyState: 'interactive',
      texts: [
        { nodeValue: '  Connecting to\n Solus Demo ', parentElement: status },
        { nodeValue: 'synthetic-masked-marker', parentElement: pin },
        { nodeValue: 'Below the fold', parentElement: below },
        { nodeValue: 'Retry now', parentElement: status },
      ],
    }))
    expect(structure.visibleText).toBe('Connecting to Solus Demo · Retry now')
    expect(structure.loading).toBe(true)
  })
})

describe('whether the page changed while it was read', () => {
  test('content changes after the structure read are counted, and the watch ends with the count', () => {
    const page = fakePage({})
    expect(readStructure(page).watching).toBe(true)
    FakeMutationObserver.last!.fire(3)

    expect(JSON.parse(runInNewContext(snapshotChangesExpression(), page))).toEqual({
      changes: 3,
      url: 'http://127.0.0.1:5188/draft/fixture',
    })
    expect(FakeMutationObserver.last!.connected).toBe(false)
    // A second read finds no watch: that answer is kept for a replaced document.
    expect(JSON.parse(runInNewContext(snapshotChangesExpression(), page))).toBeNull()
  })

  test('a replaced document has no watch, so the read says so', () => {
    readStructure(fakePage({}))
    expect(JSON.parse(runInNewContext(snapshotChangesExpression(), fakePage({})))).toBeNull()
  })
})

describe('refs and wait conditions', () => {
  test('a bare ref names the snapshot attribute; any other selector stays as written', () => {
    expect(refSelector('e4')).toBe('[data-solus-browser-ref="e4"]')
    expect(refSelector(' e12 ')).toBe('[data-solus-browser-ref="e12"]')
    expect(refSelector('[data-solus-browser-ref="e4"]')).toBe('[data-solus-browser-ref="e4"]')
    expect(refSelector('#save')).toBe('#save')
  })

  function holds(expression: string, page: ReturnType<typeof fakePage>): unknown {
    return JSON.parse(runInNewContext(guardedExpression(expression), page)).value
  }

  test('every condition given must hold', () => {
    const conditions = { text: 'New session', urlIncludes: '/draft/' }
    expect(holds(waitConditionExpression(conditions), fakePage({ innerText: 'Connecting to Solus Demo' }))).toBe(false)
    expect(holds(waitConditionExpression(conditions), fakePage({ innerText: 'New session', href: 'http://127.0.0.1:5188/demo/' }))).toBe(false)
    expect(holds(waitConditionExpression(conditions), fakePage({ innerText: 'New session' }))).toBe(true)
  })

  test('a lone expression is passed as written, so its value still comes back', () => {
    expect(waitConditionExpression({ expression: 'document.title' })).toBe('document.title')
  })
})

describe('a navigation that waits for the page to settle', () => {
  // WHY: a navigation returns at `load`, and an app is rarely ready then. The
  // wait ends when the content stops changing, and says so when it never does.
  type Settle = { settled: boolean; loading: boolean; visibleText: string }

  async function settle(page: ReturnType<typeof fakePage>, whileWaiting?: () => void): Promise<Settle> {
    const timer = whileWaiting ? setInterval(whileWaiting, 20) : null
    try {
      const raw: Promise<string> = runInNewContext(settleExpression(100, 400), { ...page, setTimeout, performance })
      return JSON.parse(await raw)
    } finally {
      if (timer) clearInterval(timer)
    }
  }

  test('a loaded page whose content stays still is settled, with the text it shows', async () => {
    const status = new Box('DIV', '', { x: 570, y: 8, width: 299, height: 34 })
    const result = await settle(fakePage({ texts: [{ nodeValue: 'New session', parentElement: status }] }))
    expect(result).toMatchObject({ settled: true, loading: false, visibleText: 'New session' })
  })

  test('a page that keeps changing is reported as not settled when the wait ends', async () => {
    const page = fakePage({})
    const result = await settle(page, () => FakeMutationObserver.last?.fire(1))
    expect(result.settled).toBe(false)
  })

  test('a document that has not loaded is not settled, even when nothing changes', async () => {
    const result = await settle(fakePage({ readyState: 'interactive' }))
    expect(result).toMatchObject({ settled: false, loading: true })
  })
})
