import { z } from 'zod'
import type { QuestionRequest } from '../types'

/**
 * MCP tasks (docs/plans/mcp-first-class.md §12): one tool call that a server
 * chose to run as a task of the extension `io.modelcontextprotocol/tasks`.
 * Never "task" alone: a task is a GitHub or Jira task. A client gets Solus's
 * id only; the server's task id stays on the host.
 */

export const MCP_TASK_STATUSES = ['working', 'input_required', 'completed', 'failed', 'cancelled'] as const
export type McpTaskStatus = (typeof MCP_TASK_STATUSES)[number]

/** Why the newest status request did not read the MCP task. The MCP task stays live. */
export type McpTaskProblem = 'unreachable' | 'needs-sign-in'

/** One question the server asks while the MCP task runs, as the question card shows it. */
export interface McpTaskInput {
  /** The server's key of the request; `mcpTaskAnswer` names it. */
  key: string
  request: QuestionRequest
}

export interface McpTask {
  id: string
  sessionId: string
  integrationName: string
  tool: string
  status: McpTaskStatus
  /** The server's text, or Solus's reason for an end. Plain text. */
  statusMessage?: string
  createdAt: number
  updatedAt: number
  /** Open questions while `status` is `input_required`. */
  input?: McpTaskInput[]
  /** The person asked to cancel; the server has not reported an end yet. */
  cancelling?: true
  problem?: McpTaskProblem
}

export function mcpTaskIsLive(task: Pick<McpTask, 'status'>): boolean {
  return task.status === 'working' || task.status === 'input_required'
}

export const mcpTaskListRequestSchema = z.object({ sessionId: z.string().min(1) })
export type McpTaskListRequest = z.infer<typeof mcpTaskListRequestSchema>

/** `sessionId` names the session that access is checked for; the host refuses an MCP task of another session. */
export const mcpTaskIdRequestSchema = z.object({ sessionId: z.string().min(1), id: z.string().min(1) })
export type McpTaskIdRequest = z.infer<typeof mcpTaskIdRequestSchema>

/** The answers of the question card, by question key, with `__action` for decline or cancel. */
export const mcpTaskAnswerRequestSchema = z.object({
  sessionId: z.string().min(1),
  id: z.string().min(1),
  key: z.string().min(1),
  answers: z.record(z.string(), z.string()),
})
export type McpTaskAnswerRequest = z.infer<typeof mcpTaskAnswerRequestSchema>

export interface McpTaskChangedEvent {
  sessionId: string
  task: McpTask
}

/**
 * The message that gives the agent an MCP task's end. A history row keeps no
 * origin, so a client knows the message by its first line (`mcpTaskWake`).
 * `label` is "<server> · <tool>".
 */
export function mcpTaskWakeHeader(outcome: 'completed' | 'failed', label: string): string {
  return `An MCP task ended (${outcome}): ${label}`
}

const WAKE_HEADER = /^An MCP task ended \((completed|failed)\): (.+)$/

export interface McpTaskWake {
  outcome: 'completed' | 'failed'
  label: string
  /** The rest of the message: the result or the reason. */
  body: string
}

/** The MCP task wake this prompt is, or null. Reads the first line before it commits. */
export function mcpTaskWake(text: string): McpTaskWake | null {
  const trimmed = text.trimStart()
  const lineEnd = trimmed.indexOf('\n')
  const header = WAKE_HEADER.exec(lineEnd === -1 ? trimmed : trimmed.slice(0, lineEnd))
  if (!header) return null
  // SAFETY: the pattern's first group matches only the two outcomes.
  const outcome = header[1] as McpTaskWake['outcome']
  return { outcome, label: header[2]!, body: lineEnd === -1 ? '' : trimmed.slice(lineEnd + 1).trim() }
}
