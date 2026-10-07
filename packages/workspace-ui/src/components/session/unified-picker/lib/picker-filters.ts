import type { Task } from '@solus/contracts/task-types'
import type { AgentId } from '@solus/contracts/types'
import { isDone } from '../../../tasks/lib/tasks-list-view'

/**
 * The picker's filters (docs/plans/unified-search.md): how recently a row was
 * active, a task's status, and a session's agent and host. Updated narrows
 * both kinds; Task status narrows tasks only; Agent and Host narrow sessions
 * only.
 */
export type PickerUpdatedFilter = 'any' | 'day' | 'week' | 'month'
export type PickerStatusFilter = 'any' | 'open' | 'done'
export type PickerAgentFilter = 'any' | Extract<AgentId, 'claude-code' | 'codex'>
/** The server id of the machine a session ran on, or 'any'. */
export type PickerHostFilter = 'any' | (string & {})

export interface PickerFilters {
  updated: PickerUpdatedFilter
  status: PickerStatusFilter
  agent: PickerAgentFilter
  host: PickerHostFilter
}

export const NO_PICKER_FILTERS: PickerFilters = { updated: 'any', status: 'any', agent: 'any', host: 'any' }

export const PICKER_UPDATED_LABELS = {
  any: 'Any time',
  day: 'Past 24 hours',
  week: 'Past 7 days',
  month: 'Past 30 days',
} satisfies Record<PickerUpdatedFilter, string>

export const PICKER_STATUS_LABELS = {
  any: 'Any status',
  open: 'Open',
  done: 'Done',
} satisfies Record<PickerStatusFilter, string>

export const PICKER_AGENT_LABELS = {
  any: 'Any agent',
  'claude-code': 'Claude',
  codex: 'Codex',
} satisfies Record<PickerAgentFilter, string>

const DAY_MS = 86_400_000
const UPDATED_WINDOW_MS = { day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS } satisfies Record<Exclude<PickerUpdatedFilter, 'any'>, number>

/** The instant a row must be active at or after, or undefined for any time. */
export function activeSince(filters: PickerFilters, now: number): number | undefined {
  return filters.updated === 'any' ? undefined : now - UPDATED_WINDOW_MS[filters.updated]
}

/** How many filters narrow the list, for the chip that opens them. */
export function activeFilterCount(filters: PickerFilters): number {
  return (filters.updated !== 'any' ? 1 : 0) + (filters.status !== 'any' ? 1 : 0) + (filters.agent !== 'any' ? 1 : 0)
    + (filters.host !== 'any' ? 1 : 0)
}

/** Whether the filters keep a task: its last update, and its status. */
export function keepsTask(task: Task, filters: PickerFilters, since: number | undefined): boolean {
  if (since !== undefined && task.updatedAt < since) return false
  return filters.status === 'any' || (filters.status === 'done') === isDone(task)
}

/** Whether the filters keep a session: its last activity, its agent, and its
 *  host. A session whose agent is not known yet is kept. */
export function keepsSession(
  session: { provider?: AgentId | null; serverId?: string | null },
  lastActivityAt: number,
  filters: PickerFilters,
  since: number | undefined,
): boolean {
  if (since !== undefined && lastActivityAt < since) return false
  if (!keepsHost(session.serverId, filters)) return false
  return filters.agent === 'any' || !session.provider || session.provider === filters.agent
}

/** Whether the Host filter keeps a session that ran on `serverId`. */
export function keepsHost(serverId: string | null | undefined, filters: PickerFilters): boolean {
  return filters.host === 'any' || serverId === filters.host
}
