import { splitHostKey } from '@solus/client-core/host-key'
import type { RouterStore } from '../../../contexts/workspace/routing/router.store.svelte'
import { browserStore } from '../../../contexts/browser/browser.store.svelte'

interface BrowserShell {
  openBrowser(browserPageId?: string, serverId?: string, opts?: { automatic?: boolean }): void
  router: Pick<RouterStore, 'openSurfaceBesideSession'>
}

/**
 * A page asked for a surface. A page an agent opened goes into the side panel
 * of the conversation of the session that opened it. When that conversation is
 * on screen, the panel opens now. When it is not, the panel waits in that
 * conversation's strip, and the conversation the user is reading does not
 * change. The route names the page, so each conversation's browser shows its
 * own page. A request that names no session opens the browser as before.
 */
export function revealBrowserSurface(shell: BrowserShell, key: string, sessionId: string | undefined): void {
  if (!sessionId) {
    browserStore.activeKey = key
    shell.openBrowser(undefined, undefined, { automatic: true })
    return
  }
  const { serverId, path: browserPageId } = splitHostKey(key)
  // The agent asked, not the user, so it never takes the place of a surface
  // the user is reading.
  shell.router.openSurfaceBesideSession(
    sessionId,
    { name: 'browser', params: { browserPageId, serverId } },
    { automatic: true },
  )
}
