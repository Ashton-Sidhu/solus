import type { Task } from '@solus/contracts/task-types'
import type { SessionMeta } from '@solus/contracts/types'
import type { SidebarSessionChild } from '../../../../contexts/workspace/session-sidebar.store.svelte'
import type { PickerEntry } from './picker-rows'

/** The menu of a row's own actions: a task's, or a session's. A record has
 *  none: its preview's action bar holds what can be done to it. */
export type PickerRowMenu =
  | { kind: 'task'; task: Task; x: number; y: number }
  | {
      kind: 'session'
      session: Pick<SidebarSessionChild, 'tabId' | 'sessionId' | 'serverId' | 'attention'>
      /** The record of a conversation the hosts listed, which the menu archives
       *  or returns. Null for a session of a task. */
      conversation: SessionMeta | null
      x: number
      y: number
    }

/** Whether a row has a menu of its own actions. */
export function hasRowMenu(entry: PickerEntry | null): boolean {
  if (!entry || entry.kind === 'record') return false
  return entry.kind !== 'conversation' || !!entry.meta.serverId
}

/** The menu for a row, opened at a point. Null for a row with no menu. */
export function rowMenuFor(entry: PickerEntry, x: number, y: number): PickerRowMenu | null {
  if (!hasRowMenu(entry)) return null
  if (entry.kind === 'task') return { kind: 'task', task: entry.task, x, y }
  if (entry.kind === 'session') return { kind: 'session', session: entry.session, conversation: null, x, y }
  if (entry.kind !== 'conversation' || !entry.meta.serverId) return null
  return {
    kind: 'session',
    session: { sessionId: entry.meta.sessionId, serverId: entry.meta.serverId, attention: null },
    conversation: entry.meta,
    x,
    y,
  }
}
