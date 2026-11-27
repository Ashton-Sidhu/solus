import { sessionSearchNavigation } from '@solus/client-core/session-search-navigation'
import { plainSnippet } from '@solus/contracts/search-snippet'
import type { SessionSearchResult } from '@solus/contracts/types'
import { isSolusApiId } from '@solus/contracts/uplink'
import { MessageCircle } from '@lucide/svelte'
import { serversStore } from '../../../contexts/connections/servers.store.svelte'
import { sessionListStore } from '../../../contexts/workspace/session-list.store.svelte'
import type { SessionSidebarStore } from '../../../contexts/workspace/session-sidebar.store.svelte'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { toasts } from '../../../lib/toasts'
import { mergeSessionHomes } from '../../session/lib/session-home'
import { conversationProjectLabel, conversationTitle } from '../../session/unified-picker/lib/picker-rows'
import type { Command } from './commands'

const RECENT_LIMIT = 5
const SESSION_MATCH_LIMIT = 12

function sessionDetail(project: string, serverId: string | null | undefined): string {
  const host = serverId ? serversStore.hostFor(serverId)?.label : undefined
  return host ? `${project} · ${host}` : project
}

export function recentSessionCommands(workspace: WorkspaceContext, sidebar: SessionSidebarStore): Command[] {
  const activeRowId = sidebar.onScreenSessionRowId
  return sidebar.activeRows
    .flatMap((row) => {
      if (row.id === activeRowId) return []
      const sessionId = row.sessionId ?? workspace.sessionFor(row.tabIds[0])?.id
      if (!sessionId) return []
      const lastActivity = sessionListStore.listed(sessionId)?.lastActivityAt ?? row.runStartedAt
      return [{ row, recentAt: Math.max(row.lastReadAt, row.createdAt, lastActivity) }]
    })
    .sort((left, right) => right.recentAt - left.recentAt)
    .slice(0, RECENT_LIMIT)
    .map(({ row }) => ({
      id: `recent-session:${row.key}`, label: row.title, group: 'Recent sessions', icon: MessageCircle,
      detail: sessionDetail(row.projectLabel, row.serverId),
      run: () => { void sidebar.selectTask(row) },
    }))
}

export function sessionSearchCommands(workspace: WorkspaceContext, results: readonly SessionSearchResult[], query: string): Command[] {
  const homes = mergeSessionHomes(results.map((hit) => ({
    sessionId: hit.session.sessionId, serverId: hit.session.serverId ?? null, hit,
  })), {
    isSolusApi: isSolusApiId,
    isConnected: (serverId) => !!serverId && serversStore.readinessFor(serverId).readiness === 'ready',
    newestHostOf: (sessionId, serverIds) => sessionListStore.hostTurnsFor(sessionId).listedHost(serverIds, null),
  })
  const ranked = homes.map(({ hit }) => ({ hit, fromMessages: hit.reason?.field === 'messages' || (!hit.reason && !!hit.snippet) }))
    .sort((left, right) => Number(left.fromMessages) - Number(right.fromMessages) || left.hit.rank - right.hit.rank)

  return ranked.slice(0, SESSION_MATCH_LIMIT).map(({ hit, fromMessages }) => {
    const { session, target } = hit
    const project = sessionDetail(conversationProjectLabel(session), session.serverId)
    const passage = fromMessages ? plainSnippet(hit.snippet) : ''
    return {
      id: `session-result:${session.sessionId}`,
      label: conversationTitle(session),
      group: fromMessages ? 'Matching messages' : 'Sessions',
      icon: MessageCircle,
      detail: passage ? `${project} · ${passage}` : project,
      run: () => {
        if (fromMessages && target && session.serverId) {
          sessionSearchNavigation.request(session.serverId, session.sessionId, { target, query })
        }
        void workspace.opening.resumeSession(session).catch((error) => {
          toasts.error("Couldn't resume session", { description: error instanceof Error ? error.message : String(error) })
        })
      },
    }
  })
}
