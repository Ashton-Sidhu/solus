import { randomInt } from 'node:crypto'
import { z } from 'zod'
import { formatCheckCode } from '@solus/contracts/add-machine'
import type { AppAccess } from '@solus/contracts/host-api'
import { issueAppToken, revokeAppToken } from '../admission/auth'
import {
  appAccessChecks,
  appOfClient,
  approvedRedirect,
  redeemCode,
  registerClient,
  registeredClient,
  spendAppPairingCode,
  withdrawRedirect,
  type AuthorizationRequest,
} from '../admission/app-sign-in'
import type { PairApprovals } from '../admission/pair-approvals'
import { createTokenBucketRateLimiter } from './rate-limit'

/**
 * The host's OAuth server for outside apps (plans/035 §10): metadata, client
 * registration, the consent page, the approval, and the token. The host is
 * also the resource server: its `/mcp` takes the tokens it issues here.
 */
export interface McpOAuthOptions {
  pairApprovals?: PairApprovals
  /** The request came through the public tunnel: only the owner's pairing code approves there. */
  viaTunnel: boolean
  remoteAddress: string
  hostName: string
}

/** Guessing a pairing code costs a request; a person types a few. */
const codeAttempts = createTokenBucketRateLimiter(10, 60_000)

const accessSchema = z.enum(['read', 'write', 'full'])
const authorizeSchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(1024).optional(),
})
const approveSchema = authorizeSchema.extend({
  access: accessSchema,
  pairing_code: z.string().max(16).optional(),
})
const waitSchema = z.object({ requestId: z.string().min(1), waitToken: z.string().min(1) })
const registerSchema = z.object({ client_name: z.string().max(200).optional(), redirect_uris: z.array(z.string().min(1)).min(1).max(8) })
const tokenSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  redirect_uri: z.string().min(1),
  client_id: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
})

