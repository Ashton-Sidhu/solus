import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

/**
 * One loopback HTTP server that plays both sides of an MCP sign-in: an MCP
 * server that accepts only the credentials in `accepted`, its protected-resource
 * metadata, and an authorization server with registration, a token endpoint,
 * and revocation. Codes are issued by the test with `issueCode`, as a browser
 * would bring them back.
 */

interface IssuedCode {
  challenge: string
  resource: string | null
  redirectUri: string | null
}

export interface FakeServers {
  base: string
  mcpUrl: string
  resourceMetadataUrl: string
  /** Authorization header values the MCP server accepts. */
  accepted: Set<string>
  registrations: Array<{ redirect_uris: string[]; token_endpoint_auth_method?: string }>
  tokenRequests: URLSearchParams[]
  revoked: string[]
  /** Every Authorization header the MCP endpoint saw. */
  mcpAuthorizations: Array<string | undefined>
  /** Whether the authorization server offers dynamic registration. */
  options: { registration: boolean; refuseRefresh: boolean; expiresIn: number }
  issueCode(challenge: string, resource: string | null, redirectUri: string | null): string
  close(): Promise<void>
}

const parsedRegistration = z.object({ redirect_uris: z.array(z.string()), token_endpoint_auth_method: z.string().optional() })

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startFakeServers(): Promise<FakeServers> {
  const codes = new Map<string, IssuedCode>()
  const refreshTokens = new Set<string>()
  let counter = 0
  const fake: Omit<FakeServers, 'base' | 'mcpUrl' | 'resourceMetadataUrl' | 'close'> = {
    accepted: new Set(),
    registrations: [],
    tokenRequests: [],
    revoked: [],
    mcpAuthorizations: [],
    options: { registration: true, refuseRefresh: false, expiresIn: 3600 },
    issueCode(challenge, resource, redirectUri) {
      const code = `code-${++counter}`
      codes.set(code, { challenge, resource, redirectUri })
      return code
    },
  }
  let base = ''

  const issueToken = (res: ServerResponse) => {
    const accessToken = `access-${++counter}`
    const refreshToken = `refresh-${counter}`
    fake.accepted.add(`Bearer ${accessToken}`)
    refreshTokens.add(refreshToken)
    json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: fake.options.expiresIn, refresh_token: refreshToken })
  }

  const token = (res: ServerResponse, form: URLSearchParams) => {
    fake.tokenRequests.push(form)
    if (form.get('grant_type') === 'authorization_code') {
      const issued = codes.get(form.get('code') ?? '')
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
      if (!issued || issued.challenge !== challenge || issued.redirectUri !== form.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' })
      codes.delete(form.get('code') ?? '')
      return issueToken(res)
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (fake.options.refuseRefresh || !refreshTokens.has(form.get('refresh_token') ?? '')) return json(res, 400, { error: 'invalid_grant' })
      return issueToken(res)
    }
    return json(res, 400, { error: 'unsupported_grant_type' })
  }

  const mcp = async (req: IncomingMessage, res: ServerResponse) => {
    const authorization = req.headers.authorization
    fake.mcpAuthorizations.push(authorization)
    if (!authorization || !fake.accepted.has(authorization)) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` })
      res.end()
      return
    }
    const text = req.method === 'POST' ? await readBody(req) : ''
    const server = new McpServer({ name: 'fake-mcp', title: 'Fake MCP', version: '1.0.0' })
    server.registerTool('echo', { description: 'Echo.', inputSchema: { text: z.string() } }, async ({ text: value }) => ({ content: [{ type: 'text', text: value }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    res.on('close', () => { void transport.close(); void server.close() })
    await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined)
  }

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', base).pathname
    if (path === '/mcp') return mcp(req, res)
    if (path === '/.well-known/oauth-protected-resource') {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [`${base}/as`], scopes_supported: ['read', 'write'] })
    }
    if (path === '/.well-known/oauth-authorization-server/as') {
      const metadata = {
        issuer: `${base}/as`,
        authorization_endpoint: `${base}/as/authorize`,
        token_endpoint: `${base}/as/token`,
        revocation_endpoint: `${base}/as/revoke`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      }
      return json(res, 200, fake.options.registration ? { ...metadata, registration_endpoint: `${base}/as/register` } : metadata)
    }
    if (path === '/as/register' && req.method === 'POST') {
      const registration = parsedRegistration.parse(JSON.parse(await readBody(req)))
      fake.registrations.push(registration)
      return json(res, 201, { client_id: `client-${fake.registrations.length}`, token_endpoint_auth_method: 'none' })
    }
    if (path === '/as/token' && req.method === 'POST') return token(res, new URLSearchParams(await readBody(req)))
    if (path === '/as/revoke' && req.method === 'POST') {
      fake.revoked.push(new URLSearchParams(await readBody(req)).get('token') ?? '')
      res.writeHead(200)
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  }

  const http: Server = createServer((req, res) => { void route(req, res) })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  // SAFETY: a listening TCP server's address is an AddressInfo.
  const { port } = http.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
  return {
    ...fake,
    base,
    mcpUrl: `${base}/mcp`,
    resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource`,
    async close() {
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}
