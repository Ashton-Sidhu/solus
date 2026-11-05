import type { McpServerStatus, Query, SDKControlMcpReadResourceResponse, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mcpAppToolMetadataSchema, type McpAppToolInfo } from '@solus/contracts/mcp-apps'
import { createLogger } from '../../../logger'
import type { ClaudeSeat } from './claude-agent'
import { openTurnlessClaude } from './claude-mcp-auth'

const log = createLogger('ClaudeMcpApps', 'claude-mcp-apps.ts')

/** Without these, tools carry no `_meta.ui` and a model-shaped result would reach the app. */
const APP_CAPABILITIES = ['mcp_tool_ui_meta_v1', 'mcp_read_resource_v1', 'mcp_call_result_not_for_model_v1']
const CAPTURE_TIMEOUT_MS = 15_000
const SERVER_CONNECT_TIMEOUT_MS = 15_000
const SERVER_CONNECT_POLL_MS = 250
/** A card's next click finds the process ready; a closed card leaves nothing running. */
const PROCESS_IDLE_MS = 2 * 60_000

const SOLUS_SERVER = 'mcp__solus'
const toolNamePart = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_')

/** Claude Code's `mcp__<server>__` prefix; it also collapses and trims `_` in `claude.ai ` connector names. */
function toolPrefix(server: string): string {
  const part = toolNamePart(server)
  return `mcp__${server.startsWith('claude.ai ') ? part.replace(/_+/g, '_').replace(/^_|_$/g, '') : part}__`
}

export function claudeToolName(server: string, tool: string): string {
  return `${toolPrefix(server)}${toolNamePart(tool)}`
}

/** The name Claude sees for a tool of a Solus integration. */
export function claudeIntegrationToolName(agentToolName: string): string {
  return `${SOLUS_SERVER}__${agentToolName}`
}

type ServerTool = NonNullable<McpServerStatus['tools']>[number]

/** Claude routes `mcp__a__b__tool` to server `a` even when `a__b` is connected, so either prefix is ambiguous. */
function prefixOverlaps(statuses: McpServerStatus[], server: string): boolean {
  const prefix = toolPrefix(server)
  return statuses.some((status) => {
    if (status.name === server) return false
    const other = toolPrefix(status.name)
    return other.startsWith(prefix) || prefix.startsWith(other)
  })
}

function findTool(statuses: McpServerStatus[], claudeName: string): { server: string; tool: ServerTool } | null {
  const matches = statuses.flatMap((status) => status.status !== 'connected' ? [] : (status.tools ?? [])
    .filter((tool) => claudeToolName(status.name, tool.name) === claudeName)
    .map((tool) => ({ server: status.name, tool })))
  const [match] = matches
  return matches.length === 1 && match && !prefixOverlaps(statuses, match.server) ? match : null
}

const permissionRulesSchema = z.object({
  state: z.object({
    rules: z.array(z.object({
      behavior: z.enum(['allow', 'deny', 'ask']),
      rule: z.string(),
      notInEffect: z.boolean().optional(),
    })),
    errors: z.array(z.unknown()).optional(),
  }),
})
export type ClaudePermissionRule = z.infer<typeof permissionRulesSchema>['state']['rules'][number]

/**
 * Deliberately broader than Claude's matcher on a server Claude owns: Claude also
 * matches rules against server aliases Solus cannot list, so any `mcp__` rule or
 * wildcard may cover the tool. The Solus server has no aliases. A false match
 * only refuses a card's call, or asks first.
 */
function ruleMayCover({ rule }: ClaudePermissionRule, claudeName: string): boolean {
  const name = rule.split('(', 1)[0] ?? rule
  if (name.includes('*')) return true
  if (!name.startsWith('mcp__')) return false
  if (claudeName.startsWith(`${SOLUS_SERVER}__`)) return name === SOLUS_SERVER || name === claudeName
  return true
}

