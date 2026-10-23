import { describe, expect, mock, test } from 'bun:test'
import { hostKey } from '@solus/client-core/host-key'
import { singleHostServerConnections } from './helpers/server-connections-mock'

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: singleHostServerConnections(),
}))

/** The store singleton is built at import time, so the rune must exist first.
 *  Identity is enough: nothing under test here is reactive. */
Reflect.set(globalThis, '$state', Object.assign(
  <T>(value: T) => value,
  { snapshot: <T>(value: T) => value },
))

const { revealBrowserSurface } = await import('@solus/workspace-ui/components/browser/lib/surface-reveal')
const { browserStore } = await import('@solus/workspace-ui/contexts/browser/browser.store.svelte')

function shell() {
  const opened: { automatic?: boolean }[] = []
  const beside: { sessionId: string; ref: { name: string; params: object }; automatic?: boolean }[] = []
  return {
    opened,
    beside,
    openBrowser: (_browserPageId?: string, _serverId?: string, opts?: { automatic?: boolean }) => {
      opened.push(opts ?? {})
    },
    router: {
      openSurfaceBesideSession: (sessionId: string, ref: { name: 'browser'; params: object }, opts?: { automatic?: boolean }) => {
        beside.push({ sessionId, ref, automatic: opts?.automatic })
      },
    },
  }
}

describe('revealBrowserSurface', () => {
  test("puts an agent's page beside the conversation of the session that opened it", () => {
    // WHY: the page belongs beside the agent's conversation, not the one the
    // user is reading. The route names the page so that conversation shows it.
    const target = shell()
    browserStore.activeKey = hostKey('local', 'browser_user')

    revealBrowserSurface(target, hostKey('local', 'browser_1'), 'session_a')

    expect(target.beside).toEqual([{
      sessionId: 'session_a',
      ref: { name: 'browser', params: { browserPageId: 'browser_1', serverId: 'local' } },
      automatic: true,
    }])
    expect(target.opened).toEqual([])
    // The page another conversation's browser follows does not change.
    expect(browserStore.activeKey).toBe(hostKey('local', 'browser_user'))
  })

  test('a request that names no session opens the browser on screen', () => {
    const target = shell()

    revealBrowserSurface(target, hostKey('local', 'browser_1'), undefined)

    expect(target.opened).toEqual([{ automatic: true }])
    expect(browserStore.activeKey).toBe(hostKey('local', 'browser_1'))
  })
})
