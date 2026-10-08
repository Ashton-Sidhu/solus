import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { probeMcpServer } from '@solus/server/integrations/probe'

// docs/plans/mcp-integrations.md §3.2: the probe decides how an integration
// authenticates from what the server answers without credentials. Each case is
// one fake server path on a loopback port.

interface RpcMessage { id?: number; method: string }

const TOOLS = [
  { name: 'read_wiki', title: 'Read wiki', description: 'Read a page', annotations: { readOnlyHint: true } },
  { name: 'delete_page', annotations: { destructiveHint: true } },
]

let server: ReturnType<typeof Bun.serve>
let base: string

function rpcResult(id: number | undefined, result: object): Response {
  return Response.json({ jsonrpc: '2.0', id, result })
}

/** A working MCP server: JSON for initialize, an event stream for tools/list. */
async function anonymousServer(request: Request): Promise<Response> {
  const message = await request.json() as RpcMessage
  if (message.method === 'initialize') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } } }), {
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
    })
  }
  if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
  if (request.headers.get('mcp-session-id') !== 'session-1') return new Response('no session', { status: 400 })
  const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })}\n\n`
  return new Response(event, { headers: { 'content-type': 'text/event-stream' } })
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      switch (url.pathname) {
        case '/anonymous/mcp':
          if (request.method === 'DELETE') return new Response(null, { status: 204 })
          return anonymousServer(request)
        case '/oauth/mcp':
          return new Response('sign in', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/oauth/mcp"` } })
        case '/.well-known/oauth-protected-resource/oauth/mcp':
          return Response.json({ resource: `${base}/oauth/mcp`, authorization_servers: [`${base}/issuer`] })
        case '/.well-known/oauth-authorization-server/issuer':
          return Response.json({
            issuer: `${base}/issuer`,
            authorization_endpoint: `${base}/issuer/authorize`,
            token_endpoint: `${base}/issuer/token`,
            registration_endpoint: `${base}/issuer/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          })
        case '/key/mcp':
          return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer realm="api"' } })
        case '/page':
          return new Response('<html><body>Hello</body></html>', { headers: { 'content-type': 'text/html' } })
        case '/slow/mcp':
          await Bun.sleep(2_000)
          return new Response(null, { status: 500 })
        case '/moved/mcp':
          return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/mcp' } })
        default:
          return new Response('not found', { status: 404 })
      }
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

const options = { allowLoopback: true }

describe('MCP probe', () => {
  test('a server that initializes and lists tools anonymously is anonymous, with its tool hints', async () => {
    // WHY: an anonymous server works for everyone without a connection.
    const result = await probeMcpServer(`${base}/anonymous/mcp`, options)
    expect(result.outcome).toBe('anonymous')
    if (result.outcome !== 'anonymous') return
    expect(result.auth).toEqual({ kind: 'none' })
    expect(result.tools).toEqual([
      { name: 'read_wiki', title: 'Read wiki', description: 'Read a page', readOnly: true, destructive: false },
      { name: 'delete_page', description: '', readOnly: false, destructive: true },
    ])
    expect(result.signals.filter((signal) => signal.kind === 'request')).toEqual([
      { kind: 'request', method: 'initialize', status: 200, media: 'json', answer: 'result' },
      { kind: 'request', method: 'tools/list', status: 200, media: 'event-stream', answer: 'result' },
    ])
  })

  test('a 401 whose challenge names resource metadata with dynamic registration is oauth/dynamic', async () => {
    const result = await probeMcpServer(`${base}/oauth/mcp`, options)
    expect(result).toMatchObject({
      outcome: 'oauth',
      auth: { kind: 'oauth', registration: 'dynamic', discover: `${base}/.well-known/oauth-protected-resource/oauth/mcp` },
    })
    expect(result.signals).toContainEqual({ kind: 'resource-metadata', result: 'ok' })
    expect(result.signals).toContainEqual({ kind: 'authorization-server-metadata', result: 'ok' })
  })

  test('a 401 without OAuth metadata asks for credentials with the challenge scheme', async () => {
    // WHY: a person pastes a key; the agent must never ask for one in chat.
    const result = await probeMcpServer(`${base}/key/mcp`, options)
    expect(result).toMatchObject({ outcome: 'credentials-required', auth: { kind: 'bearer', scheme: 'bearer' } })
    expect(result.signals[0]).toEqual({ kind: 'request', method: 'initialize', status: 401, media: 'text', answer: 'none', challenge: { scheme: 'bearer', resourceMetadata: false, scope: false } })
  })

  test('a web page is not an MCP server', async () => {
    expect(await probeMcpServer(`${base}/page`, options)).toMatchObject({ outcome: 'undetermined', reason: 'not_mcp' })
  })

  test('a server that does not answer in time is a timeout', async () => {
    expect(await probeMcpServer(`${base}/slow/mcp`, { ...options, timeoutMs: 200 })).toMatchObject({ outcome: 'undetermined', reason: 'timeout' })
  })

  test('a redirect is not followed', async () => {
    // WHY: following a redirect would let a server point the probe at another host.
    expect(await probeMcpServer(`${base}/moved/mcp`, options)).toMatchObject({ outcome: 'undetermined', reason: 'redirected' })
  })

  test('a loopback or private address is refused unless loopback is allowed', async () => {
    // WHY: the probe runs with the host's egress and must not reach its private network.
    expect(await probeMcpServer(`${base}/anonymous/mcp`)).toMatchObject({ outcome: 'undetermined', reason: 'refused', signals: [] })
    expect(await probeMcpServer('https://10.0.0.5/mcp', options)).toMatchObject({ outcome: 'undetermined', reason: 'refused' })
    expect(await probeMcpServer('https://[fe80::1]/mcp', options)).toMatchObject({ outcome: 'undetermined', reason: 'refused' })
  })

  test('signals never carry a URL or a body', async () => {
    const results = await Promise.all(['/anonymous/mcp', '/oauth/mcp', '/key/mcp'].map((path) => probeMcpServer(`${base}${path}`, options)))
    for (const result of results) expect(JSON.stringify(result.signals)).not.toContain('127.0.0.1')
  })
})
