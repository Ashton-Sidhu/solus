import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { z } from 'zod'
import type {
  IntegrationAuth,
  IntegrationProbeResult,
  IntegrationProbeSignal,
  IntegrationProbeUndeterminedReason,
  IntegrationToolSummary,
} from '@solus/contracts/integration-types'

/**
 * The anonymous check of a remote MCP server (docs/plans/mcp-integrations.md
 * §3.2), ported from Executor's `detectMcpAccess`. It sends `initialize` and
 * `tools/list` without credentials, then reads the OAuth metadata a rejection
 * names. Requests never follow redirects, carry credentials, or call tools.
 * Signals record status, media type, and challenge, never a body or a URL.
 */

const PROTOCOL_VERSION = '2025-06-18'
const MAX_ANSWER_BYTES = 16 * 1024 * 1024

type Signal = IntegrationProbeSignal
type RequestSignal = Extract<Signal, { kind: 'request' }>
type Media = RequestSignal['media']
type Challenge = NonNullable<RequestSignal['challenge']>
type UndeterminedReason = IntegrationProbeUndeterminedReason

export interface ProbeOptions {
  timeoutMs?: number
  /** Let `localhost`, `127.0.0.1`, and `::1` through. Other private addresses are always refused. */
  allowLoopback?: boolean
}

/** The transport could not complete one request. */
class ProbeRequestFailed extends Error {
  constructor(readonly reason: 'unreachable' | 'timeout' | 'refused') {
    super(reason)
  }
}

interface Exchange {
  status: number
  media: Media
  answer: 'result' | 'error' | 'none'
  result?: unknown
  authenticate?: string
  session?: string
}

/** The headers every request after `initialize` carries. */
interface SessionHeaders {
  'mcp-protocol-version': string
  'mcp-session-id'?: string
}

const jsonRpcResponseSchema = z.object({
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
})

const initializeResultSchema = z.object({ protocolVersion: z.string().min(1) })

const toolSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  annotations: z.object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
  }).optional(),
})

const toolsResultSchema = z.object({ tools: z.array(z.unknown()) })

const resourceMetadataSchema = z.object({
  resource: z.string().min(1),
  authorization_servers: z.array(z.string().min(1)).min(1),
})

const authorizationServerSchema = z.object({
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  response_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  registration_endpoint: z.string().min(1).optional(),
})

function mediaOf(contentType: string | null): Media {
  const type = contentType?.split(';')[0]?.trim().toLowerCase()
  if (!type) return 'none'
  if (type === 'application/json' || type.endsWith('+json')) return 'json'
  if (type === 'text/event-stream') return 'event-stream'
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  return type.startsWith('text/') ? 'text' : 'other'
}

/** The parameters of the Bearer challenge in a `WWW-Authenticate` header, or null without one. */
function bearerParams(header: string | undefined): Map<string, string> | null {
  if (!header) return null
  const start = /(?:^|,)\s*bearer(?=\s|,|$)/i.exec(header)
  if (!start) return null
  const params = new Map<string, string>()
  const rest = header.slice(start.index + start[0].length)
  for (const match of rest.matchAll(/([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params.set(match[1].toLowerCase(), (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1'))
  }
  return params
}

function challengeOf(header: string | undefined): Challenge | undefined {
  if (!header?.trim()) return undefined
  const bearer = bearerParams(header)
  if (bearer) return { scheme: 'bearer', resourceMetadata: bearer.has('resource_metadata'), scope: bearer.has('scope') }
  const scheme = /^\s*([!#$%&'*+.^_`|~A-Za-z0-9-]+)/.exec(header)?.[1]?.toLowerCase()
  return { scheme: scheme === 'basic' ? 'basic' : 'other', resourceMetadata: false, scope: false }
}

const successful = (exchange: Exchange): boolean => exchange.status >= 200 && exchange.status < 300

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || hostname.startsWith('127.')
}

/** Whether an IP literal is private, loopback, link-local, or otherwise not a public destination. */
function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  const ip = mapped ?? address
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const lower = ip.toLowerCase()
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)
}

/** Refuses a destination that is not public, before any request leaves the host. */
async function assertPublic(url: URL, allowLoopback: boolean): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ProbeRequestFailed('refused')
  if (isLoopbackHost(hostname)) {
    if (allowLoopback) return
    throw new ProbeRequestFailed('refused')
  }
  const addresses = isIP(hostname) ? [hostname] : await lookup(hostname, { all: true }).then((found) => found.map((each) => each.address), () => {
    throw new ProbeRequestFailed('unreachable')
  })
  if (addresses.some(isPrivateAddress)) throw new ProbeRequestFailed('refused')
}

/** Reads a body up to the answer limit. */
async function readText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined)
      break
    }
    text += decoder.decode(value, { stream: true })
  }
  return text
}

