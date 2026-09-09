import { describe, expect, test } from 'bun:test'
import type { BrowserPage } from '@solus/contracts/browser-types'
import type { BrowserPageEntry } from '@solus/workspace-ui/contexts/browser/browser.store.svelte'
import {
  groupPagesByBranch,
  pageLabel,
  pageStatus,
  routeLabel,
} from '@solus/workspace-ui/components/browser/lib/page-strip'
import {
  addressParts,
  navigableAddress,
} from '@solus/workspace-ui/components/browser/lib/address'

/**
 * Two worktrees serving the same app are identical in an address bar: same
 * host, same routes, different port. Everything here exists so the strip reads
 * by the branch a page is served from rather than by the port it happens to
 * have been given.
 */

function entry(overrides: {
  id: string
  url: string
  branch?: string
  title?: string
}): BrowserPageEntry {
  const page = {
    browserPageId: overrides.id,
    target: overrides.branch
      ? { kind: 'url' as const, url: overrides.url, branch: overrides.branch }
      : { kind: 'url' as const, url: overrides.url },
    url: overrides.url,
    title: overrides.title ?? 'Solus',
    viewport: {
      mode: 'fill' as const,
      orientation: 'portrait' as const,
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      hasTouch: false,
    },
    appearance: 'system' as const,
    hostKind: 'webview' as const,
    loadState: 'ready' as const,
    canGoBack: false,
    canGoForward: false,
    devToolsOpen: false,
    annotationTool: null,
    label: overrides.branch ?? 'browser',
    createdAt: 1,
  } satisfies BrowserPage
  return { serverId: 'local', page }
}

describe('the browser page strip', () => {
  test('groups pages under the worktree serving them', () => {
    // WHY: the port is the worst possible thing to read a browser page by, and
    // it is the only thing two worktrees of one app differ in.
    const groups = groupPagesByBranch([
      entry({ id: 'a', url: 'http://localhost:5173/', branch: 'feat/rate-limit' }),
      entry({ id: 'b', url: 'http://localhost:5174/', branch: 'main' }),
      entry({ id: 'c', url: 'http://localhost:5173/pricing', branch: 'feat/rate-limit' }),
    ])

    expect(groups.map((group) => group.label)).toEqual(['feat/rate-limit', 'main'])
    expect(groups[0]?.entries.map((item) => item.page.browserPageId)).toEqual(['a', 'c'])
  })

  test('keeps the order pages were opened in, so nothing moves under the pointer', () => {
    // WHY: a strip that re-sorted itself would move the page being clicked
    // between one frame and the next.
    const groups = groupPagesByBranch([
      entry({ id: 'a', url: 'http://localhost:5174/', branch: 'main' }),
      entry({ id: 'b', url: 'http://localhost:5173/', branch: 'feat/x' }),
    ])

    expect(groups.map((group) => group.key)).toEqual(['main', 'feat/x'])
  })

  test('gives a page served from outside a worktree a named group', () => {
    // WHY: a group heading with no words reads as a rendering bug, not as "this
    // one is not on a branch".
    const [group] = groupPagesByBranch([entry({ id: 'a', url: 'http://localhost:3000/' })])

    expect(group?.label).toBe('Other')
  })

  test('labels a page like a browser tab and keeps its route in the tooltip', () => {
    // WHY: a raw route makes the strip read like a routing table. The document
    // title is the human name the page chose and is what browser tabs lead with.
    const item = entry({
      id: 'a',
      url: 'http://localhost:5173/pricing',
      title: 'Pricing',
    })

    expect(pageLabel(item.page, [item])).toBe('Pricing')
  })

  test('adds the route only when matching titles need disambiguation', () => {
    // WHY: two common titles such as "Settings" must remain distinguishable,
    // but every unique title should stay clean.
    const account = entry({
      id: 'a',
      url: 'http://localhost:5173/settings/account',
      title: 'Settings',
    })
    const billing = entry({
      id: 'b',
      url: 'http://localhost:5173/settings/billing',
      title: 'Settings',
    })

    expect(pageLabel(account.page, [account, billing])).toBe('Settings · /settings/account')
    expect(pageLabel(billing.page, [account, billing])).toBe('Settings · /settings/billing')
  })

  test('falls back to the route while a page has no document title', () => {
    // WHY: a page can appear in the strip before its first load reports a title.
    // The pill must still have a stable, useful label during that interval.
    const item = entry({ id: 'a', url: 'http://localhost:5173/pricing/', title: '  ' })
    expect(pageLabel(item.page, [item])).toBe('/pricing')
    expect(routeLabel('not a url')).toBe('not a url')
    expect(routeLabel('')).toBe('/')
  })
})

