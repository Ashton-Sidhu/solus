import { z } from 'zod'
import type { AgentId, NormalizedEvent } from '@solus/contracts/types'

export interface AgentToolResult {
  ok: boolean
  text: string
}

export interface AgentToolContext {
  provider: AgentId
  cwd: string
  /** The provider's thread id — the currency of durable rows (session links,
   *  comment provenance, the session index). */
  sessionId: () => string | undefined
  /** Solus's own session id — the key the ControlPlane holds per-session state
   *  under, e.g. a dispatched session's foreign task snapshot. */
  solusSessionId: () => string | undefined
  abortSignal: AbortSignal
  parentToolUseId: () => string | undefined
  emit: (event: NormalizedEvent) => void
}

type ZodFieldMap = Parameters<typeof z.object>[0]

export interface AgentTool<TFields extends ZodFieldMap = ZodFieldMap> {
  name: string
  description: string
  inputFields: TFields
  requiresApproval: boolean
  execute(
    input: z.output<z.ZodObject<TFields>>,
    context: AgentToolContext,
  ): Promise<AgentToolResult>
}

export function assertUniqueAgentTools(tools: AgentTool[]): void {
  const names = new Set<string>()
  for (const agentTool of tools) {
    if (names.has(agentTool.name)) {
      throw new Error(`Duplicate agent tool name: ${agentTool.name}`)
    }
    names.add(agentTool.name)
  }
}

export async function executeAgentTool<Input>(
  agentTool: AgentTool,
  input: Input,
  context: AgentToolContext,
): Promise<AgentToolResult> {
  const parsed = z.object(agentTool.inputFields).safeParse(input)
  if (!parsed.success) {
    return { ok: false, text: `Invalid arguments for ${agentTool.name}: ${z.prettifyError(parsed.error)}` }
  }
  return agentTool.execute(parsed.data, context)
}
