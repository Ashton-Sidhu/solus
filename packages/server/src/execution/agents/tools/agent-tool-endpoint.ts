import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { ToolSchema } from '@modelcontextprotocol/core'
// The low-level server: `McpServer` types schemas against the SDK's own zod copy,
// and these tools use the workspace's zod 4, so the tools publish JSON Schema.
import { Server, type CallToolRequest, type CallToolResult, type Tool } from '@modelcontextprotocol/server'
import type { PermissionMode } from '@solus/contracts/types'
import type { AppAccess } from '@solus/contracts/host-api'
import type { Actor } from '../../../admission/actor'
import { withWorkspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { resolveHomePath } from '../../../platform/paths'
import { withActorScope } from '../../seats/acting-identity'
import type { AgentTool, AgentToolContext, AgentToolResult } from './agent-tool'
import type { AppOperationTool } from './app-tools'
import { appOperationRefusal, appToolHints, appToolRefusal, toolAccessRefusal } from './tool-access'
import { clientRequesterKey } from '../../orchestration/exchange'
import { advertisedInputSchema, assertUniqueAgentTools, enabledAgentTools, executeAgentTool } from './agent-tool'
import { listedProxyTools, parseToolCallProxy, parseToolSearchQuery, proxyTools, searchDeferredTools, TOOL_CALL, TOOL_SEARCH } from './deferred-tool-proxy'

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
  /** The id of the provider's item for a call whose request names none (Codex: its `mcpToolCall` item). */
  toolUseIdOf?(toolName: string, input: ToolArguments): Promise<string | undefined>
  /** List only `alwaysLoad` tools plus `tool_search` and `tool_call`, for harnesses that freeze tools per session. */
  deferProxy?: boolean
}

/** A tool call's arguments as MCP carries them, before the tool's fields parse them. */
export type ToolArguments = CallToolRequest['params']['arguments']

/** What a harness needs to reach its run's tools. */
export interface RunToolAccess {
  url: string
  /** The `Authorization` header value. */
  authorization: string
  /** Ends the token: a later request with it is refused. */
  release(): void
}

/** The run behind each token, by the token's hash. A token of no current run has none. */
const bindings = new Map<string, RunToolBinding | undefined>()
/** The token of a session whose harness keeps its MCP config across runs. */
const sessionTokens = new Map<string, string>()
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
 *
 * With `sessionId`, every run of that session gets the same token: a harness
 * that keeps a thread loaded (Codex) keeps the MCP config of its first run.
 * Between runs the token reaches no tools.
 */
export function bindRunTools(binding: RunToolBinding, sessionId?: string): RunToolAccess {
  if (!endpointUrl) throw new Error('The host has no MCP endpoint yet.')
  assertUniqueAgentTools(binding.tools)
  const token = (sessionId ? sessionTokens.get(sessionId) : undefined) ?? randomBytes(32).toString('base64url')
  if (sessionId) sessionTokens.set(sessionId, token)
  const hash = tokenHash(token)
  bindings.set(hash, binding)
  const release = () => {
    if (bindings.get(hash) !== binding) return
    if (sessionId) bindings.set(hash, undefined)
    else bindings.delete(hash)
  }
  return { url: endpointUrl, authorization: `Bearer ${token}`, release }
}

/** The run a token belongs to, while its run lasts. */
export function runToolBindingFor(token: string): RunToolBinding | undefined {
  return bindings.get(tokenHash(token))
}

