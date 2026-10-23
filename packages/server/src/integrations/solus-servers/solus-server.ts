import { z } from 'zod'
// The low-level server: `McpServer` types schemas against the SDK's own zod copy,
// and these tools use the workspace's zod 4, so the tools publish JSON Schema.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { CatalogCategoryId } from '@solus/contracts/integration-types'
import type { OAuthSignInOptions } from '@solus/contracts/integrations/oauth-protocol'
import type { FirstPartyClientId } from '@solus/contracts/first-party-clients'

/**
 * A Solus MCP server (docs/plans/mcp-integrations.md §13.6): an MCP server
 * Solus writes for a service with no usable one, run inside the host. The
 * gateway opens a session to it over an in-memory transport, so everything
 * after the session — tool lists, calls, approval, `disabledTools`, the connect
 * card — is the same as for a remote server.
 */

/** What a tool reaches the network with: only its server's hosts, with the person's token. */
export interface SolusToolContext {
  fetch(url: string, init?: SolusFetchInit): Promise<Response>
  signal: AbortSignal
}

export interface SolusFetchInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: string
  /** The body's media type; JSON when a body is sent without one. */
  contentType?: string
}

/** A vendor's answer, parsed as JSON, or a small summary a tool builds from one. */
const vendorAnswerSchema = z.json()
export type VendorAnswer = z.infer<typeof vendorAnswerSchema>

/** A tool call's arguments as MCP carries them, before the tool's schema parses them. */
type ToolArguments = CallToolRequest['params']['arguments']

interface SolusToolSpec<Input extends z.ZodObject> {
  name: string
  title?: string
  description: string
  input: Input
  /** Every tool says whether it only reads; a tool that may write and cannot be undone is `destructive`. */
  readOnly: boolean
  destructive: boolean
  run(input: z.output<Input>, context: SolusToolContext): Promise<VendorAnswer>
}

/** One tool as a server lists and calls it: its input is parsed inside `call`. */
export interface SolusServerTool {
  name: string
  title?: string
  description: string
  inputSchema: z.ZodObject
  readOnly: boolean
  destructive: boolean
  call(input: ToolArguments, context: SolusToolContext): Promise<VendorAnswer>
}

/** One typed tool: its run sees only input its schema accepted. */
export function solusTool<Input extends z.ZodObject>(spec: SolusToolSpec<Input>): SolusServerTool {
  const { input, run, ...listed } = spec
  return {
    ...listed,
    inputSchema: input,
    async call(raw, context) {
      const parsed = input.safeParse(raw)
      if (!parsed.success) throw new Error(`Invalid input: ${z.prettifyError(parsed.error)}`)
      return run(parsed.data, context)
    },
  }
}

export interface SolusServerDefinition {
  id: string
  name: string
  description: string
  domain: string
  /** The service's own icon, for the catalog row. */
  icon: string
  categories: CatalogCategoryId[]
  /** The vendor hosts the token may go to; a leading `*.` matches subdomains. */
  hosts: string[]
  auth: {
    /** The authorization server's metadata document (RFC 8414 or OpenID). */
    discover: string
    sign: OAuthSignInOptions
    /** Whether the vendor takes RFC 8707 `resource`; Google does not. */
    sendsResource: boolean
    /** The Solus app registered with this vendor, which signs in when the build has it (§13.1). */
    firstParty?: FirstPartyClientId
  }
  /** The connection label after a sign-in: the account the token belongs to. */
  identify(context: SolusToolContext): Promise<string | null>
  tools: SolusServerTool[]
}

/** A tool's result text is bounded like every other Solus tool's. */
const RESULT_MAX_CHARS = 60_000
const RESPONSE_MAX_BYTES = 5 * 1024 * 1024

/** The token was refused: the connection needs a new sign-in. */
export class SolusServerAuthError extends Error {
  constructor(readonly status: number) {
    super(`The service refused the sign-in (HTTP ${status}). Sign in again.`)
    this.name = 'SolusServerAuthError'
  }
}

function hostAllowed(hostname: string, hosts: readonly string[]): boolean {
  return hosts.some((host) => host.startsWith('*.') ? hostname.endsWith(host.slice(1)) : hostname === host)
}

export interface SolusSessionDeps {
  /** The `Authorization` header value for the person, read on each request so a refreshed token is used. */
  authorization(): Promise<string | null>
  /** The vendor refused the token. */
  onRefused(error: SolusServerAuthError): void
  fetch?: typeof fetch
}

