import { z } from 'zod'
import type { AgentTool, AgentToolContext, AgentToolImage, AgentToolResult } from '../tools/agent-tool'
import { assertUniqueAgentTools, executeAgentTool, enabledAgentTools } from '../tools/agent-tool'
import type { CodexDynamicTool } from './codex-protocol'
import type { DynamicToolCallOutputContentItem } from './generated/v2/DynamicToolCallOutputContentItem'

export function bareAgentToolName(name: string): string {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
}

export function adaptCodexTools(tools: AgentTool[]): CodexDynamicTool[] {
  assertUniqueAgentTools(tools)
  tools = enabledAgentTools(tools)
  return tools.map((agentTool) => {
    // The input side: a field with a default may be left out. The output side
    // marks it required, which asks the model for a value it need not send.
    const generatedSchema = z.toJSONSchema(z.object(agentTool.inputFields), { io: 'input' })
    // SAFETY: Zod emits a JSON Schema object, which is the exact protocol value Codex accepts for a dynamic tool.
    const inputSchema = generatedSchema as CodexDynamicTool['inputSchema']
    return { name: agentTool.name, description: agentTool.description, inputSchema, deferLoading: !agentTool.alwaysLoad }
  })
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

  async execute(name: string, input: Parameters<typeof executeAgentTool>[1], parentToolUseId?: string): Promise<AgentToolResult> {
    const normalizedName = bareAgentToolName(name)
    const agentTool = this.tools.get(normalizedName)
    if (!agentTool) {
      return { ok: false, text: `Unsupported dynamic tool: ${normalizedName || '(unnamed)'}` }
    }
    try {
      return await executeAgentTool(agentTool, input, {
        ...this.context,
        parentToolUseId: () => parentToolUseId,
      })
    } catch (error) {
      // Codex waits for one response to every item/tool/call request. Convert a
      // thrown tool failure into that terminal response instead of leaving the
      // provider item and its conversation card running forever.
      return {
        ok: false,
        text: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

/** A neutral tool result as Codex dynamic-tool content: text, then any image as a data URL. */
export function codexToolContentItems(text: string, image?: AgentToolImage): DynamicToolCallOutputContentItem[] {
  return [
    { type: 'inputText', text },
    ...(image ? [{ type: 'inputImage' as const, imageUrl: `data:${image.mimeType};base64,${image.data}` }] : []),
  ]
}
