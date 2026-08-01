import { z } from 'zod'
import type { AgentTool, AgentToolContext, AgentToolResult } from '../tools/agent-tool'
import { assertUniqueAgentTools, executeAgentTool } from '../tools/agent-tool'
import type { CodexDynamicTool } from './codex-protocol'

export function bareAgentToolName(name: string): string {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
}

export function adaptCodexTools(tools: AgentTool[]): CodexDynamicTool[] {
  assertUniqueAgentTools(tools)
  return tools.map((agentTool) => ({
    name: agentTool.name,
    description: agentTool.description,
    inputSchema: z.toJSONSchema(z.object(agentTool.inputShape)) as unknown as CodexDynamicTool['inputSchema'],
  }))
}

export class CodexToolDispatcher {
  private readonly tools: Map<string, AgentTool>

  constructor(tools: AgentTool[], private readonly context: AgentToolContext) {
    assertUniqueAgentTools(tools)
    this.tools = new Map(tools.map((agentTool) => [agentTool.name, agentTool]))
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(bareAgentToolName(name))
  }

  async execute(name: string, input: unknown, parentToolUseId?: string): Promise<AgentToolResult> {
    const normalizedName = bareAgentToolName(name)
    const agentTool = this.tools.get(normalizedName)
    if (!agentTool) {
      return { ok: false, text: `Unsupported dynamic tool: ${normalizedName || '(unnamed)'}` }
    }
    return executeAgentTool(agentTool, input, {
      ...this.context,
      parentToolUseId: () => parentToolUseId,
    })
  }
}
