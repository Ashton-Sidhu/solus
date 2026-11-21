import { mcpTaskIsLive, type McpTask } from '@solus/contracts/integrations/mcp-task'
import type { BackgroundItem, BackgroundItemAction, BackgroundKind } from './background-item'

// An MCP task as a background work row (docs/plans/mcp-first-class.md §12.5).

export const MCP_TASK_CANCEL: BackgroundItemAction = { id: 'cancel', label: 'Cancel', busyLabel: 'Cancelling…', stops: true }
export const MCP_TASK_ANSWER: BackgroundItemAction = { id: 'answer', label: 'Answer', busyLabel: 'Answer' }

export const MCP_TASKS: BackgroundKind<McpTask> = { item: mcpTaskItem, isLive: mcpTaskIsLive }

export function mcpTaskItem(task: McpTask): BackgroundItem {
  const live = mcpTaskIsLive(task)
  return {
    key: `mcp-task:${task.id}`,
    label: `${task.integrationName} · ${task.tool}`,
    detail: mcpTaskDetail(task),
    state: mcpTaskState(task),
    startedAt: live ? task.createdAt : null,
    actions: !live || task.cancelling ? [] : task.input?.length ? [MCP_TASK_ANSWER, MCP_TASK_CANCEL] : [MCP_TASK_CANCEL],
    stopLabel: `Stop ${task.tool}`,
  }
}

function mcpTaskState(task: McpTask): BackgroundItem['state'] {
  if (task.status === 'failed') return 'failed'
  if (task.status === 'completed') return 'ended'
  if (task.status === 'cancelled') return 'stopped'
  if (task.input?.length || task.problem) return 'attention'
  return 'running'
}

function mcpTaskDetail(task: McpTask): string {
  if (task.cancelling) return 'Cancelling…'
  switch (task.status) {
    case 'completed': return task.statusMessage ?? 'Completed'
    case 'failed': return task.statusMessage ?? 'Failed'
    case 'cancelled': return 'Cancelled'
    default:
      if (task.problem === 'needs-sign-in') return `Sign in to ${task.integrationName} again`
      if (task.problem === 'unreachable') return `Could not reach ${task.integrationName}`
      if (task.input?.length) return 'Needs your input'
      return task.statusMessage ?? 'Running in the background'
  }
}
