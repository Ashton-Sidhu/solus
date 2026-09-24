import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { AgentTool, AgentToolContext } from '../tools/agent-tool'
import { assertUniqueAgentTools, executeAgentTool, enabledAgentTools } from '../tools/agent-tool'
import { z } from 'zod'

/** The CLI stamps every MCP tools/call request with the streamed tool-use id
 *  under this `_meta` key. Undocumented, so treat it as best-effort: absent id
 *  → subagent events render un-nested, nothing else degrades. */
const TOOL_USE_ID_META_KEY = 'claudecode/toolUseId'
const claudeToolExtraSchema = z.object({
  _meta: z.object({ 'claudecode/toolUseId': z.string().optional() }).optional(),
})

interface ClaudeToolResponse {
  content: Array<{ type: 'text'; text: string }>
  isError?: true
}

export function claudeParentToolUseId(extra: z.input<typeof claudeToolExtraSchema>): string | undefined {
  const parsed = claudeToolExtraSchema.safeParse(extra)
  const id = parsed.success ? parsed.data._meta?.[TOOL_USE_ID_META_KEY] : undefined
  return id || undefined
}

/**
 * The fields as the caller may send them. The SDK validates a call before we
 * see it and refuses a field with a default when the call leaves it out, so
 * such a field is offered as optional here; `executeAgentTool` parses the call
 * again against the tool's own fields, which fills the default in.
 */
export function callerFields(fields: AgentTool['inputFields']): AgentTool['inputFields'] {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([name, field]) => [name, field instanceof z.ZodDefault ? field.optional() : field]))
}

export function adaptClaudeTools(
  tools: AgentTool[],
  context: AgentToolContext,
  permissionMode: 'ask' | 'auto' | 'plan',
) {
  assertUniqueAgentTools(tools)
  tools = enabledAgentTools(tools)
  const server = createSdkMcpServer({
    name: 'solus',
    version: '1.0.0',
    tools: tools.map((agentTool) =>
      tool(agentTool.name, agentTool.description, callerFields(agentTool.inputFields), async (input, extra) => {
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
        const response: ClaudeToolResponse = {
          content: [{ type: 'text' as const, text: result.text }],
        }
        if (!result.ok) response.isError = true
        return response
      }, agentTool.alwaysLoad ? { alwaysLoad: true } : undefined),
    ),
  })
  const allowedTools = tools
    .filter((agentTool) => permissionMode === 'auto' || !agentTool.requiresApproval)
    .map((agentTool) => `mcp__solus__${agentTool.name}`)
  return { server, allowedTools }
}
