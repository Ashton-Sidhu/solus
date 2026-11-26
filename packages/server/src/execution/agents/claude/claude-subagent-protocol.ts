import type { SessionLoadMessage } from '@solus/contracts/session-history'

export interface ClaudeToolResultTextBlock {
  text?: string
}

export type ClaudeToolResultContent = string | readonly ClaudeToolResultTextBlock[] | undefined

export function claudeToolResultText(content: ClaudeToolResultContent): string {
  if (!content) return ''
  if (!Array.isArray(content)) return content
  // An image block has no text; its picture goes to the asset store instead.
  return content
    .flatMap((block) => block.text === undefined ? [] : [block.text])
    .join('\n')
}

export function parseClaudeTaskNotification(
  content: string,
): { toolUseId: string; taskId?: string; result: string } | null {
  if (!content.includes('<task-notification>')) return null
  const toolUseId = content.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim()
  const result = content.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim()
  const taskId = content.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim()
  return toolUseId && result ? { toolUseId, result, ...(taskId && { taskId }) } : null
}

/** Claude keeps the task id when it resumes a child under a new tool call. */
export function routeClaudeTaskReplies(rows: SessionLoadMessage[]): SessionLoadMessage[] {
  const launches = new Set<string>()
  const owners = new Map<string, string>()
  const calls = new Map<string, string>()
  for (const row of rows) {
    if (row.role === 'tool' && row.toolId && (row.isSubagent || row.toolName === 'Agent' || row.toolName === 'Task')) launches.add(row.toolId)
    const call = row.parentToolUseId ?? row.toolResultForId
    if (!row.providerTaskId || !call) continue
    if (launches.has(call)) owners.set(row.providerTaskId, call)
    calls.set(call, row.providerTaskId)
  }
  if (!owners.size) return rows
  for (const row of rows) {
    if (!row.parentToolUseId) continue
    const task = calls.get(row.parentToolUseId)
    const owner = task && owners.get(task)
    if (owner) row.parentToolUseId = owner
  }
  return rows
}
