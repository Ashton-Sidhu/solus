import type { Via } from '@solus/contracts/analytics-events'

import type { PullRequestOpenTarget, WorkspaceContext } from '../workspace/workspace.context.svelte'
import { connectionsNav } from '../../components/connections/connections-nav.svelte'
import { readSessionMeta } from '@solus/client-core/session-meta'
import { findOpenTabForSession } from '../../lib/sessionUtils'
import { toasts } from '../../lib/toasts'

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
  /** Where a code-host connection is made: the workspace's API access settings. */
  | { kind: 'connections'; serverId?: string }

export type ResourceRouteKind = ResourceRoute['kind']

/** Every kind the workspace shells (desktop, web) open in place. */
export const WORKSPACE_RESOURCE_KINDS: ReadonlySet<ResourceRouteKind> = new Set<ResourceRouteKind>([
  'workspace', 'chat', 'work', 'task', 'session', 'pull-request', 'automation', 'connections',
])

/** The guest shell (docs/plans/multiplayer-sharing.md §4.2): the shared resource and what it reaches, nothing host-wide. */
export const GUEST_RESOURCE_KINDS: ReadonlySet<ResourceRouteKind> = new Set<ResourceRouteKind>(['work', 'session'])

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
    case 'connections':
      session.showSettings('api-access')
      if (route.serverId) connectionsNav.open(route.serverId)
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
      toasts.error("Couldn't find that conversation")
      return
    }
    if (session.hasCompanionPanes) session.openTabAsSurface(tabId)
    else session.selectTab(tabId)
  } catch (error) {
    toasts.error("Couldn't open that conversation", { description: error instanceof Error ? error.message : String(error) })
  }
}
