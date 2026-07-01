import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from '../logger'
import { getTask, updateTask, formatTaskForAgent } from './task-service'
import type { TaskStatus } from '../../shared/task-types'

const log = createLogger('main', 'task-tools.ts')

/**
 * Agent-facing task tools for long-running sessions: re-fetch the bound ticket
 * (`get_task`) and move it (`update_task_status`). Like work-tools.ts and
 * automation-tools.ts, one set of zod shapes is exported in three shapes — Claude
 * SDK `tool()` objects, Codex JSON-schema descriptors, and a shared executor —
 * so both backends call identical logic. The provider is resolved per-cwd by
 * task-service, so these are bound to the calling session's working directory.
 * Tools return error TEXT (never throw) so a bad call degrades to a recoverable
 * message rather than killing the turn.
 */

const STATUS_VALUES = ['open', 'in_progress', 'done'] as const

// ─── Schemas ───

const getTaskShape = {
  task_id: z
    .string()
    .describe('Provider-native task id — the GitHub issue number, or the local task uuid. The bound task id is in the session\'s task context.'),
}

const updateStatusShape = {
  task_id: z.string().describe('The id of the task to move (the bound task, or one from its context).'),
  status: z
    .enum(STATUS_VALUES)
    .describe("New status: 'open', 'in_progress', or 'done'. On GitHub this maps to the in-progress label / closing the issue; locally it sets the stored status."),
}

// ─── Descriptions ───

const GET_DESC =
  "Re-fetch a task (ticket) by id, hydrated with its latest description, status, comments, and linked pull requests. Use this to refresh the ticket a long-running session is working on — the version injected at session start can go stale."
const UPDATE_DESC =
  "Move a task to a new status, writing it back to the provider: 'in_progress' marks it in progress (GitHub: adds the in-progress label), 'done' closes/completes it, 'open' reopens it. Narrow, intentional write-back — only status changes are pushed upstream."

// ─── Executor (shared by Claude SDK tools + Codex handler) ───

export interface TaskToolCtx {
  /** The calling session's working directory — selects the provider. */
  cwd: string
}

export interface TaskToolDeps {
  ctx: TaskToolCtx
}

export interface TaskToolResult {
  ok: boolean
  text: string
}

export async function executeTaskTool(
  name: string,
  args: Record<string, unknown>,
  deps: TaskToolDeps,
): Promise<TaskToolResult> {
  const cwd = deps.ctx.cwd
  try {
    if (name === 'get_task') {
      const id = String(args.task_id ?? '').trim()
      if (!id) return { ok: false, text: 'get_task requires a task_id.' }
      const task = await getTask(cwd, id)
      return {
        ok: true,
        text: formatTaskForAgent(task, {
          heading: `${task.kind === 'epic' ? 'Epic' : 'Task'} ${task.id} — "${task.title}"`,
          includeStatus: true,
          includeHierarchy: true,
        }),
      }
    }

    if (name === 'update_task_status') {
      const id = String(args.task_id ?? '').trim()
      if (!id) return { ok: false, text: 'update_task_status requires a task_id.' }
      const status = String(args.status ?? '')
      if (!(STATUS_VALUES as readonly string[]).includes(status)) {
        return { ok: false, text: `update_task_status: status must be one of ${STATUS_VALUES.join(', ')}.` }
      }
      const updated = await updateTask(cwd, id, { status: status as TaskStatus })
      return { ok: true, text: `Task ${updated.id} is now "${updated.status}".` }
    }

    return { ok: false, text: `Unknown task tool: ${name}` }
  } catch (err: any) {
    log.error(`executeTaskTool(${name}) failed: ${String(err)}`)
    return { ok: false, text: `Task tool error: ${String(err?.message ?? err)}` }
  }
}

// ─── Shape 1: Claude SDK tools (composed into the `solus` MCP server) ───

function toToolResult(r: TaskToolResult) {
  return {
    content: [{ type: 'text' as const, text: r.text }],
    ...(r.ok ? {} : { isError: true as const }),
  }
}

export interface TaskSdkDeps {
  cwd: string
}

export function taskSdkTools(deps: TaskSdkDeps) {
  const mk = (): TaskToolDeps => ({ ctx: { cwd: deps.cwd } })
  const run = (n: string) => async (args: unknown) =>
    toToolResult(await executeTaskTool(n, (args ?? {}) as Record<string, unknown>, mk()))
  return [
    tool('get_task', GET_DESC, getTaskShape, run('get_task')),
    tool('update_task_status', UPDATE_DESC, updateStatusShape, run('update_task_status')),
  ]
}

// ─── Shape 2: Codex dynamicTools JSON-schema descriptors ───

export interface TaskToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const TASK_TOOL_JSON_SCHEMAS: TaskToolDescriptor[] = [
  { name: 'get_task', description: GET_DESC, inputSchema: z.toJSONSchema(z.object(getTaskShape)) as Record<string, unknown> },
  { name: 'update_task_status', description: UPDATE_DESC, inputSchema: z.toJSONSchema(z.object(updateStatusShape)) as Record<string, unknown> },
]

export const TASK_TOOL_NAMES = new Set(TASK_TOOL_JSON_SCHEMAS.map((t) => t.name))

/** Only the write tool gates through permissions; get_task is read-only. */
export const TASK_MUTATING_TOOLS = new Set(['update_task_status'])
