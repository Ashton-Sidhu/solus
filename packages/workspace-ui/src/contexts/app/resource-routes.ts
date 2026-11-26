import type { Via } from '@solus/contracts/analytics-events'

import type { PullRequestOpenTarget, WorkspaceContext } from '../workspace/workspace.context.svelte'
import { connectionsNav, type HostPageTab } from '../../components/connections/connections-nav.svelte'
import { pairCodeRequest } from '../../components/connections/lib/access-tab-requests.svelte'
import { sharingAccessRoute } from '../../components/connections/lib/sharing-access'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { findOpenTabForSession } from '../../lib/sessionUtils'
import { toasts } from '../../lib/toasts'
import { noticeUnopenableSession } from '../sharing/unopenable-session'

/**
 * Where a surface asks to go, named by the resource rather than by the pane,
 * tab, or URL that will show it. A shell answers `openResource` in its own
 * terms: the workspace shells open a pane, a tab, or a page; the page shell on
 * the account origin changes the URL; the guest shell has only the one resource
 * it was let in to. A surface asks `canOpenResource` before it offers a control,
 * so a shell with nowhere to send a kind shows no way there.
 */
export type ResourceRoute =
  /** The Workspace page: the ledger of works and plans. */
  | { kind: 'workspace' }
  /** The conversation beside a work: resume the one that wrote it, or start anew. */
  | { kind: 'chat'; workId: string; mode: 'resume' | 'new' }
  | { kind: 'work'; workId: string; title?: string; serverId?: string; via?: Via }
  | { kind: 'task'; taskId: string; serverId?: string }
  /** A saved conversation, opened as a surface beside the destination. A provider id resolves with its host. */
  | { kind: 'session'; sessionId: string; serverId: string }
  | { kind: 'pull-request'; target: PullRequestOpenTarget; serverId?: string; projectDirectory?: string }
  /** One automation and its runs, on the host that stores it. */
  | { kind: 'automation'; automationId: string; serverId: string }
  /** One app on the host that runs it (docs/plans/apps.md §9). `slug` is the app's slug, or its id. */
  | { kind: 'app'; slug: string; serverId: string }
  /** Where a code-host connection is made: the workspace's API access settings. With a host, its page
   *  on `tab`; `pair` also makes a pairing code there (docs/plans/add-machine-card.md). */
  | { kind: 'connections'; serverId?: string; tab?: HostPageTab; pair?: boolean }

export type ResourceRouteKind = ResourceRoute['kind']

/** Every kind the workspace shells (desktop, web) open in place. */
export const WORKSPACE_RESOURCE_KINDS: ReadonlySet<ResourceRouteKind> = new Set<ResourceRouteKind>([
  'workspace', 'chat', 'work', 'task', 'session', 'pull-request', 'automation', 'app', 'connections',
])

/** The guest shell (docs/plans/host-sharing.md §10): the workspace around the one shared resource; no task, pull request, automation, or connections pages, which a guest cannot read. */
export const GUEST_RESOURCE_KINDS: ReadonlySet<ResourceRouteKind> = new Set<ResourceRouteKind>(['workspace', 'work', 'session'])

/** Open a resource in the workspace, exactly as its surfaces did before shells could differ. */
export function openResourceInWorkspace(session: WorkspaceContext, route: ResourceRoute): void {
  switch (route.kind) {
    case 'workspace':
      session.openFolio()
      return
    case 'chat':
      void session.openChatForWork(route.workId, route.mode)
      return
    case 'work':
      if (route.serverId) session.worksStore.rememberHost(route.workId, route.serverId)
      void session.openWorkModal(route.workId, route.title, { via: route.via })
      return
    case 'task':
      session.openRoute({ name: 'task', params: route.serverId ? { taskId: route.taskId, serverId: route.serverId } : { taskId: route.taskId } })
      return
    case 'session':
      void openSessionBeside(session, route.sessionId, route.serverId)
      return
    case 'pull-request':
      void session.prReview.openPullRequest(route.target, {
        ctx: route.projectDirectory ? session.ctxForDirectory(route.projectDirectory) : session.ctx,
        serverId: route.serverId,
      })
      return
    case 'automation':
      session.openAutomations(route.automationId)
      return
    case 'app':
      session.openApp(route.serverId, route.slug)
      return
    case 'connections':
      // A pairing code is made on Settings › Sharing & access, as in T3 Code.
      if (route.serverId && route.pair) {
        pairCodeRequest.ask(route.serverId)
        session.router.navigate(sharingAccessRoute(route.serverId), { replace: false })
        return
      }
      session.showSettings('api-access')
      if (route.serverId) connectionsNav.open(route.serverId, route.tab)
      return
  }
}

/** Resume the conversation without leaving the destination, then show it in the companion pane. */
async function openSessionBeside(session: WorkspaceContext, sessionId: string, serverId: string): Promise<void> {
  try {
    const openTabId = findOpenTabForSession(sessionId, session.tabs, session.sessions.byId, session.tabOrder, undefined, serverId)
    const meta = openTabId ? null : await readSessionMeta(serverId, sessionId)
    const tabId = openTabId ?? (meta ? await session.opening.resumeSession(meta, { background: true }) : null)
    // An empty id: the host keeps only the record, which resume has opened read-only.
    if (tabId === '') return
    if (!tabId) {
      if (!noticeUnopenableSession(serverId, sessionId)) toasts.error("Couldn't find that conversation")
      return
    }
    if (session.hasCompanionPanes) session.openTabAsSurface(tabId)
    else session.selectTab(tabId)
  } catch (error) {
    toasts.error("Couldn't open that conversation", { description: error instanceof Error ? error.message : String(error) })
  }
}