/** The one way a Solus server's tools reach the network (§13.6). */
export function boundFetch(definition: Pick<SolusServerDefinition, 'hosts'>, deps: SolusSessionDeps, signal: AbortSignal): SolusToolContext['fetch'] {
  return async (target, init = {}) => {
    if (!URL.canParse(target)) throw new Error(`Not a URL: ${target}`)
    const url = new URL(target)
    if (url.protocol !== 'https:' || !hostAllowed(url.hostname, definition.hosts)) {
      throw new Error(`This server may not reach ${url.host}.`)
    }
    const authorization = await deps.authorization()
    if (!authorization) throw new SolusServerAuthError(401)
    const response = await (deps.fetch ?? fetch)(url, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: requestHeaders(authorization, init),
      // A redirect must not carry the token to another host (§4.1 rule 4).
      redirect: 'error',
      signal,
    })
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined)
      const error = new SolusServerAuthError(response.status)
      deps.onRefused(error)
      throw error
    }
    if (Number(response.headers.get('content-length') ?? 0) > RESPONSE_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('The service answered with more than Solus reads in one call.')
    }
    return response
  }
}

function requestHeaders(authorization: string, init: SolusFetchInit): Headers {
  const headers = new Headers({ accept: 'application/json', authorization })
  if (init.body !== undefined) headers.set('content-type', init.contentType ?? 'application/json')
  return headers
}

/** The part of a tool's JSON Schema `tools/list` carries: an object's properties and required names. */
const objectJsonSchema = z.object({
  properties: z.record(z.string(), z.object({}).loose()).optional(),
  required: z.array(z.string()).optional(),
}).loose()

/** One tool as `tools/list` describes it, with the hints approval relies on. */
function listedTool(tool: SolusServerTool): Tool {
  const schema = objectJsonSchema.parse(z.toJSONSchema(tool.inputSchema, { target: 'draft-7', io: 'input' }))
  const listed: Tool = {
    name: tool.name,
    description: tool.description,
    inputSchema: { ...schema, type: 'object' },
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive },
  }
  if (tool.title) listed.title = tool.title
  return listed
}

function resultText(value: VendorAnswer): string {
  const text = JSON.stringify(value, null, 1)
  return text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS)}\n… (cut at ${RESULT_MAX_CHARS} characters; ask for less)` : text
}

/** The MCP server one person's session talks to. */
export function solusMcpServer(definition: SolusServerDefinition, deps: SolusSessionDeps): Server {
  const server = new Server({ name: `solus-${definition.id}`, version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: definition.tools.map(listedTool) }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const tool = definition.tools.find((candidate) => candidate.name === request.params.name)
    if (!tool) return { isError: true, content: [{ type: 'text', text: `${definition.name} has no tool named ${request.params.name}.` }] }
    try {
      const value = await tool.call(request.params.arguments, { fetch: boundFetch(definition, deps, extra.signal), signal: extra.signal })
      return { content: [{ type: 'text', text: resultText(value) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
    }
  })
  return server
}

const vendorErrorSchema = z.object({ error: z.object({ message: z.string() }) })

/** Reads a vendor answer as JSON, with the vendor's own message when it refused. */
/** The body as a vendor answer: an empty body is null, and a body that is not JSON fails. */
function vendorAnswerOf(text: string): ReturnType<typeof vendorAnswerSchema.safeParse> {
  try {
    return vendorAnswerSchema.safeParse(text ? JSON.parse(text) : null)
  } catch {
    return vendorAnswerSchema.safeParse(undefined)
  }
}

export async function vendorJson(response: Response): Promise<VendorAnswer> {
  const text = await response.text()
  if (text.length > RESPONSE_MAX_BYTES) throw new Error('The service answered with more than Solus reads in one call.')
  // An error page may not be JSON; its status is the answer then.
  const parsed = vendorAnswerOf(text)
  if (!response.ok) {
    const message = vendorErrorSchema.safeParse(parsed.data)
    throw new Error(message.success ? message.data.error.message : `The service answered HTTP ${response.status}.`)
  }
  if (!parsed.success) throw new Error('The service answered with something other than JSON.')
  return parsed.data
}

/**
 * Reads a vendor answer that is not JSON, such as a file's exported text,
 * cut to what one tool result carries. A refusal reads like `vendorJson`'s.
 */
export async function vendorText(response: Response): Promise<string> {
  if (!response.ok) {
    await vendorJson(response)
    throw new Error(`The service answered HTTP ${response.status}.`)
  }
  const text = await response.text()
  return text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS)}\n… (cut at ${RESULT_MAX_CHARS} characters)` : text
}
