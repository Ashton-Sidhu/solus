import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createActivityBadge } from '@solus/workspace-ui/contexts/notifications/activity-badge'

function withBrowser(run: (window: JSDOM['window']) => void): void {
  const dom = new JSDOM('<html><head><link rel="icon" href="/favicon.svg"></head></html>')
  const previous = ['window', 'document', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    document: { value: dom.window.document, configurable: true },
    navigator: { value: dom.window.navigator, configurable: true },
  })
  try { run(dom.window) } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('browser badge falls back to a bounded count favicon and restores the original on focus', () => {
  withBrowser((window) => {
    const counts: number[] = []
    Object.defineProperties(window.navigator, {
      setAppBadge: { value: async (count: number) => { counts.push(count) } },
      clearAppBadge: { value: async () => { counts.push(0) } },
    })
    const update = createActivityBadge()
    update(['a', 'b'])
    expect(counts).toEqual([2])
    const icons = window.document.querySelectorAll('link[rel="icon"]')
    expect(icons).toHaveLength(2)
    expect(decodeURIComponent(icons[1]!.getAttribute('href')!)).toContain('>2</text>')
    update(['a', 'b'])
    expect(counts).toEqual([2])
    update([])
    expect(counts).toEqual([2, 0])
    expect(window.document.querySelectorAll('link[rel="icon"]')).toHaveLength(1)
    expect(window.document.querySelector('link')!.getAttribute('href')).toBe('/favicon.svg')
  })
})

test('desktop passes identities even when the count stays unchanged', () => {
  withBrowser((window) => {
    const updates: string[][] = []
    Object.defineProperty(window, 'solus', { value: {
      setActivityBadge: async (sessionKeys: string[]) => { updates.push(sessionKeys) },
    } })
    const update = createActivityBadge()
    update(['host-a/session'])
    update(['host-b/session'])
    update([])
    expect(updates).toEqual([['host-a/session'], ['host-b/session'], []])
    expect(window.document.querySelectorAll('link[rel="icon"]')).toHaveLength(1)
  })
})