function matchingResponse(text: string, id: number): z.infer<typeof jsonRpcResponseSchema> | null {
  try {
    const parsed = jsonRpcResponseSchema.safeParse(JSON.parse(text))
    return parsed.success && parsed.data.id === id ? parsed.data : null
  } catch {
    return null
  }
}

/** The JSON-RPC response to `id` in the first event that carries it. The server may keep the stream open after answering. */
async function readEventStream(response: Response, id: number): Promise<z.infer<typeof jsonRpcResponseSchema> | null> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return data.length ? matchingResponse(data.join('\n'), id) : null
      size += value.byteLength
      if (size > MAX_ANSWER_BYTES) return null
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          const message = data.length ? matchingResponse(data.join('\n'), id) : null
          data = []
          if (message) return message
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function signalOf(method: RequestSignal['method'], exchange: Exchange): RequestSignal {
  const signal: RequestSignal = { kind: 'request', method, status: exchange.status, media: exchange.media, answer: exchange.answer }
  const challenge = challengeOf(exchange.authenticate)
  if (challenge) signal.challenge = challenge
  return signal
}

function toolSummaries(result: z.infer<typeof toolsResultSchema>): IntegrationToolSummary[] {
  const tools: IntegrationToolSummary[] = []
  for (const item of result.tools) {
    const tool = toolSchema.safeParse(item)
    if (!tool.success) continue
    const title = tool.data.title ?? tool.data.annotations?.title
    const summary: IntegrationToolSummary = {
      name: tool.data.name,
      description: tool.data.description ?? '',
      readOnly: tool.data.annotations?.readOnlyHint === true,
      destructive: tool.data.annotations?.destructiveHint === true,
    }
    if (title) summary.title = title
    tools.push(summary)
  }
  return tools
}

type OAuthFinding =
  | { kind: 'advertised'; discover: string; registration: 'dynamic' | 'client-required' }
  | { kind: 'unusable'; reason: 'unavailable' | 'oauth_unusable' }
  | { kind: 'not-advertised' }

