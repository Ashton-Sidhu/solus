import { z } from 'zod'
import type { AgentId, NormalizedEvent } from '../../../shared/types'

export interface AgentToolResult {
  ok: boolean
  text: string
}

export interface AgentToolContext {
  provider: AgentId
  cwd: string
  sessionId: () => string | undefined
  abortSignal: AbortSignal
  parentToolUseId: () => string | undefined
  emit: (event: NormalizedEvent) => void
}

export interface AgentTool<TShape extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  inputShape: TShape
  requiresApproval: boolean
  execute(
    input: z.output<z.ZodObject<TShape>>,
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

export async function executeAgentTool(
  agentTool: AgentTool,
  input: unknown,
  context: AgentToolContext,
): Promise<AgentToolResult> {
  const parsed = z.object(agentTool.inputShape).safeParse(input)
  if (!parsed.success) {
    return { ok: false, text: `Invalid arguments for ${agentTool.name}: ${z.prettifyError(parsed.error)}` }
  }
  return agentTool.execute(parsed.data, context)
}
