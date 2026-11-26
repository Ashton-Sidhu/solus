import { Archive, ArchiveRestore, Check, Moon, Pin, PinOff, Sun, Undo2 } from '@lucide/svelte'
import type { SessionSidebarStore } from '../../../contexts/workspace/session-sidebar.store.svelte'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { requestInputFocus } from '../../../lib/inputFocus'
import { applySessionSnooze, sessionPinAction, tabSessionLifecycleActions } from '../../session/lib/session-actions'
import type { SidebarSession } from '../../session/lib/sidebar-rows'
import { SNOOZE_CHOICES, snoozeUntilFor } from '../../session/lib/snooze'
import type { Command } from './commands'

export interface CustomSessionSnooze {
  title: string
  confirm: (until: number, note: string) => void
}

const group = 'Current session'

export function currentSessionCommands(
  workspace: WorkspaceContext,
  sidebar: SessionSidebarStore,
  openCustomSnooze: (snooze: CustomSessionSnooze) => void,
): Command[] {
  const tabId = workspace.focusedChatTabId
  if (!tabId) return []
  const session = workspace.sessionFor(tabId)
  if (!session) return []

  const lifecycle = tabSessionLifecycleActions(workspace, sidebar, tabId)
  if (lifecycle?.onUnarchive) return [{
    id: 'restore-current-session', label: 'Restore session', group, icon: ArchiveRestore,
    keywords: ['unarchive', 'return to list'], run: lifecycle.onUnarchive,
  }]

  const commands: Command[] = []
  const pinAction = sessionPinAction(sidebar, {
    sessionId: session.id,
    serverId: workspace.serverIdFor(tabId),
    tabId,
    hasAgentSession: !!session.agentSessionId,
    isArchived: false,
  })
  if (pinAction) {
    commands.push({
      id: pinAction.isPinned ? 'unpin-current-session' : 'pin-current-session',
      label: pinAction.isPinned ? 'Unpin session' : 'Pin session',
      group, icon: pinAction.isPinned ? PinOff : Pin,
      run: () => void pinAction.run(),
    })
  }
  if (lifecycle?.onToggleDone) {
    commands.push({
      ...(lifecycle.done
        ? { id: 'reopen-current-session', label: 'Reopen session', icon: Undo2, keywords: ['mark not done', 'unsettle'] }
        : { id: 'complete-current-session', label: 'Complete session', icon: Check, keywords: ['mark done', 'settle'] }),
      group, run: lifecycle.onToggleDone,
    })
  }
  if (lifecycle?.onWake) {
    commands.push({
      id: 'wake-current-session', label: 'Wake session now', group, icon: Sun,
      keywords: ['unsnooze'], run: lifecycle.onWake,
    })
  }
  if (lifecycle?.snoozeRow) {
    commands.push(snoozeCommand(workspace, sidebar, tabId, session.id, lifecycle.snoozeRow, openCustomSnooze))
  }
  if (lifecycle?.onArchive) {
    commands.push({
      id: 'archive-current-session', label: 'Archive session', group, icon: Archive,
      run: lifecycle.onArchive,
    })
  }
  return commands
}

function snoozeCommand(
  workspace: WorkspaceContext,
  sidebar: SessionSidebarStore,
  tabId: string,
  sessionId: string,
  row: SidebarSession,
  openCustomSnooze: (snooze: CustomSessionSnooze) => void,
): Command {
  const { key, title } = row
  const snooze = (until: number, note = '') => {
    // The custom form can stay open while the session's state or access changes.
    const current = workspace.sessionFor(tabId)
    const currentRow = tabSessionLifecycleActions(workspace, sidebar, tabId)?.snoozeRow
    if (current?.id !== sessionId || currentRow?.key !== key) {
      requestInputFocus()
      return
    }
    applySessionSnooze(workspace, sidebar, [
      ...sidebar.pinnedRows, ...sidebar.sessionRows, ...sidebar.sharedRows, ...sidebar.workingRows,
    ], [key], until, note, (next) => {
      if (next) void sidebar.selectTask(next)
      else workspace.drafts.openSessionDraft({ freshTask: true, via: 'palette' })
    })
  }

  return {
    id: 'snooze-current-session', label: 'Snooze session…', group, icon: Moon,
    searchChildren: true,
    children: [
      ...SNOOZE_CHOICES.map((choice) => ({
        id: 'snooze-current-session:' + choice.preset,
        label: 'Snooze: ' + choice.label,
        keywords: ['snooze ' + choice.label],
        group,
        run: () => snooze(snoozeUntilFor(choice.preset)),
      })),
      {
        id: 'snooze-current-session:custom',
        label: 'Snooze: Pick date and time…',
        group,
        run: () => openCustomSnooze({ title, confirm: snooze }),
      },
    ],
  }
}
