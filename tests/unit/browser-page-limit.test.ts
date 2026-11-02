import { expect, test } from 'bun:test'
import {
  BROWSER_PAGES_PER_HOST,
  BROWSER_PAGES_PER_SESSION,
  initBrowserRegistry,
  type BrowserEventSink,
} from '@solus/server/browser/browser-registry'

const sink: BrowserEventSink = { pageChanged: () => {}, pageClosed: () => {}, surfaceRequested: () => {} }
const openFor = (registry: ReturnType<typeof initBrowserRegistry>, sessionId?: string) =>
  registry.open({ target: { kind: 'url', url: 'http://localhost:5173/' } }, 'local:owner', sessionId).browserPageId

test('an agent session cannot open pages without end, and a close gives its place back', async () => {
  // WHY: each page is a live surface a client may host. An agent in a loop
  // must hit a limit with a message it can act on, not exhaust the host.
  const registry = initBrowserRegistry(sink)
  const opened = Array.from({ length: BROWSER_PAGES_PER_SESSION }, () => openFor(registry, 'session-a'))
  expect(() => openFor(registry, 'session-a')).toThrow(/browser_close/)
  // Another session has its own places.
  openFor(registry, 'session-b')
  await registry.close(opened[0], { force: true })
  expect(() => openFor(registry, 'session-a')).not.toThrow()
})

test('the host refuses a page past its limit, from any session or from the user', () => {
  const registry = initBrowserRegistry(sink)
  for (let i = 0; i < BROWSER_PAGES_PER_HOST; i++) openFor(registry, i % 2 ? `session-${i}` : undefined)
  expect(() => openFor(registry)).toThrow(/most it allows/)
  expect(() => openFor(registry, 'session-new')).toThrow(/most it allows/)
  expect(registry.list()).toHaveLength(BROWSER_PAGES_PER_HOST)
})
