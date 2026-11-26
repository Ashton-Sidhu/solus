import { z } from 'zod'
import type { AgentTool } from '../tools/agent-tool'
import type { RunToolAccess } from '../tools/agent-tool-endpoint'

/**
 * Solus tools reach Codex as MCP servers on the host's endpoint (plans/035 §9).
 * A tool that must always load is on a second server Codex never defers, as
 * T3 Code does; its calls arrive as `solus-direct.<tool>`.
 */
export const SOLUS_MCP_SERVER = 'solus'
export const SOLUS_DIRECT_MCP_SERVER = 'solus-direct'
const SOLUS_MCP_SERVERS: ReadonlySet<string> = new Set([SOLUS_MCP_SERVER, SOLUS_DIRECT_MCP_SERVER])

export function isSolusMcpServer(name: string | undefined): boolean {
  return !!name && SOLUS_MCP_SERVERS.has(name)
}

/** A Solus tool call may wait an hour (request_secret); the limit stays above that. */
const SOLUS_TOOL_TIMEOUT_SEC = 65 * 60

/** The thread config that points Codex at the run's tools. */
export function codexSolusServers(access: RunToolAccess, tools: AgentTool[]) {
  // The endpoint asks the person before a Solus tool that needs approval (plans/035 §6). Codex must not
  // ask again, and under the `never` policy (full access, plan) it refuses an MCP call it would ask about.
  const server = { url: access.url, http_headers: { Authorization: access.authorization }, tool_timeout_sec: SOLUS_TOOL_TIMEOUT_SEC, default_tools_approval_mode: 'approve' }
  const direct = tools.filter((tool) => tool.alwaysLoad).map((tool) => tool.name)
  if (direct.length === 0) return { [`mcp_servers.${SOLUS_MCP_SERVER}`]: server }
  return {
    [`mcp_servers.${SOLUS_MCP_SERVER}`]: { ...server, disabled_tools: direct },
    [`mcp_servers.${SOLUS_DIRECT_MCP_SERVER}`]: { ...server, enabled_tools: direct, omit_tools_from: ['deferred'] },
  }
}

/** An `item/started` notification's item, when it is a call to a Solus MCP tool. */
const startedSolusCallSchema = z.object({
  item: z.object({
    type: z.literal('mcpToolCall'),
    id: z.string(),
    server: z.string().refine(isSolusMcpServer),
    tool: z.string(),
    arguments: z.json().optional(),
  }),
})

interface StartedCall {
  itemId: string
  tool: string
  argumentsJson: string
}

/** How long a call waits for its item: Codex reports the item and calls the server at nearly the same time. */
const ITEM_WAIT_MS = 2000

/**
 * The `mcpToolCall` items Codex started for Solus tools, waiting for their
 * calls to reach the endpoint. A call names no item, so it takes the oldest
 * started item of its tool with the same arguments, or else of its tool.
 */
export class SolusCallItems {
  private started: StartedCall[] = []
  private waiters: Array<() => void> = []

  /** Notes an `item/started` notification's item when it is a Solus tool call. */
  noteStarted(notification: z.input<typeof startedSolusCallSchema>): void {
    const started = startedSolusCallSchema.safeParse(notification)
    if (!started.success) return
    const { id, tool, arguments: args } = started.data.item
    this.started.push({ itemId: id, tool, argumentsJson: JSON.stringify(args ?? {}) })
    for (const wake of this.waiters.splice(0)) wake()
  }

  async claim(tool: string, argumentsJson: string): Promise<string | undefined> {
    const deadline = Date.now() + ITEM_WAIT_MS
    for (;;) {
      const itemId = this.take(tool, argumentsJson)
      if (itemId || Date.now() >= deadline) return itemId
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deadline - Date.now())
        this.waiters.push(() => { clearTimeout(timer); resolve() })
      })
    }
  }

  private take(tool: string, argumentsJson: string): string | undefined {
    const index = this.started.findIndex((call) => call.tool === tool && call.argumentsJson === argumentsJson)
    const chosen = index >= 0 ? index : this.started.findIndex((call) => call.tool === tool)
    if (chosen < 0) return undefined
    return this.started.splice(chosen, 1)[0]!.itemId
  }
}
