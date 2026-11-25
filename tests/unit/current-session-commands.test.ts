import { expect, mock, test } from 'bun:test'
import type { PinnedSession, Session } from '@solus/contracts/types'
import type { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import type { SessionListState } from '@solus/workspace-ui/contexts/workspace/session-list.store.svelte'
import { commandsShown } from '@solus/workspace-ui/components/command-palette/lib/commands'

const restoreSession = mock(async () => {})
let sessionState: SessionListState | null
const focus = mock(() => {})
mock.module('@solus/workspace-ui/contexts/workspace/session-list.store.svelte', () => ({
  sessionListStore: { stateFor: () => sessionState, setArchived: restoreSession },
}))
mock.module('@solus/workspace-ui/lib/inputFocus', () => ({ requestInputFocus: focus }))
mock.module('@solus/workspace-ui/lib/toasts', () => ({ toasts: { undo: () => {}, error: () => {} } }))
const { currentSessionCommands } = await import('@solus/workspace-ui/components/command-palette/lib/session-commands')

function fixture() {
  sessionState = null
  const target = { id: 'split-session', agentSessionId: 'thread' } as Session
  const row = { key: 'session:split-session', lifecycle: 'active', tabIds: ['split-tab'], title: 'Split session' } as SidebarTask
  const workspace = {
    activeTabId: 'leading-tab',
    focusedChatTabId: 'split-tab' as string | null,
    onScreenTabId: 'leading-tab',
    sessionFor: (tabId: string) => tabId === 'split-tab' ? target : undefined,
    serverIdFor: () => 'remote',
  }
  const sidebar = {
    taskForTab: (tabId: string) => tabId === 'split-tab' ? row : null,
    canShelve: () => true,
    canArchive: () => true,
    canPinSession: () => true,
    pinFor: (): PinnedSession | null => null,
    togglePinnedSession: mock(async () => {}),
    unpinSession: mock(async () => {}),
    completeTask: mock(async () => {}),
    snoozeRow: mock(() => {}),
    removeRow: mock(() => {}),
    pinnedRows: [],
    sessionRows: [row],
    sharedRows: [],
    workingRows: [],
    allTasks: [row],
  }
  const openCustomSnooze = mock<(snooze: import('@solus/workspace-ui/components/command-palette/lib/session-commands').CustomSessionSnooze) => void>(() => {})
  const commands = () => currentSessionCommands(workspace as WorkspaceContext, sidebar as SessionSidebarStore, openCustomSnooze)
  return { row, target, workspace, sidebar, commands, openCustomSnooze }
}

test('commands act on the focused split session and return focus', () => {
  const { commands, workspace, sidebar, row } = fixture()
  focus.mockClear()
  commands().find((command) => command.id === 'pin-current-session')?.run?.()
  commands().find((command) => command.id === 'complete-current-session')?.run?.()
  commands().find((command) => command.id === 'archive-current-session')?.run?.()
  expect(sidebar.togglePinnedSession).toHaveBeenCalledWith('split-tab')
  expect(sidebar.completeTask).toHaveBeenCalledWith(row)
  expect(sidebar.removeRow).toHaveBeenCalledWith(row)
  expect(focus).toHaveBeenCalledTimes(3)
  workspace.focusedChatTabId = null
  expect(commands()).toEqual([])
})

test('reverse actions follow session state, and archived sessions only offer restore', () => {
  const { commands, row, sidebar } = fixture()
  sidebar.pinFor = () => ({
    sessionId: 'split-session', serverId: 'remote', title: 'Split session',
    provider: 'codex', pinnedAt: 1, cwd: '/project',
  })
  row.lifecycle = 'snoozed'
  commands().find((command) => command.id === 'unpin-current-session')?.run?.()
  expect(sidebar.unpinSession).toHaveBeenCalledWith(sidebar.pinFor())
  commands().find((command) => command.id === 'wake-current-session')?.run?.()
  expect(sidebar.snoozeRow).toHaveBeenCalledWith(row.key, null)
  row.lifecycle = 'completed'
  expect(commands().map((command) => command.label)).toEqual(['Unpin session', 'Reopen session', 'Archive session'])
  sessionState = { archivedAt: 4, settledAt: null, settledBy: null, snoozedUntil: null, snoozeNote: null }
  expect(commands().map((command) => command.label)).toEqual(['Restore session'])
  commands()[0]?.run?.()
  expect(restoreSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'split-session', serverId: 'remote' }), false)
})

test('a viewer keeps personal list actions while an unstarted session has no actions', () => {
  const { commands, target, sidebar } = fixture()
  sidebar.canShelve = () => false
  expect(commands().map((command) => command.label)).toEqual(['Pin session', 'Archive session'])
  target.agentSessionId = null
  sidebar.canArchive = () => false
  expect(commands()).toEqual([])
})

test('snooze presets are searchable, and the date form rechecks access at confirmation', () => {
  const { commands, openCustomSnooze, sidebar, row } = fixture()
  expect(commandsShown(commands(), 'snooze', false).shown.map((command) => command.label)).toEqual(['Snooze session…'])
  const tomorrow = commandsShown(commands(), 'snooze tomorrow', false).shown
  expect(tomorrow.map((command) => command.label)).toEqual(['Snooze: Tomorrow morning'])
  tomorrow[0]?.run?.()
  expect(sidebar.snoozeRow).toHaveBeenCalledWith(row.key, expect.any(Number), '')
  const custom = commandsShown(commands(), 'pick date', false).shown[0]
  custom?.run?.()
  const form = openCustomSnooze.mock.calls[0]?.[0]
  expect(form?.title).toBe(row.title)
  sidebar.snoozeRow.mockClear()
  sidebar.canShelve = () => false
  form?.confirm(Date.now() + 1000, 'reminder')
  expect(sidebar.snoozeRow).not.toHaveBeenCalled()
})