export async function probeMcpServer(url: string, options: ProbeOptions = {}): Promise<IntegrationProbeResult> {
  const signals: Signal[] = []
  const undetermined = (reason: UndeterminedReason): IntegrationProbeResult => ({ outcome: 'undetermined', reason, signals })
  const allowLoopback = options.allowLoopback ?? false
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  if (!URL.canParse(url)) return undetermined('refused')
  const endpoint = new URL(url)

  /** One request, without credentials; a 2xx answer to a request is read. */
  const send = async (target: URL, init: RequestInit): Promise<Response> => {
    await assertPublic(target, allowLoopback)
    try {
      return await fetch(target, { ...init, redirect: 'manual', signal })
    } catch {
      throw new ProbeRequestFailed(signal.aborted ? 'timeout' : 'unreachable')
    }
  }

  const post = async (message: { method: string; id?: number; params?: object }, headers?: SessionHeaders): Promise<Exchange> => {
    const response = await send(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    })
    const media = mediaOf(response.headers.get('content-type'))
    const ok = response.status >= 200 && response.status < 300
    let answer: z.infer<typeof jsonRpcResponseSchema> | null = null
    try {
      if (ok && message.id !== undefined) {
        answer = media === 'event-stream' ? await readEventStream(response, message.id) : matchingResponse(await readText(response), message.id)
      } else {
        await response.body?.cancel().catch(() => undefined)
      }
    } catch {
      if (signal.aborted) throw new ProbeRequestFailed('timeout')
    }
    const authenticate = response.headers.get('www-authenticate') ?? undefined
    const session = response.headers.get('mcp-session-id') ?? undefined
    const exchange: Exchange = {
      status: response.status,
      media,
      answer: answer === null ? 'none' : answer.result !== undefined ? 'result' : 'error',
    }
    if (answer?.result !== undefined) exchange.result = answer.result
    if (authenticate) exchange.authenticate = authenticate
    if (ok && session) exchange.session = session
    return exchange
  }

  /** A GET of one metadata document: its status and JSON, or why there is none. */
  const metadata = async (target: URL): Promise<{ status: number; document: unknown } | 'blocked' | 'failed'> => {
    try {
      const response = await send(target, { method: 'GET', headers: { accept: 'application/json' } })
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined)
        return { status: response.status, document: undefined }
      }
      try {
        return { status: 200, document: JSON.parse(await readText(response)) }
      } catch {
        return { status: 200, document: undefined }
      }
    } catch (error) {
      if (error instanceof ProbeRequestFailed && error.reason === 'timeout') throw error
      return error instanceof ProbeRequestFailed && error.reason === 'refused' ? 'blocked' : 'failed'
    }
  }

  /** Where an issuer publishes its metadata: RFC 8414, then OpenID Connect Discovery. */
  const issuerLocations = (issuer: URL): URL[] => {
    const path = issuer.pathname.replace(/\/$/, '')
    const at = (pathname: string) => new URL(pathname.replace('//', '/'), issuer.origin)
    const inserted = [at(`/.well-known/oauth-authorization-server${path}`), at(`/.well-known/openid-configuration${path}`)]
    return path === '' ? inserted : [...inserted, at(`${path}/.well-known/openid-configuration`)]
  }

  /** The authorization server's metadata, checked as a browser sign-in needs it. */
  const readIssuer = async (issuer: URL): Promise<{ found: { url: URL; registration: 'dynamic' | 'client-required' } } | { failed: 'missing' | 'invalid' | 'unsupported' | 'blocked' | 'unavailable' }> => {
    for (const location of issuerLocations(issuer)) {
      const answer = await metadata(location)
      if (answer === 'blocked') {
        signals.push({ kind: 'authorization-server-metadata', result: 'blocked' })
        return { failed: 'blocked' }
      }
      if (answer === 'failed' || answer.status === 429 || answer.status >= 500) {
        signals.push({ kind: 'authorization-server-metadata', result: 'missing' })
        return { failed: 'unavailable' }
      }
      if (answer.status !== 200) {
        signals.push({ kind: 'authorization-server-metadata', result: 'missing' })
        continue
      }
      const server = authorizationServerSchema.safeParse(answer.document)
      if (!server.success) {
        signals.push({ kind: 'authorization-server-metadata', result: 'invalid' })
        return { failed: 'invalid' }
      }
      // Solus always sends PKCE with S256. A list without it is refused; an
      // absent list still gets S256, as Executor does for Entra ID and Apple.
      const pkce = server.data.code_challenge_methods_supported
      if (!server.data.response_types_supported.includes('code') || (pkce && !pkce.includes('S256'))) {
        signals.push({ kind: 'authorization-server-metadata', result: 'unsupported' })
        return { failed: 'unsupported' }
      }
      signals.push({ kind: 'authorization-server-metadata', result: 'ok' })
      return { found: { url: location, registration: server.data.registration_endpoint ? 'dynamic' : 'client-required' } }
    }
    return { failed: 'missing' }
  }

  /** Where to look for resource metadata: the document a challenge names, else the path-suffixed and root well-known documents. */
  const resourceLocations = (advertised: string | undefined): URL[] | OAuthFinding => {
    if (advertised !== undefined) {
      if (!URL.canParse(advertised)) {
        signals.push({ kind: 'resource-metadata', result: 'invalid' })
        return { kind: 'unusable', reason: 'oauth_unusable' }
      }
      return [new URL(advertised)]
    }
    const root = new URL('/.well-known/oauth-protected-resource', endpoint.origin)
    return endpoint.pathname === '/' ? [root] : [new URL(`/.well-known/oauth-protected-resource${endpoint.pathname.replace(/\/$/, '')}`, endpoint.origin), root]
  }

  /** One resource metadata document checked against the endpoint: the issuer it names, or why it cannot be used. */
  const checkResource = (document: z.infer<typeof resourceMetadataSchema> | null): URL | OAuthFinding => {
    if (!document || !URL.canParse(document.resource) || !URL.canParse(document.authorization_servers[0])) {
      signals.push({ kind: 'resource-metadata', result: 'invalid' })
      return { kind: 'unusable', reason: 'oauth_unusable' }
    }
    // A resource can cover /mcp from the origin root, but not a sibling service or another host.
    const resource = new URL(document.resource)
    const prefix = resource.pathname.endsWith('/') ? resource.pathname : `${resource.pathname}/`
    if (resource.origin !== endpoint.origin || (resource.pathname !== endpoint.pathname && !endpoint.pathname.startsWith(prefix))) {
      signals.push({ kind: 'resource-metadata', result: 'mismatch' })
      return { kind: 'unusable', reason: 'oauth_unusable' }
    }
    signals.push({ kind: 'resource-metadata', result: 'ok' })
    return new URL(document.authorization_servers[0])
  }

  /** The first usable resource metadata document, null when none is published, or why OAuth cannot be used. */
  const readResource = async (locations: URL[], advertised: boolean): Promise<{ url: URL; issuer: URL } | OAuthFinding | null> => {
    for (const location of locations) {
      const answer = await metadata(location)
      if (answer === 'blocked') {
        signals.push({ kind: 'resource-metadata', result: 'blocked' })
        return { kind: 'unusable', reason: 'oauth_unusable' }
      }
      if (answer === 'failed' || answer.status === 429 || answer.status >= 500) {
        signals.push({ kind: 'resource-metadata', result: 'missing' })
        return { kind: 'unusable', reason: 'unavailable' }
      }
      if (answer.status !== 200) {
        signals.push({ kind: 'resource-metadata', result: 'missing' })
        // A challenge names its own document, so a missing one is a failure.
        if (advertised) return { kind: 'unusable', reason: 'oauth_unusable' }
        continue
      }
      const parsed = resourceMetadataSchema.safeParse(answer.document)
      const issuer = checkResource(parsed.success ? parsed.data : null)
      if (!(issuer instanceof URL)) return issuer
      return { url: location, issuer }
    }
    return null
  }

  /** The authorization server named by the resource metadata, or, without it, the endpoint's own. */
  const decideIssuer = async (found: { url: URL; issuer: URL } | null): Promise<OAuthFinding> => {
    let issuer = await readIssuer(found ? found.issuer : endpoint)
    if (!found && 'failed' in issuer && issuer.failed === 'missing' && endpoint.pathname !== '/') {
      issuer = await readIssuer(new URL(endpoint.origin))
    }
    if ('found' in issuer) return { kind: 'advertised', discover: (found?.url ?? issuer.found.url).href, registration: issuer.found.registration }
    // Without resource metadata, a missing authorization server means no OAuth at all.
    if (issuer.failed === 'missing' && !found) return { kind: 'not-advertised' }
    return { kind: 'unusable', reason: issuer.failed === 'unavailable' ? 'unavailable' : 'oauth_unusable' }
  }

  /**
   * What the server advertises about OAuth: the resource metadata its challenge
   * names, else the path-suffixed and root well-known documents, then the
   * authorization server they name. `originFallback` is MCP's earlier rule for a
   * server that rejects anonymous use but publishes no resource metadata: it is
   * its own authorization server.
   */
  const inspectOAuth = async (authenticate: string | undefined, originFallback: boolean): Promise<OAuthFinding> => {
    const advertised = bearerParams(authenticate)?.get('resource_metadata')
    const locations = resourceLocations(advertised)
    if (!Array.isArray(locations)) return locations
    const found = await readResource(locations, advertised !== undefined)
    if (found && 'kind' in found) return found
    if (!found && !originFallback) return { kind: 'not-advertised' }
    return decideIssuer(found)
  }

  /** Anonymous use was rejected: OAuth the server advertises, or other credentials. */
  const rejected = async (exchange: Exchange): Promise<IntegrationProbeResult> => {
    const challenge = challengeOf(exchange.authenticate)
    // A 403 without a challenge may come from a firewall rather than the server's sign-in.
    const signIn = exchange.status === 401 || challenge !== undefined
    const oauth = await inspectOAuth(exchange.authenticate, signIn)
    if (oauth.kind === 'advertised') {
      return { outcome: 'oauth', auth: { kind: 'oauth', discover: oauth.discover, registration: oauth.registration }, signals }
    }
    if (oauth.kind === 'unusable') return undetermined(oauth.reason)
    if (!signIn && exchange.media === 'html') return undetermined('refused')
    const scheme = challenge?.scheme ?? 'unspecified'
    return { outcome: 'credentials-required', auth: { kind: 'bearer', scheme }, signals }
  }

  /** A request that did not succeed: a sign-in rejection, or why nothing could be decided. */
  const unsuccessful = (exchange: Exchange, otherwise: UndeterminedReason): Promise<IntegrationProbeResult> | IntegrationProbeResult => {
    if (exchange.status === 401 || exchange.status === 403) return rejected(exchange)
    if (exchange.status === 429 || exchange.status >= 500) return undetermined('unavailable')
    if (exchange.status >= 300 && exchange.status < 400) return undetermined('redirected')
    // A web page or plain-text error is a refusal, not an MCP server's answer.
    if (exchange.status >= 400 && (exchange.media === 'html' || exchange.media === 'text')) return undetermined('refused')
    return undetermined(otherwise)
  }

  let session: string | undefined
  try {
    const initialized = await post({
      method: 'initialize',
      id: 1,
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'solus', version: '1.0.0' } },
    })
    signals.push(signalOf('initialize', initialized))
    if (!successful(initialized)) return await unsuccessful(initialized, 'not_mcp')
    session = initialized.session
    if (initialized.answer === 'error') return undetermined('initialize_error')
    const negotiated = initializeResultSchema.safeParse(initialized.result)
    if (!negotiated.success) return undetermined('not_mcp')
    const headers: SessionHeaders = { 'mcp-protocol-version': negotiated.data.protocolVersion }
    if (session) headers['mcp-session-id'] = session
    await post({ method: 'notifications/initialized' }, headers)
    const tools = await post({ method: 'tools/list', id: 2 }, headers)
    signals.push(signalOf('tools/list', tools))
    if (!successful(tools)) return await unsuccessful(tools, 'tools_error')
    if (tools.answer !== 'result') return undetermined('tools_error')
    // A public server may still advertise OAuth, on a challenge or in its metadata.
    const oauth = await inspectOAuth(tools.authenticate ?? initialized.authenticate, false)
    const auth: IntegrationAuth = oauth.kind === 'advertised' ? { kind: 'none', oauth: { discover: oauth.discover } } : { kind: 'none' }
    const listed = toolsResultSchema.safeParse(tools.result)
    return { outcome: 'anonymous', auth, tools: listed.success ? toolSummaries(listed.data) : [], signals }
  } catch (error) {
    if (error instanceof ProbeRequestFailed) return undetermined(error.reason)
    throw error
  } finally {
    // A public server can allocate a session for this check; release it.
    if (session && !signal.aborted) {
      void fetch(endpoint, {
        method: 'DELETE',
        redirect: 'manual',
        headers: { 'mcp-session-id': session, 'mcp-protocol-version': PROTOCOL_VERSION },
        signal: AbortSignal.timeout(1_000),
      }).then((response) => response.body?.cancel(), () => undefined).catch(() => undefined)
    }
  }
}
