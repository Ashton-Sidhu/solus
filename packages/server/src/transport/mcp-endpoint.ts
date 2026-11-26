import { createMcpHandler } from '@modelcontextprotocol/server'
import { isRunToolToken, runToolBindingFor, runToolServer } from '../execution/agents/tools/agent-tool-endpoint'

/**
 * The host's MCP endpoint, `/mcp` (plans/035 §3). One handler serves every
 * caller; each request gets a fresh server with its caller's tools. A run's
 * harness calls it with the run's token.
 */
const handler = createMcpHandler(({ authInfo }) => runToolServer(authInfo ? runToolBindingFor(authInfo.token) : undefined), {
  // A stream keeps a long call (request_secret waits up to an hour) alive through idle timeouts.
  responseMode: 'sse',
})

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')
  return match?.[1] ?? null
}

export async function serveMcp(request: Request): Promise<Response> {
  // A browser page may not call the endpoint: an agent's client sends no Origin (DNS rebinding, CSRF).
  if (request.headers.has('origin')) return Response.json({ error: 'forbidden' }, { status: 403 })
  const token = bearerToken(request)
  if (!token || !isRunToolToken(token)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
  }
  return handler.fetch(request, { authInfo: { token, clientId: 'solus-run', scopes: [] } })
}
