import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { BrowserOpenRequest, BrowserPage } from '@solus/contracts/browser-types'
import { isExternalWebLink } from '@solus/workspace-ui/components/conversation/lib/external-link'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const serverConnectionsMock = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: serverConnectionsMock,
}))

/** The store's singleton is built at import time, so the rune has to exist
 *  first. Identity is enough: nothing under test here is reactive. */
function installStateRune(): void {
  Reflect.set(globalThis, '$state', Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  ))
}

installStateRune()

const { BrowserStore } = await import('@solus/workspace-ui/contexts/browser/browser.store.svelte')

/**
 * Opening a link from the conversation in Solus's own browser.
 *
 * The link belongs to the session that wrote it, and that session's project may
 * be served by a machine other than the one the user is holding. A `localhost`
 * in an agent's output means the agent's host — so the one rule that matters
 * here is that the page is opened *there*, and never through whatever host this
 * client happens to consider primary.
 */

const MARKDOWN_LINK = join(
  import.meta.dir,
  '../../packages/workspace-ui/src/components/conversation/MarkdownLink.svelte',
)

afterEach(() => {
  serverConnectionsMock.reset()
  Reflect.deleteProperty(globalThis, '$state')
})

describe('which links are offered a browser pane', () => {
  test('an ordinary web address is', () => {
    expect(isExternalWebLink('https://example.com/docs', false)).toBe(true)
    expect(isExternalWebLink('http://localhost:5173/', false)).toBe(true)
  })

  test('anything Solus already routes is not', () => {
    // WHY: a plan, a work, a pull request, a session, a file and a stored asset
    // each have a destination of their own, and a browser pane is the worse one.
    expect(isExternalWebLink('https://github.com/o/r/pull/7', true)).toBe(false)
    expect(isExternalWebLink('plan://open?planId=p1', false)).toBe(false)
    expect(isExternalWebLink('work://open?workId=w1', false)).toBe(false)
    expect(isExternalWebLink('file:///Users/dev/app/src/main.ts', false)).toBe(false)
  })

  test('a scheme a browser page cannot render is not', () => {
    // WHY: an affordance that opens nothing is worse than no affordance.
    expect(isExternalWebLink('mailto:dev@example.com', false)).toBe(false)
    expect(isExternalWebLink('not a url', false)).toBe(false)
    expect(isExternalWebLink('', false)).toBe(false)
  })
})

describe('the page opens on the session’s host', () => {
  function installHosts() {
    installStateRune()
    const opened: { serverId: string; request: BrowserOpenRequest }[] = []
    const host = (serverId: string) => ({
      browserOpen: async (request: BrowserOpenRequest): Promise<BrowserPage> => {
        opened.push({ serverId, request })
        return { browserPageId: `browser_${serverId}`, createdAt: 1 } as BrowserPage
      },
    })
    serverConnectionsMock.registerPrimary('laptop', host('laptop'))
    serverConnectionsMock.registerHost('studio', host('studio'))
    return opened
  }

  test('a link from a remote session opens there, not on the primary host', async () => {
    // WHY: `localhost:5173` in a remote agent's output is a dev server on that
    // machine. Opening it here resolves the address against the wrong app, or
    // against nothing at all.
    const opened = installHosts()
    const store = new BrowserStore()

    const key = await store.open('studio', { target: { kind: 'url', url: 'http://localhost:5173/' } })

    expect(opened).toEqual([
      { serverId: 'studio', request: { target: { kind: 'url', url: 'http://localhost:5173/' } } },
    ])
    expect(key.startsWith('studio')).toBe(true)
  })

  test('the opened page is mirrored under its own host’s key', async () => {
    // WHY: a page id is unique only within its host, and two hosts can serve the
    // same worktree name.
    installHosts()
    const store = new BrowserStore()

    const key = await store.open('studio', { target: { kind: 'url', url: 'https://example.com/' } })

    expect(store.pages.get(key)?.serverId).toBe('studio')
    expect(store.activeKey).toBe(key)
  })
})

describe('the affordance in the transcript', () => {
  const source = readFileSync(MARKDOWN_LINK, 'utf8')

  test('a plain click still hands the address to the user’s own browser', () => {
    // WHY: links behave one way everywhere else in the product. Changing what a
    // click does would make the conversation the exception.
    expect(source).toContain('localApi.openExternal(href)')
  })

  test('the second destination is addressed to the link’s own host', () => {
    // WHY: routing it through an ambient client API would open the address on
    // whichever host this client calls primary, which for a remote session is
    // the wrong machine.
    expect(source).toContain('sessionLinkContext?.serverId() ?? session.fallbackServerId')
    expect(source).toContain('session.openUrlInBrowser(href, linkServerId)')
  })

  test('it is reachable without a pointer', () => {
    // WHY: Solus is keyboard-first and ships on phones. A control revealed only
    // by hover exists on neither.
    expect(source).toContain('focus-visible:opacity-100')
    expect(source).toContain('pointer-coarse:opacity-100')
    expect(source).toContain('aria-label="Open in the Solus browser"')
  })
})
