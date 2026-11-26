import { createMcpHandler } from '@modelcontextprotocol/server'
import { actorFor } from '../admission/actor'
import { verifyAppToken } from '../admission/auth'
import type { Principal } from '../admission/principal'
import { appToolServer, isRunToolToken, runToolBindingFor, runToolServer } from '../execution/agents/tools/agent-tool-endpoint'
import { publicOrigin } from './mcp-oauth'

/**
 * The host's MCP endpoint, `/mcp` (plans/035 §3). One handler serves every
 * caller; each request gets a fresh server with its caller's tools. A run's
 * harness calls it with the run's token, an outside app with its grant.
 */
const runHandler = createMcpHandler(({ authInfo }) => runToolServer(authInfo ? runToolBindingFor(authInfo.token) : undefined), {
  // A stream keeps a long call (request_secret waits up to an hour) alive through idle timeouts.
  responseMode: 'sse',
})

/** An app's grant acts as the host's owner, as a paired device does; its access bounds what it may call. */
function appPrincipal(deviceId: string, deviceLabel: string): Principal {
  return { kind: 'owner', via: 'local', deviceId, deviceLabel, expiresAt: null }
}

const appHandler = createMcpHandler(({ authInfo, requestInfo }) => {
  // Checked again here: the grant may have been revoked since the request was admitted.
  const app = authInfo ? verifyAppToken(authInfo.token) : null
  if (!app) throw new Error('This app is not signed in.')
  return appToolServer({ access: app.access, actor: actorFor(appPrincipal(app.deviceId, app.deviceLabel)), signal: requestInfo?.signal ?? new AbortController().signal })
}, { responseMode: 'sse' })

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')
  return match?.[1] ?? null
}

export interface ServeMcpOptions {
  /** Outside apps may sign in on this host. */
  appsSignIn: boolean
}

export async function serveMcp(request: Request, options: ServeMcpOptions = { appsSignIn: false }): Promise<Response> {
  // A browser page may not call the endpoint: an agent's client sends no Origin (DNS rebinding, CSRF).
  if (request.headers.has('origin')) return Response.json({ error: 'forbidden' }, { status: 403 })
  const token = bearerToken(request)
  if (token && isRunToolToken(token)) return runHandler.fetch(request, { authInfo: { token, clientId: 'solus-run', scopes: [] } })
  const app = token && options.appsSignIn ? verifyAppToken(token) : null
  if (!token || !app) {
    // An outside app learns where to sign in (RFC 9728).
    const challenge = options.appsSignIn ? `Bearer resource_metadata="${publicOrigin(request)}/.well-known/oauth-protected-resource/mcp"` : 'Bearer'
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'WWW-Authenticate': challenge } })
  }
  return appHandler.fetch(request, { authInfo: { token, clientId: app.deviceId, scopes: [app.access] } })
}
