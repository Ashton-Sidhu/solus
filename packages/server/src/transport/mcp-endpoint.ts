import { createMcpHandler } from '@modelcontextprotocol/server'
import { actorFor } from '../admission/actor'
import { verifyAppToken, type AppGrant } from '../admission/auth'
import { appAccessChecks } from '../admission/app-sign-in'
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

/**
 * An app acts as the person who approved it (plans/035 §0.3): the host's owner,
 * as a paired device does, or an organization member with the role they had at
 * approval. Its access bounds what it may call.
 */
function appPrincipal(app: AppGrant): Principal {
  const approver = app.approver
  if (approver.kind === 'owner') return { kind: 'owner', via: 'local', deviceId: app.deviceId, deviceLabel: app.deviceLabel, expiresAt: null }
  return {
    kind: 'org-member', userId: approver.userId, organizationId: approver.organizationId, organizationRole: approver.organizationRole,
    teamIds: approver.teamIds, hostKind: approver.hostKind, displayName: approver.displayName,
    deviceId: app.deviceId, deviceLabel: app.deviceLabel, expiresAt: Number.MAX_SAFE_INTEGER,
  }
}

/** Why the app may not call now: its organization no longer allows it, or its member lost access. */
async function appRefusal(app: AppGrant): Promise<string | null> {
  const checks = appAccessChecks()
  const denied = checks.appDenial(app.appId, app.approver)
  if (denied) return denied
  if (app.approver.kind === 'member' && !await checks.memberHasAccess(app.approver)) return 'The person who approved this app no longer has access to this host.'
  return null
}

const appHandler = createMcpHandler(({ authInfo, requestInfo }) => {
  // Checked again here: the grant may have been revoked since the request was admitted.
  const app = authInfo ? verifyAppToken(authInfo.token) : null
  if (!app) throw new Error('This app is not signed in.')
  return appToolServer({ grantId: app.deviceId, access: app.access, actor: actorFor(appPrincipal(app)), signal: requestInfo?.signal ?? new AbortController().signal })
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
  const refusal = await appRefusal(app)
  if (refusal) return Response.json({ error: 'forbidden', error_description: refusal }, { status: 403 })
  return appHandler.fetch(request, { authInfo: { token, clientId: app.deviceId, scopes: [app.access] } })
}
