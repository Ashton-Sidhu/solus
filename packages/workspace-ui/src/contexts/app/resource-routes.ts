import type { Via } from '@solus/contracts/analytics-events'
import type { NavTarget } from '../workspace/routing/location'

import type { PullRequestOpenTarget, WorkspaceContext } from '../workspace/workspace.context.svelte'

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
  | { kind: 'work'; workId: string; title?: string; serverId?: string; secondary?: boolean; via?: Via }
  | { kind: 'task'; taskId: string; serverId?: string }
  | { kind: 'session'; sessionId: string; serverId: string }
  | { kind: 'pull-request'; target: PullRequestOpenTarget; serverId?: string; projectDirectory?: string; navTarget?: NavTarget }

export type ResourceRouteKind = ResourceRoute['kind']

/** Every kind the workspace shells (desktop, web) open in place. */
export const WORKSPACE_RESOURCE_KINDS: ReadonlySet<ResourceRouteKind> = new Set<ResourceRouteKind>([
  'workspace', 'chat', 'work', 'task', 'session', 'pull-request',
])

/** The guest shell (docs/plans/multiplayer-sharing.md §4.2): the shared resource and what it reaches, nothing host-wide. */
export const GUEST_RESOURCE_KINDS: ReadonlySet<ResourceRouteKind> = new Set<ResourceRouteKind>(['work', 'task', 'session'])

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
      void session.openWorkModal(route.workId, route.title, { secondary: route.secondary, via: route.via })
      return
    case 'task':
      session.openRoute({ name: 'task', params: route.serverId ? { taskId: route.taskId, serverId: route.serverId } : { taskId: route.taskId } })
      return
    case 'session':
      session.openRoute({ name: 'chat', params: { sessionId: route.sessionId, serverId: route.serverId } })
      return
    case 'pull-request':
      void session.openPullRequest(route.target, {
        ctx: route.projectDirectory ? session.ctxForDirectory(route.projectDirectory) : session.ctx,
        serverId: route.serverId,
        target: route.navTarget,
      })
      return
  }
}
