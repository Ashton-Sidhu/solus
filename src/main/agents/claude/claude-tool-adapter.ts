import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { AgentTool, AgentToolContext } from '../tools/agent-tool'
import { assertUniqueAgentTools, executeAgentTool } from '../tools/agent-tool'
import { AgentToolCallBridge } from '../tools/agent-tool-call-bridge'

export function adaptClaudeTools(
  tools: AgentTool[],
  context: AgentToolContext,
  permissionMode: 'ask' | 'auto' | 'plan',
) {
  assertUniqueAgentTools(tools)
  const bridge = new AgentToolCallBridge()
  const server = createSdkMcpServer({
    name: 'solus',
    version: '1.0.0',
    tools: tools.map((agentTool) =>
      tool(agentTool.name, agentTool.description, agentTool.inputShape, async (input) => {
        const parentToolUseId = await bridge.claim(agentTool.name, input)
        const result = permissionMode === 'plan' && agentTool.requiresApproval
          ? {
              ok: false,
              text: `Cannot run ${agentTool.name} in plan mode. Exit plan mode to apply changes.`,
            }
          : await executeAgentTool(agentTool, input, {
              ...context,
              parentToolUseId: () => parentToolUseId,
            })
        return {
          content: [{ type: 'text' as const, text: result.text }],
          ...(result.ok ? {} : { isError: true as const }),
        }
      }),
    ),
  })
  const allowedTools = tools
    .filter((agentTool) => permissionMode === 'auto' || !agentTool.requiresApproval)
    .map((agentTool) => `mcp__solus__${agentTool.name}`)
  return { server, allowedTools, observe: (event: Parameters<AgentToolCallBridge['observe']>[0]) => bridge.observe(event) }
}