describe('the address field', () => {
  test('makes a public host navigable without making the user type a scheme', () => {
    // WHY: Electron's `loadURL` rejects `twitter.com` as invalid even though a
    // browser address bar accepts it. The browser bar must behave like the
    // browser surface it presents.
    expect(navigableAddress('twitter.com')).toBe('https://twitter.com')
    expect(navigableAddress('  x.com/home  ')).toBe('https://x.com/home')
  })

  test('keeps local dev servers on HTTP by default', () => {
    // WHY: silently upgrading localhost would turn the ordinary Vite address
    // into a TLS failure. Explicit schemes remain the user's choice.
    expect(navigableAddress('localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(navigableAddress('http://example.test')).toBe('http://example.test')
  })

  test('splits the address so the host reads first', () => {
    // WHY: a browser address is nearly all boilerplate. Muting the scheme and
    // the path is what makes the port and the route the thing the eye lands on,
    // without truncating either of them away.
    expect(addressParts('http://localhost:5173/pricing?ref=1')).toEqual({
      scheme: 'http://',
      host: 'localhost:5173',
      path: '/pricing?ref=1',
      secure: false,
    })
  })

  test('claims the lock only for TLS', () => {
    expect(addressParts('https://example.test/').secure).toBe(true)
    expect(addressParts('http://localhost:5173/').secure).toBe(false)
  })

  test('renders a half-typed address rather than nothing', () => {
    // WHY: an address mid-edit is ordinary, and the field still has to show
    // something while it is being typed. `localhost:51` parses as a URL — with
    // a `localhost:` scheme — so parsing alone cannot be the test.
    expect(addressParts('localhost:51')).toEqual({
      scheme: '',
      host: 'localhost:51',
      path: '',
      secure: false,
    })
  })
})

/**
 * The strip is where the user chooses which page to look at, so it has to say
 * which pages are worth looking at. Without a status the strip is inert: a dev
 * server that fell over takes the frame with it and every pill still reads as
 * though nothing happened.
 */
describe('what a page pill says about the page', () => {
  function page(overrides: Partial<BrowserPage>): BrowserPage {
    return { ...entry({ id: 'p', url: 'http://localhost:5173/' }).page, ...overrides }
  }

  test('marks a page whose load failed', () => {
    expect(
      pageStatus(page({ loadState: 'failed', problem: { kind: 'load-failed', message: 'x' } })),
    ).toBe('failed')
    expect(
      pageStatus(
        page({ loadState: 'ready', problem: { kind: 'target-unreachable', message: 'x' } }),
      ),
    ).toBe('failed')
  })

  test('marks a page that is still loading', () => {
    expect(pageStatus(page({ loadState: 'loading' }))).toBe('loading')
  })

  test('says nothing about a page nothing is rendering', () => {
    // WHY: `no-surface` is a fact about the host, not about the page. An agent
    // opens pages quietly and every one of them would carry a dot, which is how
    // a signal stops being read.
    expect(pageStatus(page({ problem: { kind: 'no-surface', message: 'x' } }))).toBeNull()
  })

  test('says nothing about a page that loaded', () => {
    expect(pageStatus(page({ loadState: 'ready' }))).toBeNull()
  })
})