/** What Claude's rules say of a card calling a tool. A card's call reaches the tool without Claude's own check. */
export function cardAccess(rules: ClaudePermissionRule[], claudeName: string): 'allow' | 'ask' | 'deny' {
  const covering = rules.filter((entry) => entry.notInEffect !== true && ruleMayCover(entry, claudeName))
  if (covering.some((entry) => entry.behavior === 'deny')) return 'deny'
  return covering.some((entry) => entry.behavior === 'ask') ? 'ask' : 'allow'
}

const textContent = z.string().transform((text) => [{ type: 'text', text }])
/** A model turn flattens text `content` to a string; apps expect MCP's `CallToolResult`. */
export const appToolResultSchema = z.union([
  z.looseObject({ content: z.union([textContent, z.array(z.json())]).default([]) }),
  textContent.transform((content) => ({ content })),
])
type AppToolResult = z.output<typeof appToolResultSchema>
type JsonValue = z.output<ReturnType<typeof z.json>>

let saveApp: ((sessionId: string, app: ClaudeMcpApp) => Promise<void>) | null = null

/** Installed once at boot: what saves the MCP App of a finished Claude tool call. */
export function useClaudeAppCapture(save: (sessionId: string, app: ClaudeMcpApp) => Promise<void>): void {
  saveApp = save
}

/** What a run's capture saves through. */
export function claudeAppSaver(sessionId: () => string | undefined): (app: ClaudeMcpApp) => Promise<void> {
  return async (app) => {
    const id = sessionId()
    if (id) await saveApp?.(id, app)
  }
}

/** A finished tool call that declares an app, with the document it read. */
export interface ClaudeMcpApp {
  server: string
  tool: { name: string }
  resourceUri: string
  input: JsonValue
  result: AppToolResult
  resource: SDKControlMcpReadResourceResponse
}

interface ToolCall {
  name: string
  input: JsonValue
}

const assistantMessageSchema = z.object({
  type: z.literal('assistant'),
  parent_tool_use_id: z.string().nullable(),
  message: z.object({ content: z.array(z.looseObject({ type: z.string() })) }),
})
const toolUseSchema = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.json() })
const toolResultMessageSchema = z.object({
  type: z.literal('user'),
  tool_use_result: appToolResultSchema.optional().catch(undefined),
  message: z.object({ content: z.array(z.looseObject({ type: z.string() })) }),
})
const toolResultSchema = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), is_error: z.boolean().optional(), content: appToolResultSchema.optional().catch(undefined) })

/**
 * Saves the app of a tool that a run's own MCP server answered. It reads the
 * app beside the event stream, so a slow server never delays the transcript.
 * A call inside a subagent is not captured, and a capture that fails leaves the
 * plain tool row.
 */
export class ClaudeAppCapture {
  private isSupported = false
  private readonly calls = new Map<string, ToolCall>()
  private readonly running = new Set<Promise<void>>()

  constructor(
    private readonly query: Pick<Query, 'mcpServerStatus' | 'readMcpResource'>,
    private readonly save: (app: ClaudeMcpApp) => Promise<void>,
  ) {}

