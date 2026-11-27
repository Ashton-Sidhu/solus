import type { WorkspaceContext } from '../../contexts/workspace/workspace.context.svelte'
import { requestFilePreview } from '../../lib/filePreview'
import { routeForHref } from '../../lib/agent-links'
import { parseSessionHref } from '@solus/contracts/session-link'
import { parseHostHref } from '@solus/contracts/host-link'
import { serverConnections } from '@solus/client-core/server-connections'
import { serversStore } from '../../contexts/connections/servers.store.svelte'
import { runHost } from '../../contexts/workspace/run-location'
import { resolveSessionLinkMeta } from '../conversation/lib/session-link'
import { connectionsNav } from '../connections/connections-nav.svelte'

interface ReferenceNavigationScope {
  workingDirectory: () => string | undefined
  tabId: () => string | undefined
}

/** Default navigation for references inside an editor. An editor may override
 * any callback, but the product default always preserves the composing surface
 * and opens the reference in the companion pane. */
export function createReferenceNavigation(
  session: WorkspaceContext,
  scope: ReferenceNavigationScope,
) {
  return {
    openPlan(planId: string): void {
      void session.openPlanModal(planId)
    },
    openWork(workId: string, title?: string): void {
      void session.openWorkModal(workId, title)
    },
    openPr(number: number, title?: string): void {
      const workingDirectory = scope.workingDirectory()
      void session.prReview.openPullRequest({ number, title }, {
        ctx: workingDirectory
          ? session.ctxForDirectory(workingDirectory)
          : session.ctx,
      })
    },
    openFile(path: string, line?: number): void {
      requestFilePreview({
        path,
        line,
        tabId:
          scope.tabId() ?? session.focusedChatTabId ?? session.activeTabId,
      })
    },
    /** A session, task, automation, or host chip opens what the same chip
     *  opens in a message (`MarkdownLink`), on the composer's own host. */
    openLink(href: string, title: string): void {
      const serverId = runHost(session.sessionFor(scope.tabId() ?? session.focusedChatTabId ?? session.activeTabId)?.run)
      const route = routeForHref(href, { title, serverId })
      if (route) {
        session.openRoute(route)
        return
      }
      const sessionParams = parseSessionHref(href)
      if (sessionParams) {
        if (session.drafts.openDraft(sessionParams.sessionId)) return
        void resolveSessionLinkMeta(sessionParams, serverId).then((meta) => session.opening.resumeSession(meta))
        return
      }
      const host = parseHostHref(href, title)
      const knownHost = host && serversStore.servers.find((server) => server.id === serverConnections.resolveId(host.serverId))
      if (knownHost) {
        connectionsNav.open(knownHost.id)
        session.showSettings('api-access', 'click')
      }
    },
  }
}
