import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { ToolSchema } from '@modelcontextprotocol/core'
// The low-level server: `McpServer` types schemas against the SDK's own zod copy,
// and these tools use the workspace's zod 4, so the tools publish JSON Schema.
import { Server, type CallToolRequest, type CallToolResult, type Tool } from '@modelcontextprotocol/server'
import type { PermissionMode } from '@solus/contracts/types'
import type { AgentTool, AgentToolContext, AgentToolResult } from './agent-tool'
import { advertisedInputSchema, assertUniqueAgentTools, enabledAgentTools, executeAgentTool } from './agent-tool'

/**
 * The tools of one run, served over the host's MCP endpoint (plans/035 §3-§4).
 * Every harness reaches its run's tools at the same URL with the run's token,
 * so a harness needs no tool adapter of its own.
 */
export interface RunToolBinding {
  /** The run's tools, already checked against the turn's person (`credentialScopedAgentTools`). */
  tools: AgentTool[]
  /** The run's context. Each call gets its own call id and stop signal. */
  context: Omit<AgentToolContext, 'parentToolUseId'>
  permissionMode: () => PermissionMode
  /** Asks the person before a tool that needs approval runs. Resolves to whether they allowed it. */
  approve(tool: AgentTool, input: ToolArguments, toolUseId: string | undefined): Promise<boolean>
}

/** A tool call's arguments as MCP carries them, before the tool's fields parse them. */
type ToolArguments = CallToolRequest['params']['arguments']

/** What a harness needs to reach its run's tools. */
export interface RunToolAccess {
  url: string
  /** The `Authorization` header value. */
  authorization: string
  /** Ends the token: a later request with it is refused. */
  release(): void
}

const bindings = new Map<string, RunToolBinding>()
let endpointUrl: string | null = null

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The address a harness on this host uses. Boot sets it when the HTTP server listens, and again when it moves. */
export function setAgentToolEndpointUrl(url: string): void {
  endpointUrl = url
}

/**
 * Gives a run a token for its tools. The host keeps only the token's hash, in
 * memory: a restart ends every token, and restart recovery starts the run
 * again with a new one.
 */
export function bindRunTools(binding: RunToolBinding): RunToolAccess {
  if (!endpointUrl) throw new Error('The host has no MCP endpoint yet.')
  assertUniqueAgentTools(binding.tools)
  const token = randomBytes(32).toString('base64url')
  const hash = tokenHash(token)
  bindings.set(hash, binding)
  return { url: endpointUrl, authorization: `Bearer ${token}`, release: () => { bindings.delete(hash) } }
}

/** The run a token belongs to, while its run lasts. */
export function runToolBindingFor(token: string): RunToolBinding | undefined {
  return bindings.get(tokenHash(token))
}

/** The Claude CLI names the tool-use block a call belongs to under this `_meta` key. */
const TOOL_USE_ID_META_KEY = 'claudecode/toolUseId'
const callMetaSchema = z.object({ [TOOL_USE_ID_META_KEY]: z.string().min(1).optional() })

/** The id of the provider's tool-use block, when the harness names it. */
export function callToolUseId(meta: CallToolRequest['params']['_meta']): string | undefined {
  const parsed = callMetaSchema.safeParse(meta)
  return parsed.success ? parsed.data[TOOL_USE_ID_META_KEY] : undefined
}

const structuredResult = z.record(z.string(), z.json())

/** A tool result as MCP content: text first, then every image in order. */
export function mcpToolResult(result: AgentToolResult): CallToolResult {
  const response: CallToolResult = { content: [{ type: 'text', text: result.text }] }
  for (const image of result.images ?? []) response.content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  if (!result.ok) response.isError = true
  if (result.ok && result.format === 'json') {
    const structured = structuredResult.safeParse(JSON.parse(result.text))
    if (structured.success) response.structuredContent = structured.data
  }
  return response
}

/** One tool as `tools/list` gives it. A tool with guidance the agent needs first is never deferred. */
function listedTool(agentTool: AgentTool): Tool {
  const listed = {
    name: agentTool.name,
    description: agentTool.description,
    inputSchema: { ...advertisedInputSchema(agentTool), type: 'object' as const },
  }
  return ToolSchema.parse(agentTool.alwaysLoad ? { ...listed, _meta: { 'anthropic/alwaysLoad': true } } : listed)
}

function refused(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

/**
 * The MCP server for one request of a run: its tools, called with its
 * context. A run that ended after its token was checked has none.
 */
export function runToolServer(binding: RunToolBinding | undefined): Server {
  const server = new Server({ name: 'solus', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => ({ tools: binding ? enabledAgentTools(binding.tools).map(listedTool) : [] }))
  server.setRequestHandler('tools/call', async (request, extra): Promise<CallToolResult> => {
    if (!binding) return refused('This run has ended.')
    const agentTool = binding.tools.find((candidate) => candidate.name === request.params.name)
    if (!agentTool) return refused(`Unknown tool: ${request.params.name}`)
    const toolUseId = callToolUseId(request.params._meta)
    const input = request.params.arguments
    if (agentTool.requiresApproval) {
      if (binding.permissionMode() === 'plan') return refused(`Cannot run ${agentTool.name} in plan mode. Exit plan mode to apply changes.`)
      if (!await binding.approve(agentTool, input, toolUseId)) return refused(`The user declined ${agentTool.name}.`)
    }
    try {
      return mcpToolResult(await executeAgentTool(agentTool, input ?? {}, {
        ...binding.context,
        abortSignal: AbortSignal.any([binding.context.abortSignal, extra.mcpReq.signal]),
        parentToolUseId: () => toolUseId,
      }))
    } catch (error) {
      // The harness waits for one result for every call; a thrown tool still answers.
      return refused(error instanceof Error ? error.message : String(error))
    }
  })
  return server
}
