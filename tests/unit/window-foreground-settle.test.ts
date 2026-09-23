// A focus handoff is not the user leaving.
//
// `document.hasFocus()` drops for a native menu, a webview, devtools, or the
// composer reclaiming focus after a prompt — all of which return within a frame
// or two. Published raw, each one is an away/back pair, and every subscriber to
// `isWindowForeground` acts on both edges: the PR checks cadence report, server
// discovery, the needs-review count. This pins the falling edge waiting.

import { afterEach, expect, test } from 'bun:test'

const previousWindow = globalThis.window
const previousDocument = globalThis.document
const previousScreen = globalThis.screen
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  for (const [key, value] of [
    ['window', previousWindow],
    ['document', previousDocument],
    ['screen', previousScreen],
    ['$state', previousState],
  ] as const) {
    if (value === undefined) delete (globalThis as unknown as Record<string, unknown>)[key]
    else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
})

interface Harness {
  /** Fire the listener the store installed for a DOM event. */
  emit: (type: 'focus' | 'blur' | 'visibilitychange') => void
  /** Run the pending settle timer, as the clock would. */
  settle: () => void
  hasPendingSettle: () => boolean
  setFocused: (value: boolean) => void
}

function installDom(): Harness {
  const listeners = new Map<string, () => void>()
  let pendingSettle: (() => void) | null = null
  let focused = true

  Object.defineProperty(globalThis, 'screen', {
    configurable: true, writable: true, value: { width: 1440, height: 900 },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      innerWidth: 1440,
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      setTimeout: (fn: () => void) => { pendingSettle = fn; return 1 },
      clearTimeout: () => { pendingSettle = null },
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      get visibilityState() { return 'visible' },
      hasFocus: () => focused,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      documentElement: { classList: { toggle: () => {} } },
    },
  })
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )

  return {
    emit: (type) => listeners.get(type)?.(),
    settle: () => { const run = pendingSettle; pendingSettle = null; run?.() },
    hasPendingSettle: () => pendingSettle !== null,
    setFocused: (value) => { focused = value },
  }
}

// One test, because the store is a module singleton: its listeners bind to the
// DOM present at first import, so a second harness would talk to nothing.
test('only a blur that outlives the settle reports the window as away', async () => {
  const dom = installDom()
  const { runtime } = await import('@solus/workspace-ui/contexts/app/runtime.svelte')
  expect(runtime.isWindowForeground).toBe(true)

  // A menu opens: focus leaves the document.
  dom.setFocused(false)
  dom.emit('blur')
  expect(runtime.isWindowForeground).toBe(true)
  expect(dom.hasPendingSettle()).toBe(true)

  // It closes again a moment later. Away was never published, so no subscriber
  // sees an edge at all — not an away, and not a back.
  dom.setFocused(true)
  dom.emit('focus')
  expect(runtime.isWindowForeground).toBe(true)
  expect(dom.hasPendingSettle()).toBe(false)

  // The user really does switch away.
  dom.setFocused(false)
  dom.emit('blur')
  dom.settle()
  expect(runtime.isWindowForeground).toBe(false)

  // Coming back is the user actually there: published at once, no settle.
  dom.setFocused(true)
  dom.emit('focus')
  expect(runtime.isWindowForeground).toBe(true)
  expect(dom.hasPendingSettle()).toBe(false)
})