  observe(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      this.isSupported = APP_CAPABILITIES.every((capability) => message.capabilities?.includes(capability))
      return
    }
    if (!this.isSupported) return
    const assistant = assistantMessageSchema.safeParse(message)
    if (assistant.success && assistant.data.parent_tool_use_id === null) {
      for (const block of assistant.data.message.content) {
        const call = toolUseSchema.safeParse(block)
        if (call.success && call.data.name.startsWith('mcp__') && !call.data.name.startsWith(`${SOLUS_SERVER}__`)) {
          this.calls.set(call.data.id, { name: call.data.name, input: call.data.input })
        }
      }
      return
    }
    const user = toolResultMessageSchema.safeParse(message)
    if (!user.success) return
    for (const block of user.data.message.content) {
      const result = toolResultSchema.safeParse(block)
      if (!result.success) continue
      const call = this.calls.get(result.data.tool_use_id)
      if (!call) continue
      this.calls.delete(result.data.tool_use_id)
      const output = user.data.tool_use_result ?? result.data.content
      if (!result.data.is_error && output) this.start(call, output)
    }
  }

  /** Waits for the captures in flight: they read through this run's process, which a finished turn closes. */
  async settled(): Promise<void> {
    await Promise.all(this.running)
  }

  private start(call: ToolCall, result: AppToolResult): void {
    const capture = withTimeout(this.capture(call, result), CAPTURE_TIMEOUT_MS)
      .catch((error) => log.warn('claude_app_capture_failed', { tool: call.name, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => this.running.delete(capture))
    this.running.add(capture)
  }

  private async capture(call: ToolCall, result: AppToolResult): Promise<void> {
    const match = findTool(await this.query.mcpServerStatus(), call.name)
    const metadata = mcpAppToolMetadataSchema.safeParse(match?.tool._meta)
    if (!match || !metadata.success) return
    const resourceUri = metadata.data.ui?.resourceUri ?? metadata.data['ui/resourceUri']
    if (!resourceUri) return
    const resource = await this.query.readMcpResource(match.server, resourceUri)
    await this.save({ server: match.server, tool: match.tool, resourceUri, input: call.input, result, resource })
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out.')), timeoutMs) })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** Where a card's request runs: the session's directory, on the caller's Claude login. */
export interface ClaudeAppPlace {
  cwd: string
  seat?: ClaudeSeat
}

interface AppProcess {
  session: Query
  close(): Promise<void>
}

interface OpenProcess {
  process: Promise<AppProcess>
  idle?: ReturnType<typeof setTimeout>
}

type ControlRequest =
  | { subtype: 'list_permission_rules' }
  | { subtype: 'mcp_call'; tool: string; arguments: JsonObject; result_not_for_model: true }
type JsonObject = { [key: string]: JsonValue }

/** The SDK types these control requests but has no method for them; its own readMcpResource sends them this way. */
interface ControlRequests {
  request(request: ControlRequest): Promise<{ response?: JsonValue }>
}

function controlRequest(session: Query, request: ControlRequest): Promise<{ response?: JsonValue }> {
  if (!hasControlRequests(session)) throw new Error('This Claude Code version cannot run MCP Apps. Update Claude Code and try again.')
  return session.request(request)
}

function hasControlRequests(candidate: Query): candidate is Query & ControlRequests {
  return 'request' in candidate
}

/**
 * The Claude processes that answer app cards. A run's process ends with its
 * turn and a card outlives it, so a card has its own process with no turn. It
 * spends no tokens, and it stops when its cards go quiet.
 */
export class ClaudeAppProcesses {
  private readonly open = new Map<string, OpenProcess>()

  constructor(private readonly openProcess: (place: ClaudeAppPlace) => Promise<AppProcess> = openTurnlessClaude) {}

  /** What a card may do with this tool of a server Claude owns. */
  async toolInfo(place: ClaudeAppPlace, server: string, name: string): Promise<McpAppToolInfo> {
    return this.using(place, async (session) => {
      const statuses = await connectedStatuses(session, server)
      const claudeName = claudeToolName(server, name)
      const sameName = statuses.find((status) => status.name === server)?.tools?.filter((tool) => claudeToolName(server, tool.name) === claudeName) ?? []
      const [tool] = sameName
      const title = name
      if (!tool) return { callable: false, readOnly: false, title }
      if (sameName.length > 1 || prefixOverlaps(statuses, server)) {
        return { callable: false, readOnly: false, title, refusal: `Another MCP tool has the same name in Claude, so ${name} was not called.` }
      }
      const metadata = mcpAppToolMetadataSchema.safeParse(tool._meta ?? {})
      const visibility = metadata.success ? metadata.data.ui?.visibility : undefined
      if (!metadata.success || (visibility && !visibility.includes('app'))) return { callable: false, readOnly: false, title }
      const access = await this.accessIn(session, claudeName)
      if (access === 'deny') return { callable: false, readOnly: false, title, refusal: deniedByClaude(name) }
      return { callable: true, readOnly: access === 'allow' && tool.annotations?.readOnly === true, title }
    })
  }

  /** Claude's answer for a tool that is not on a server it owns. */
  access(place: ClaudeAppPlace, claudeName: string): Promise<'allow' | 'ask' | 'deny'> {
    return this.using(place, (session) => this.accessIn(session, claudeName))
  }

  callTool(place: ClaudeAppPlace, server: string, name: string, input: JsonObject): Promise<AppToolResult> {
    return this.using(place, async (session) => {
      const reply = await controlRequest(session, { subtype: 'mcp_call', tool: claudeToolName(server, name), arguments: input, result_not_for_model: true })
      return appToolResultSchema.parse(reply.response)
    })
  }

  readResource(place: ClaudeAppPlace, server: string, uri: string): Promise<ClaudeMcpApp['resource']> {
    return this.using(place, async (session) => {
      await connectedStatuses(session, server)
      return session.readMcpResource(server, uri)
    })
  }

  async closeAll(): Promise<void> {
    const open = Array.from(this.open.values())
    this.open.clear()
    await Promise.all(open.map(async (entry) => {
      if (entry.idle) clearTimeout(entry.idle)
      await (await entry.process.catch(() => null))?.close()
    }))
  }

  /** An unreadable rule set refuses: a deny rule in it must not stop applying because Solus cannot see it. */
  private async accessIn(session: Query, claudeName: string): Promise<'allow' | 'ask' | 'deny'> {
    const parsed = permissionRulesSchema.safeParse((await controlRequest(session, { subtype: 'list_permission_rules' })).response)
    // A settings file Claude could not parse was skipped, so its rules are not in the list.
    if (!parsed.success || parsed.data.state.errors?.length) return 'deny'
    return cardAccess(parsed.data.state.rules, claudeName)
  }

  private async using<T>(place: ClaudeAppPlace, work: (session: Query) => Promise<T>): Promise<T> {
    const key = JSON.stringify([place.cwd, place.seat?.home, place.seat?.user])
    const entry = this.open.get(key) ?? { process: this.openProcess(place) }
    this.open.set(key, entry)
    if (entry.idle) clearTimeout(entry.idle)
    try {
      return await work((await entry.process).session)
    } catch (error) {
      // A process that failed once is not reused: the next request starts clean.
      this.close(key, entry)
      throw error
    } finally {
      if (this.open.get(key) === entry) {
        entry.idle = setTimeout(() => this.close(key, entry), PROCESS_IDLE_MS)
        entry.idle.unref?.()
      }
    }
  }

  private close(key: string, entry: OpenProcess): void {
    if (entry.idle) clearTimeout(entry.idle)
    if (this.open.get(key) === entry) this.open.delete(key)
    void entry.process.then((process) => process.close(), () => undefined)
  }
}

export function deniedByClaude(tool: string): string {
  return `A Claude permission rule may cover ${tool}, or Claude's rules could not be read, so it was not called.`
}

/** A new process connects its servers after it starts. */
async function connectedStatuses(session: Query, server: string): Promise<McpServerStatus[]> {
  const deadline = Date.now() + SERVER_CONNECT_TIMEOUT_MS
  for (;;) {
    const statuses = await session.mcpServerStatus()
    const status = statuses.find((each) => each.name === server)?.status
    if (status === 'connected') return statuses
    if (status !== 'pending' || Date.now() >= deadline) throw new Error(`The ${server} MCP server is not connected.`)
    await new Promise((resolve) => setTimeout(resolve, SERVER_CONNECT_POLL_MS))
  }
}