/** The origin the app reached: the tunnel and Tailscale Serve name the public one. */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url)
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host
  const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${host}`
}

/** The protected resource's metadata (RFC 9728), which a 401 from `/mcp` names. */
export function protectedResourceMetadata(request: Request): Response {
  const origin = publicOrigin(request)
  return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'], resource_name: 'Solus' })
}

export function authorizationServerMetadata(request: Request): Response {
  const origin = publicOrigin(request)
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/mcp/authorize`,
    token_endpoint: `${origin}/oauth/mcp/token`,
    registration_endpoint: `${origin}/oauth/mcp/register`,
    revocation_endpoint: `${origin}/oauth/mcp/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['read', 'write', 'full'],
  })
}

/** A redirect address an app may use: not a page that runs in the browser that holds the code. */
function allowedRedirect(uri: string): boolean {
  if (!URL.canParse(uri)) return false
  return !['javascript:', 'data:', 'file:', 'blob:', 'vbscript:'].includes(new URL(uri).protocol)
}

function oauthError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status })
}

/** The sign-in a request describes, when its client is registered here and names one of its redirect addresses. */
function signInOf(params: z.infer<typeof authorizeSchema>, access: AppAccess): AuthorizationRequest | null {
  const client = registeredClient(params.client_id)
  if (!client || !client.redirectUris.includes(params.redirect_uri)) return null
  return { clientId: params.client_id, appName: client.name, app: appOfClient(client), redirectUri: params.redirect_uri, codeChallenge: params.code_challenge, state: params.state ?? null, access }
}

/** A request's body, parsed by its route's schema: JSON, or a form as OAuth's token and revoke routes take. Null when it does not parse. */
async function parsedBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
  const type = request.headers.get('content-type') ?? ''
  try {
    const raw = type.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(await request.text())) : await request.json()
    const parsed = schema.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * The consent page's own calls: JSON from its origin. A page on another site
 * cannot send JSON here without a preflight this host refuses, and a form post
 * is refused, so it cannot start an approval in the person's name.
 */
function fromConsentPage(request: Request): boolean {
  const origin = request.headers.get('origin')
  return (request.headers.get('content-type') ?? '').includes('application/json') && (origin === null || origin === publicOrigin(request))
}

async function register(request: Request): Promise<Response> {
  const parsed = await parsedBody(request, registerSchema)
  if (!parsed || !parsed.redirect_uris.every(allowedRedirect)) return oauthError('invalid_redirect_uri', 'Send redirect_uris as absolute addresses an app can receive a code at.')
  const name = parsed.client_name ?? 'MCP app'
  return Response.json({
    client_id: registerClient(name, parsed.redirect_uris),
    client_name: name,
    redirect_uris: parsed.redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  }, { status: 201 })
}

function authorize(request: Request, options: McpOAuthOptions): Response {
  const params = authorizeSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  const signIn = params.success ? signInOf(params.data, 'write') : null
  if (!params.success || !signIn) return consentError('This sign-in link is not valid. Start the connection again from the app.')
  const html = consentPage(signIn.appName, options.hostName, params.data, !options.viaTunnel && !!options.pairApprovals)
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' } })
}

async function approve(request: Request, options: McpOAuthOptions): Promise<Response> {
  const parsed = await parsedBody(request, approveSchema)
  const signIn = parsed ? signInOf(parsed, parsed.access) : null
  if (!parsed || !signIn) return Response.json({ error: 'This sign-in is not valid.' }, { status: 400 })
  if (parsed.pairing_code !== undefined) {
    if (!codeAttempts.allow(options.remoteAddress)) return Response.json({ error: 'Too many attempts. Wait a minute.' }, { status: 429 })
    const approver = spendAppPairingCode(parsed.pairing_code)
    if (!approver) return Response.json({ error: 'That pairing code is not valid. Make a new one in Solus.' }, { status: 403 })
    // The person's organization may allow only some apps (plans/035 §10).
    const denied = appAccessChecks().appDenial(signIn.app, approver)
    if (denied) return Response.json({ error: denied }, { status: 403 })
    return Response.json({ redirect: approvedRedirect(signIn, approver) })
  }
  // Pairing is local authorization: through the public tunnel, only the owner's pairing code approves.
  if (options.viaTunnel || !options.pairApprovals) return Response.json({ error: 'Use a pairing code from Solus.' }, { status: 403 })
  // Approval in the Solus app is the owner's.
  const denied = appAccessChecks().appDenial(signIn.app, { kind: 'owner' })
  if (denied) return Response.json({ error: denied }, { status: 403 })
  const checkCode = formatCheckCode((n) => randomInt(n))
  const started = options.pairApprovals.start({
    deviceLabel: `${signIn.appName} (MCP app, ${signIn.access} access)`,
    checkCode,
    fromAddress: options.remoteAddress,
    grant: { issue: () => approvedRedirect(signIn, { kind: 'owner' }), withdraw: withdrawRedirect },
  })
  if (!started) return Response.json({ error: 'Too many open requests. Try again later.' }, { status: 429 })
  return Response.json({ requestId: started.request.requestId, waitToken: started.waitToken, checkCode, expiresAt: started.request.expiresAt })
}

async function approvalWait(request: Request, options: McpOAuthOptions): Promise<Response> {
  const parsed = await parsedBody(request, waitSchema)
  if (!parsed || !options.pairApprovals) return Response.json({ status: 'expired' })
  const outcome = await options.pairApprovals.wait(parsed.requestId, parsed.waitToken, request.signal)
  return Response.json(outcome.status === 'approved' ? { status: 'approved', redirect: outcome.granted } : outcome)
}

async function token(request: Request): Promise<Response> {
  const parsed = await parsedBody(request, tokenSchema)
  if (!parsed) return oauthError('invalid_request', 'Send grant_type=authorization_code with code, redirect_uri, client_id, and code_verifier.')
  const signIn = redeemCode(parsed.code, parsed.client_id, parsed.redirect_uri, parsed.code_verifier)
  if (!signIn) return oauthError('invalid_grant', 'The code is not valid, was used, or does not match this client.')
  // A policy may have changed since the approval.
  const denied = appAccessChecks().appDenial(signIn.app, signIn.approver)
  if (denied) return oauthError('access_denied', denied)
  const issued = issueAppToken(signIn.appName, signIn.app, signIn.access, signIn.approver)
  return Response.json({ access_token: issued.token, token_type: 'Bearer', scope: signIn.access }, { headers: { 'cache-control': 'no-store' } })
}

async function revoke(request: Request): Promise<Response> {
  const parsed = await parsedBody(request, z.object({ token: z.string().min(1) }))
  if (parsed) revokeAppToken(parsed.token)
  // RFC 7009: an unknown token is not an error.
  return new Response(null, { status: 200 })
}

export async function serveMcpOAuth(request: Request, options: McpOAuthOptions): Promise<Response> {
  const { pathname } = new URL(request.url)
  const route = `${request.method} ${pathname}`
  if (route === 'POST /oauth/mcp/approve' || route === 'POST /oauth/mcp/approve/wait') {
    if (!fromConsentPage(request)) return Response.json({ error: 'forbidden' }, { status: 403 })
    return route === 'POST /oauth/mcp/approve' ? approve(request, options) : approvalWait(request, options)
  }
  if (route === 'POST /oauth/mcp/register') return register(request)
  if (route === 'GET /oauth/mcp/authorize') return authorize(request, options)
  if (route === 'POST /oauth/mcp/token') return token(request)
  if (route === 'POST /oauth/mcp/revoke') return revoke(request)
  return Response.json({ error: 'not found' }, { status: 404 })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function consentError(message: string): Response {
  return new Response(page('Solus', `<h1>Cannot connect</h1><p>${escapeHtml(message)}</p>`, ''), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function page(title: string, main: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--border:#e7e5e4;--accent:#c2410c;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--border:#292524;--accent:#fb923c;--accent-fg:#1c1917}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}label{display:flex;gap:8px;align-items:flex-start;padding:8px 0;cursor:pointer}
label span{display:block}label small{color:var(--muted)}fieldset{border:0;padding:0;margin:0 0 16px}
button{width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--fg);font:inherit;cursor:pointer;margin-top:8px}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}button:disabled{opacity:.6;cursor:default}
input[type=text]{width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font:inherit;letter-spacing:.1em;text-transform:uppercase}
.code{font:600 22px/1 ui-monospace,monospace;letter-spacing:.15em;text-align:center;padding:12px;border:1px dashed var(--border);border-radius:8px;margin:8px 0 12px}
.hidden{position:absolute;left:-9999px}.status{min-height:1.5em;margin-top:12px;color:var(--muted)}.or{text-align:center;color:var(--muted);margin:12px 0 4px;font-size:13px}
</style></head><body><main>${main}</main>${script ? `<script>${script}</script>` : ''}</body></html>`
}

