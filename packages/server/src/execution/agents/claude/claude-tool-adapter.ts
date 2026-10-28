import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { AgentTool, AgentToolContext, AgentToolResult } from '../tools/agent-tool'
import { advertisedInputSchema, assertUniqueAgentTools, executeAgentTool, enabledAgentTools } from '../tools/agent-tool'
import { z } from 'zod'
import type { PermissionMode } from '@solus/contracts/types'

/** The CLI stamps every MCP tools/call request with the streamed tool-use id
 *  under this `_meta` key. Undocumented, so treat it as best-effort: absent id
 *  → subagent events render un-nested, nothing else degrades. */
const TOOL_USE_ID_META_KEY = 'claudecode/toolUseId'
const claudeToolExtraSchema = z.object({
  _meta: z.object({ 'claudecode/toolUseId': z.string().optional() }).optional(),
})

interface ClaudeToolResponse {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: true
}

export function claudeParentToolUseId(extra: z.input<typeof claudeToolExtraSchema>): string | undefined {
  const parsed = claudeToolExtraSchema.safeParse(extra)
  const id = parsed.success ? parsed.data._meta?.[TOOL_USE_ID_META_KEY] : undefined
  return id || undefined
}

/**
 * The fields as the caller may send them. The SDK validates a call with its
 * own bundled zod before we see it, and that copy refuses a left-out field
 * whose schema holds a default anywhere, even inside `.optional()`. So such a
 * field is offered as its plain inner type, optional; `executeAgentTool`
 * parses the call again against the tool's own fields, which fills the
 * default in.
 */
function callerFields(fields: AgentTool['inputFields']): AgentTool['inputFields'] {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([name, field]) => {
    if (!(field instanceof z.ZodDefault)) return [name, field]
    const optional = z.optional(field.unwrap())
    return [name, field.description ? optional.describe(field.description) : optional]
  }))
}

/** A neutral tool result as an MCP response: text first, then any image. */
export function claudeToolResponse(result: AgentToolResult): ClaudeToolResponse {
  const response: ClaudeToolResponse = {
    content: [{ type: 'text' as const, text: result.text }],
  }
  if (result.image) response.content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType })
  if (!result.ok) response.isError = true
  return response
}

export function adaptClaudeTools(
  tools: AgentTool[],
  context: AgentToolContext,
  permissionMode: PermissionMode,
) {
  assertUniqueAgentTools(tools)
  tools = enabledAgentTools(tools)
  const server = createSdkMcpServer({
    name: 'solus',
    version: '1.0.0',
    tools: tools.map((agentTool) => {
      const handler = async (input: Parameters<typeof executeAgentTool>[1], extra: Parameters<typeof claudeParentToolUseId>[0]) => {
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
        return claudeToolResponse(result)
      }
      // The SDK checks a call against this schema and lists its JSON for the
      // model. A passthrough tool takes any object: the SDK strips the keys a
      // field map does not name but runs a Zod object as it is, so a loose one
      // keeps them. The model reads the compact schema; the check stays full.
      const callSchema = agentTool.passthroughInput ? z.looseObject({}) : z.object(callerFields(agentTool.inputFields))
      // The SDK's zod writes `$schema` first and then this schema's own keys,
      // so an undefined `$schema` keeps it out of the JSON the model reads.
      callSchema._zod.toJSONSchema = () => ({ ...advertisedInputSchema(agentTool), $schema: undefined })
      const definition = tool(agentTool.name, agentTool.description, {}, handler, agentTool.alwaysLoad ? { alwaysLoad: true } : undefined)
      definition.inputSchema = callSchema
      return definition
    }),
  })
  // A tool that requires approval is left to the session's permission mode.
  const allowedTools = tools
    .filter((agentTool) => !agentTool.requiresApproval)
    .map((agentTool) => `mcp__solus__${agentTool.name}`)
  return { server, allowedTools }
}