/** Whether the host made this token: a token of a session between runs is still the host's. */
export function isRunToolToken(token: string): boolean {
  return bindings.has(tokenHash(token))
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
function listedTool(agentTool: AgentTool, annotations?: Tool['annotations']): Tool {
  const listed = {
    name: agentTool.name,
    description: agentTool.description,
    inputSchema: { ...advertisedInputSchema(agentTool), type: 'object' as const },
    ...(annotations ? { annotations } : {}),
  }
  return ToolSchema.parse(agentTool.alwaysLoad ? { ...listed, _meta: { 'anthropic/alwaysLoad': true } } : listed)
}

function refused(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

async function invokeRunTool(
  binding: RunToolBinding,
  agentTool: AgentTool,
  input: ToolArguments,
  request: CallToolRequest,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const toolUseId = callToolUseId(request.params._meta) ?? await binding.toolUseIdOf?.(agentTool.name, input)
  if (agentTool.requiresApproval) {
    if (binding.permissionMode() === 'plan') return refused(`Cannot run ${agentTool.name} in plan mode. Exit plan mode to apply changes.`)
    if (!await binding.approve(agentTool, input, toolUseId)) return refused(`The user declined ${agentTool.name}.`)
  }
  try {
    return mcpToolResult(await executeAgentTool(agentTool, input ?? {}, {
      ...binding.context,
      abortSignal: AbortSignal.any([binding.context.abortSignal, signal]),
      parentToolUseId: () => toolUseId,
    }))
  } catch (error) {
    // The harness waits for one result for every call; a thrown tool still answers.
    return refused(error instanceof Error ? error.message : String(error))
  }
}

/**
 * The MCP server for one request of a run: its tools, called with its
 * context. A run that ended after its token was checked has none.
 */
export function runToolServer(binding: RunToolBinding | undefined): Server {
  const server = new Server({ name: 'solus', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => {
    if (!binding) return { tools: [] }
    const enabled = enabledAgentTools(binding.tools)
    return { tools: binding.deferProxy ? listedProxyTools(enabled, listedTool) : enabled.map((tool) => listedTool(tool)) }
  })
  server.setRequestHandler('tools/call', async (request, extra): Promise<CallToolResult> => {
    if (!binding) return refused('This run has ended.')
    if (binding.deferProxy && request.params.name === TOOL_SEARCH) {
      const query = parseToolSearchQuery(request.params.arguments)
      if (query === null) return refused('tool_search requires a string `query` argument.')
      const tools = searchDeferredTools(enabledAgentTools(binding.tools), query)
      return { content: [{ type: 'text', text: JSON.stringify({ tools }) }] }
    }
    if (binding.deferProxy && request.params.name === TOOL_CALL) {
      const parsed = parseToolCallProxy(request.params.arguments)
      if (!parsed.ok) return refused(parsed.error)
      const target = enabledAgentTools(binding.tools).find((candidate) => candidate.name === parsed.name)
      if (!target) return refused(`Unknown tool: ${parsed.name}`)
      return invokeRunTool(binding, target, parsed.arguments, request, extra.mcpReq.signal)
    }
    const agentTool = binding.tools.find((candidate) => candidate.name === request.params.name)
    if (!agentTool) return refused(`Unknown tool: ${request.params.name}`)
    return invokeRunTool(binding, agentTool, request.params.arguments, request, extra.mcpReq.signal)
  })
  return server
}

/** An outside app that signed in to this host (plans/035 §4.2): its grant and the person it acts for. */
export interface AppCaller {
  /** The app's grant: its `host_device` row. */
  grantId: string
  access: AppAccess
  actor: Actor
  signal: AbortSignal
}

/**
 * The tools an outside app may list: Solus tools on its allow-list, on in
 * Settings → Tools, within its grant. The toolbox loads on an app's first
 * call, not with the HTTP server.
 */
async function appTools(access: AppAccess): Promise<AgentTool[]> {
  const { solusToolbox } = await import('./solus-toolbox')
  return enabledAgentTools(Object.values(solusToolbox).flatMap((group) => Object.values(group))).filter((tool) => !appToolRefusal(tool, access))
}

/** What an outside app reads of the proxy: it reaches the operations of the person's apps (plans/035 §7.3). */
const APP_OPERATIONS_PROXY = {
  search: 'Find the operations of the apps that live in Solus on this host, then run one with tool_call. Search by app name, operation name, or purpose; an empty query lists them. Each result has its input schema.',
  query: 'App name, operation name, or keywords. Empty lists the operations.',
  call: 'Run an app operation by its exact name from tool_search, such as `notes__add`. A read-only connection runs queries only.',
}

/**
 * The operations of the person's running apps, behind `tool_search` and
 * `tool_call`. They load on the first call that needs them.
 */
async function appOperationTools(app: AppCaller, solusTools: readonly AgentTool[]): Promise<AppOperationTool[]> {
  const { appOperationAgentTools } = await import('./app-tools')
  return appOperationAgentTools(app.actor, new Set([...solusTools.map((tool) => tool.name), TOOL_SEARCH, TOOL_CALL]), { instructionTools: true })
}

/** The proxy is listed whenever the host runs apps for the person, so `tools/list` stays the same when an app is added, deployed, or stopped. */
async function listsAppOperations(app: AppCaller): Promise<boolean> {
  const { hostRunsAppsFor } = await import('./app-tools')
  return hostRunsAppsFor(app.actor)
}

/** The tool an outside app's call runs and its input, or why the app may not run it. */
type OutsideAppCall = { agentTool: AgentTool; input: NonNullable<ToolArguments> } | { refusal: string }

/** A `tool_call` of an app operation: a mutation needs a write grant. */
function appOperationCall(operations: readonly AppOperationTool[], args: ToolArguments, access: AppAccess): OutsideAppCall {
  const parsed = parseToolCallProxy(args)
  if (!parsed.ok) return { refusal: parsed.error }
  const operation = operations.find((candidate) => candidate.name === parsed.name)
  if (!operation) return { refusal: `Unknown app operation: ${parsed.name}. Find it with tool_search.` }
  const refusal = appOperationRefusal(operation.name, operation.operationKind, access)
  return refusal ? { refusal } : { agentTool: operation, input: parsed.arguments }
}

/** A call of a Solus tool on the outside app's list. */
function solusToolCall(tools: readonly AgentTool[], name: string, args: ToolArguments, access: AppAccess): OutsideAppCall {
  const agentTool = tools.find((candidate) => candidate.name === name)
  if (!agentTool) return { refusal: appToolRefusal({ name, requiresApproval: false }, access) ?? `Unknown tool: ${name}` }
  return { agentTool, input: args ?? {} }
}

/**
 * The MCP server for one request of an outside app. It has no session: each
 * call runs as the app's person, under the same access rule as a harness turn,
 * with no conversation to show a card in.
 */
export async function appToolServer(app: AppCaller): Promise<Server> {
  const server = new Server({ name: 'solus', version: '1.0.0' }, { capabilities: { tools: {} } })
  const tools = await appTools(app.access)
  let operations: Promise<AppOperationTool[]> | null = null
  const appOperations = () => operations ??= appOperationTools(app, tools)
  server.setRequestHandler('tools/list', async () => ({
    tools: [
      ...tools.map((tool) => listedTool(tool, appToolHints(tool.name))),
      ...await listsAppOperations(app) ? proxyTools(APP_OPERATIONS_PROXY) : [],
    ],
  }))
  server.setRequestHandler('tools/call', async (request, extra): Promise<CallToolResult> => {
    if (request.params.name === TOOL_SEARCH) {
      const query = parseToolSearchQuery(request.params.arguments)
      if (query === null) return refused('tool_search requires a string `query` argument.')
      return { content: [{ type: 'text', text: JSON.stringify({ tools: searchDeferredTools(await appOperations(), query) }) }] }
    }
    const call = request.params.name === TOOL_CALL
      ? appOperationCall(await appOperations(), request.params.arguments, app.access)
      : solusToolCall(tools, request.params.name, request.params.arguments, app.access)
    if ('refusal' in call) return refused(call.refusal)
    const { agentTool, input } = call
    const denied = await toolAccessRefusal(agentTool, input, undefined, app.actor.principal)
    if (denied) return refused(denied)
    const context: AgentToolContext = {
      // An outside app has no harness; a tool that records one records the default.
      provider: 'claude-code',
      cwd: resolveHomePath('~'),
      sessionId: () => undefined,
      // The work an app starts is keyed by its grant, as T3 Code keys it by its client (`requestNamespace`).
      requesterKey: () => clientRequesterKey(app.grantId),
      abortSignal: AbortSignal.any([app.signal, extra.mcpReq.signal]),
      parentToolUseId: () => undefined,
      emit: () => {},
    }
    try {
      return mcpToolResult(await withActorScope(app.actor, () => withWorkspaceToolAuthority(app.actor.principal, () => executeAgentTool(agentTool, input, context))))
    } catch (error) {
      return refused(error instanceof Error ? error.message : String(error))
    }
  })
  return server
}
