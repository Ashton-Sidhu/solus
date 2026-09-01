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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const paneSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/browser/BrowserPane.svelte'),
  'utf8',
)

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
  test('selecting a deep-linked page updates the route as well as the store', () => {
    // WHY: the route param takes precedence over the store active key. Updating
    // only the store leaves the pane pinned to the old page.
    expect(paneSource).toContain('function activatePage')
    expect(paneSource).toContain('browserStore.activeKey = key')
    expect(paneSource).toContain('browserPageId: candidate.page.browserPageId')
    expect(paneSource).toContain('{ target: paneId, replace: true }')
  })

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
    expect(paneSource).toContain('title={routeLabel(candidate.page.url)}')
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

describe('the browser pane sits in the row of panes', () => {
  test('draws a seam against the pane it is docked beside', () => {
    // WHY: every pane that is not the leading one is separated from its
    // neighbour by a border. Without it the browser pane and the conversation
    // read as one surface with a gap in it.
    expect(paneSource).toContain('border-l border-(--solus-container-border)')
    expect(paneSource).toContain('actions.isLeading')
  })

  test('its top row is the shared chrome row height, not a flat 2.5rem', () => {
    // WHY: on the macOS editor the chrome row grows to clear the traffic
    // lights. A hard-coded h-10 put the page strip 12px above the leading
    // pane's header, which is exactly what "the tab bar does not line up" is.
    expect(paneSource).toContain('h-(--solus-chrome-row-h,2.5rem)')
    expect(paneSource).not.toMatch(/class="[^"]*\bflex h-10\b/)
  })

  test('the row is drawn whether or not any page is open', () => {
    // WHY: the row is where the pane's own close and maximize controls sit, and
    // it is the line the neighbouring header shares. A pane showing the target
    // picker must not start its content where another pane starts its header.
    const row = paneSource.indexOf('h-(--solus-chrome-row-h,2.5rem)')
    const pagesGuard = paneSource.indexOf('{#if pages.length &&')
    expect(row).toBeGreaterThan(0)
    expect(pagesGuard).toBeGreaterThan(row)
  })
})

/**
 * The strip shares its row with the pane's floating chrome cluster, and the row
 * is the narrowest thing in the pane. Everything here guards the rule that the
 * strip may run out of room but may never take room that is not its own.
 */
describe('the page strip stays inside its own box', () => {
  const rowClass =
    paneSource.match(/class="(workspace-titlebar flex h-\(--solus-chrome-row-h[^"]*)"/)?.[1] ?? ''
  const stripClass =
    paneSource.match(/bind:this=\{stripElement\}\s*\n\s*class="([^"]*)"/)?.[1] ?? ''

  test('scrolls in a box that ends before the pane chrome, not in the row', () => {
    // WHY: a scroll container's padding box is still part of its scrollport, so
    // scrolling the row itself bought scroll extent at the end and let every
    // chip travel under the close and maximize buttons on the way there.
    expect(rowClass).not.toBe('')
    expect(rowClass).not.toContain('overflow-x-auto')
    expect(stripClass).toContain('overflow-x-auto')
    expect(stripClass).toContain('min-w-0')
    expect(stripClass).toContain('flex-1')
  })

  test('reserves the chrome cluster even where no pane column publishes its width', () => {
    // WHY: the phone shell renders this pane outside the pane columns, so the
    // published inset is absent and a 0 fallback put the strip back under the
    // buttons on the one client that has the least room.
    expect(rowClass).toContain('var(--solus-pane-chrome-inset,6.25rem)')
    expect(rowClass).toContain('pointer-coarse:pr-')
    expect(rowClass).toContain('var(--solus-pane-chrome-inset,9.625rem)')
  })

  test('keeps the way to another page out of the scroller', () => {
    // WHY: inside the scroller the add control walked off the end as soon as
    // the strip overflowed, leaving the target picker reachable only by
    // scrolling — and unreachable to anyone who did not know it was there.
    const stripStart = paneSource.indexOf('bind:this={stripElement}')
    const addControl = paneSource.indexOf('aria-label="Open another browser page"')
    const scrollerEnd = paneSource.indexOf('{/each}\n      </div>', stripStart)
    expect(stripStart).toBeGreaterThan(0)
    expect(scrollerEnd).toBeGreaterThan(stripStart)
    expect(addControl).toBeGreaterThan(scrollerEnd)
  })

  test('brings the active page back into view when it is not the one on screen', () => {
    // WHY: an agent opens pages too. A strip scrolled elsewhere shows no active
    // chip at all, so the pane looks like it is rendering a page nothing in the
    // strip claims.
    expect(paneSource).toContain('data-page-key={key}')
    expect(paneSource).toContain('scrollIntoView({ block: "nearest", inline: "nearest" })')
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

  test('renders the dot in the pill rather than only in the frame', () => {
    expect(paneSource).toContain('pageStatus(candidate.page)')
    expect(paneSource).toContain("bg-[var(--failure)]")
    expect(paneSource).toContain("bg-[var(--warning)]")
  })
})
