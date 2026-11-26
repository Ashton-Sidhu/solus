import type { SessionSidebarStore } from '../../../contexts/workspace/session-sidebar.store.svelte'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { sessionListStore, type SessionListTarget } from '../../../contexts/workspace/session-list.store.svelte'
import { nextTaskAfterLeaving } from '../../../contexts/workspace/session-sidebar-selection'
import { requestInputFocus } from '../../../lib/inputFocus'
import { toasts } from '../../../lib/toasts'
import type { SidebarSession } from './sidebar-rows'
import { snoozeToastLabel } from './snooze'

export function sessionPinAction(
  sidebar: SessionSidebarStore,
  target: {
    sessionId: string | null
    serverId: string | null
    tabId: string | null
    hasAgentSession: boolean
    isArchived: boolean
    pinListedSession?: () => Promise<void> | void
  },
) {
  const { sessionId, serverId, tabId, hasAgentSession, isArchived, pinListedSession } = target
  if (isArchived || !sidebar.canPinSession(sessionId)) return null
  const pin = sidebar.pinFor(sessionId, serverId)
  if (!pin && !pinListedSession && !(tabId && hasAgentSession)) return null
  return {
    isPinned: !!pin,
    async run() {
      requestInputFocus()
      try {
        if (pin) await sidebar.unpinSession(pin)
        else if (tabId) await sidebar.togglePinnedSession(tabId)
        else await pinListedSession?.()
      } catch (error) {
        toasts.error(pin ? "Couldn't unpin the session" : "Couldn't pin the session", {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}

export async function completeSidebarSession(sidebar: SessionSidebarStore, row: SidebarSession) {
  const completing = sidebar.completeTask(row)
  requestInputFocus()
  try {
    await completing
  } catch (error) {
    toasts.error("Couldn't change session status", {
      description: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function setListedSessionArchived(
  sidebar: SessionSidebarStore,
  target: SessionListTarget,
  isArchived: boolean,
): Promise<boolean> {
  try {
    if (isArchived) await sidebar.archiveSessions([target])
    else await sessionListStore.setArchived(target, false)
    return true
  } catch (error) {
    toasts.error(isArchived ? "Couldn't archive it" : "Couldn't return it to the list", {
      description: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** Read the same lifecycle controls for an open conversation in both menus. */
export function tabSessionLifecycleActions(workspace: WorkspaceContext, sidebar: SessionSidebarStore, tabId: string) {
  const session = workspace.sessionFor(tabId)
  if (!session) return null
  const state = sessionListStore.stateFor(session.id)
  if (state?.archivedAt != null) {
    const target = {
      sessionId: session.id,
      serverId: workspace.serverIdFor(tabId),
      organizationId: session.organizationId,
    }
    return {
      onUnarchive: () => {
        void setListedSessionArchived(sidebar, target, false)
        requestInputFocus()
      },
    }
  }

  // A completed shared session leaves the list, but its open tab can reopen it.
  const row = sidebar.rowForTab(tabId) ?? (state?.settledAt != null
    ? sidebar.allRows.find((candidate) => candidate.tabIds.includes(tabId))
    : undefined)
  if (!row) return null
  const canShelve = sidebar.canShelve(row)
  const done = row.lifecycle === 'completed'
  const isSnoozed = row.lifecycle === 'snoozed'
  return {
    done,
    onToggleDone: canShelve ? () => void completeSidebarSession(sidebar, row) : undefined,
    snoozeRow: canShelve && !done && !isSnoozed ? row : undefined,
    onWake: canShelve && isSnoozed
      ? () => {
          sidebar.snoozeRow(row.key, null)
          requestInputFocus()
        }
      : undefined,
    onArchive: sidebar.canArchive(row)
      ? () => {
          sidebar.removeRow(row)
          requestInputFocus()
        }
      : undefined,
  }
}

export function applySessionSnooze(
  workspace: WorkspaceContext,
  sidebar: SessionSidebarStore,
  openRows: SidebarSession[],
  rowKeys: string[],
  until: number,
  note: string,
  navigate: (next: SidebarSession | null) => void,
) {
  if (!rowKeys.length) return
  const row = openRows.find((candidate) => candidate.key === rowKeys[0])
  const wasSelected = !!row?.tabIds.includes(workspace.onScreenTabId)
  const next = row && wasSelected
    ? nextTaskAfterLeaving(openRows, row.id, new Set(
        openRows.filter((task) => rowKeys.includes(task.key)).map((task) => task.id),
      ))
    : null
  for (const rowKey of rowKeys) sidebar.snoozeRow(rowKey, until, note)
  toasts.undo(
    snoozeToastLabel({
      count: rowKeys.length,
      hasNote: !!note,
      keepsRunning: sidebar.allRows.some((task) => rowKeys.includes(task.key) && task.attention === 'running'),
    }),
    () => {
      for (const rowKey of rowKeys) sidebar.snoozeRow(rowKey, null)
    },
  )
  if (wasSelected) navigate(next)
  requestInputFocus()
}