function consentPage(appName: string, hostName: string, params: z.infer<typeof authorizeSchema>, canAskInApp: boolean): string {
  const app = escapeHtml(appName)
  const main = `<h1>${app} wants to use Solus</h1>
<p>It will reach the tools of <strong>${escapeHtml(hostName)}</strong> as you. You can revoke it in Settings → Connections.</p>
<fieldset><legend class="hidden">Access</legend>
<label><input type="radio" name="access" value="read"><span>Read<small><br>See works, projects, tasks, automations, and sessions.</small></span></label>
<label><input type="radio" name="access" value="write" checked><span>Read and write<small><br>Also start sessions and change records.</small></span></label>
<label><input type="radio" name="access" value="full"><span>Full<small><br>Also run tools that ask for approval in Solus.</small></span></label>
</fieldset>
${canAskInApp ? `<button class="primary" id="ask">Approve in the Solus app</button><div id="check" hidden><p>Approve the request in Solus. Check that it shows this code:</p><div class="code" id="checkCode"></div></div><div class="or">or</div>` : ''}
<input type="text" id="pairing" placeholder="Pairing code" autocomplete="one-time-code" maxlength="9">
<button${canAskInApp ? '' : ' class="primary"'} id="usePairing">Use pairing code</button>
<p class="status" id="status" role="status"></p>`
  const script = `const request=${JSON.stringify(params).replace(/</g, '\\u003c')};
const status=document.getElementById('status');
const access=()=>document.querySelector('input[name=access]:checked').value;
const post=(path,data)=>fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).then(async(r)=>({ok:r.ok,body:await r.json()}));
const go=(redirect)=>{status.textContent='Approved. Returning to the app…';location.href=redirect};
document.getElementById('usePairing').onclick=async()=>{const code=document.getElementById('pairing').value;if(!code){status.textContent='Make a pairing code in Solus: Settings → Connections.';return}
const r=await post('/oauth/mcp/approve',{...request,access:access(),pairing_code:code});if(r.ok)go(r.body.redirect);else status.textContent=r.body.error};
const ask=document.getElementById('ask');if(ask)ask.onclick=async()=>{ask.disabled=true;const r=await post('/oauth/mcp/approve',{...request,access:access()});
if(!r.ok){status.textContent=r.body.error;ask.disabled=false;return}
document.getElementById('check').hidden=false;document.getElementById('checkCode').textContent=r.body.checkCode;status.textContent='Waiting for approval in Solus…';
for(;;){const w=await post('/oauth/mcp/approve/wait',{requestId:r.body.requestId,waitToken:r.body.waitToken});
if(w.body.status==='approved')return go(w.body.redirect);if(w.body.status!=='pending'){status.textContent=w.body.status==='denied'?'The request was denied.':'The request expired. Try again.';ask.disabled=false;return}}};`
  return page(`Connect ${appName} to Solus`, main, script)
}
