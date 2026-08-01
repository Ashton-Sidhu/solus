import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { AgentTool, AgentToolContext } from '../tools/agent-tool'
import { assertUniqueAgentTools, executeAgentTool } from '../tools/agent-tool'

/** The CLI stamps every MCP tools/call request with the streamed tool-use id
 *  under this `_meta` key. Undocumented, so treat it as best-effort: absent id
 *  → subagent events render un-nested, nothing else degrades. */
const TOOL_USE_ID_META_KEY = 'claudecode/toolUseId'

export function claudeParentToolUseId(extra: unknown): string | undefined {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta
  const id = meta?.[TOOL_USE_ID_META_KEY]
  return typeof id === 'string' && id ? id : undefined
}

export function adaptClaudeTools(
  tools: AgentTool[],
  context: AgentToolContext,
  permissionMode: 'ask' | 'auto' | 'plan',
) {
  assertUniqueAgentTools(tools)
  const server = createSdkMcpServer({
    name: 'solus',
    version: '1.0.0',
    tools: tools.map((agentTool) =>
      tool(agentTool.name, agentTool.description, agentTool.inputShape, async (input, extra) => {
        const parentToolUseId = claudeParentToolUseId(extra)
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
  return { server, allowedTools }
}
