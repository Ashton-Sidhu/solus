import { z } from 'zod'
import { Client, ProtocolError, type ElicitResult, type JSONRPCResponse } from '@modelcontextprotocol/client'
import { MCP_TASK_STATUSES } from '@solus/contracts/integrations/mcp-task'
import type { Integration } from '@solus/contracts/integration-types'
import type { AgentToolContext, AgentToolResult } from '../execution/agents/tools/agent-tool'
import type { UpstreamAddress } from './upstream-session'

/**
 * The client side of the extension `io.modelcontextprotocol/tasks`
 * (docs/plans/mcp-first-class.md §12; the extension's 2026-07-28 text in
 * github.com/modelcontextprotocol/ext-tasks). Version 2.4.0 of the SDK has
 * no tasks client: it refuses a `tools/call` result with `resultType: "task"`
 * (`UNSUPPORTED_RESULT_TYPE`, without the handle) and offers no typed
 * `tasks/*` method. It does send `tasks/get` and `tasks/cancel` through
 * `request()` with an explicit schema, `tasks/update` as an extension
 * method, and the `Mcp-Name` header for all three. This module adds the rest.
 */

export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'

/** A code no MCP error uses: it carries a task handle past the SDK's result check. */
const TASK_HANDLE_CODE = -7_280_728

const taskSchema = z.object({
  taskId: z.string().min(1).max(1024),
  status: z.enum(MCP_TASK_STATUSES),
  statusMessage: z.string().optional(),
  ttlMs: z.number().nullable().optional(),
  pollIntervalMs: z.number().optional(),
})

/** The handle a server gives in place of a tool result. */
export type McpTaskHandle = z.infer<typeof taskSchema>

/** What the MCP task owner (`mcp-tasks.ts`) does for the gateway (docs/plans/mcp-first-class.md §12). */
export interface McpTaskCalls {
  /** A tool call that the server answered with a task handle: hold it, then give it to the background (§12.1). */
  hold(call: HeldMcpTask): Promise<AgentToolResult>
  /** An upstream session with a live MCP task is not closed when idle (§12.3). */
  holdsUpstream(address: UpstreamAddress): boolean
  /** A `stdio` process ended: its MCP tasks fail (§12.3). */
  processEnded(integrationId: string, personKey: string | null): void
}

export interface HeldMcpTask {
  integration: Integration
  tool: string
  accountId: string
  personKey: string | null
  handle: McpTaskHandle
  context: AgentToolContext
  traceparent: string | null
}

/** A status request found no running process of a `stdio` integration: its MCP tasks are gone with it. */
export class ServerStoppedError extends Error {}

/** One question the server asks in `input_required`; only an elicitation is shown (§0). */
const inputRequestSchema = z.object({ method: z.string(), params: z.unknown().optional() })

const getTaskResultSchema = taskSchema.extend({
  inputRequests: z.record(z.string(), inputRequestSchema).optional(),
  /** The tool result, when `completed`. */
  result: z.unknown().optional(),
  /** The JSON-RPC error, when `failed`. */
  error: z.object({ code: z.number(), message: z.string() }).optional(),
})
export type McpTaskState = z.infer<typeof getTaskResultSchema>

const emptyResultSchema = z.looseObject({})

/**
 * The gateway's MCP client. A `tools/call` that the server runs as an MCP task
 * rejects with a `ProtocolError` that `taskHandleOf` reads, so the call path
 * can hold it. Any other request that gets a task handle fails with a plain
 * message: the extension allows a task for `tools/call` only.
 * `connectionEnded` resolves when the connection ends by any path, so a
 * resource watch on a legacy server, which has no stream of its own, hears it
 * (docs/plans/mcp-first-class.md §11.5).
 */
export class TaskAwareClient extends Client {
  private endConnection: () => void = () => undefined
  readonly connectionEnded = new Promise<void>((resolve) => { this.endConnection = resolve })

  protected override _onclose(): void {
    super._onclose()
    this.endConnection()
  }

  protected override _onresponse(response: JSONRPCResponse): void {
    if ('result' in response && response.result.resultType === 'task') {
      super._onresponse({
        jsonrpc: '2.0',
        id: response.id,
        error: { code: TASK_HANDLE_CODE, message: 'The server answered with an MCP task, which Solus takes only for a tool call.', data: response.result },
      })
      return
    }
    super._onresponse(response)
  }
}

/** The task handle a call was answered with, or null for any other failure. */
export function taskHandleOf(error: unknown): McpTaskHandle | null {
  if (!(error instanceof ProtocolError) || error.code !== TASK_HANDLE_CODE) return null
  const parsed = taskSchema.safeParse(error.data)
  return parsed.success ? parsed.data : null
}

/** The server no longer knows the task: it expired or was deleted (`-32602`). */
export function isUnknownTask(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === -32602
}

/** The server's side of one MCP task, on one client: its status, the answers to its questions, and its cancel. */
export class ServerTask {
  constructor(
    private readonly client: Client,
    private readonly taskId: string,
    private readonly options: { traceparent: string | null; timeout: number },
  ) {}

  status(): Promise<McpTaskState> {
    return this.client.request({ method: 'tasks/get', params: this.params() }, getTaskResultSchema, { timeout: this.options.timeout })
  }

  /** Answers questions of an `input_required` MCP task. The server reads the answers later. */
  async answer(inputResponses: Record<string, ElicitResult>): Promise<void> {
    await this.client.request({ method: 'tasks/update', params: { ...this.params(), inputResponses } }, emptyResultSchema, { timeout: this.options.timeout })
  }

  /** Cooperative: the server acknowledges, and may still end the task in another state. */
  async cancel(): Promise<void> {
    await this.client.request({ method: 'tasks/cancel', params: this.params() }, emptyResultSchema, { timeout: this.options.timeout })
  }

  /** A task request carries the call's `traceparent` (§13); never `tracestate` or `baggage`. */
  private params(): { taskId: string; _meta?: { traceparent: string } } {
    const { traceparent } = this.options
    return traceparent ? { taskId: this.taskId, _meta: { traceparent } } : { taskId: this.taskId }
  }
}
