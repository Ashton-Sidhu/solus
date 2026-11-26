import { randomInt } from 'node:crypto'
import { z } from 'zod'
import { formatCheckCode } from '@solus/contracts/add-machine'
import { appSignInLink, isLoopbackHost } from '@solus/contracts/outside-apps'
import { permissionOf } from '@solus/contracts/permissions'
import { HOST_CREDENTIALS_KEY } from '@solus/client-core/host-credentials'
import { encodeQrByteMode } from '@solus/client-core/qr'
import { authorize as authorizePrincipal } from '../admission/access-policy'
import { getInstallationId, issueAppToken, revokeAppToken } from '../admission/auth'
import type { Doors } from '../admission/doors'
import {
  appAccessChecks,
  appApproverOf,
  appOfClient,
  approvedRedirect,
  deniedRedirect,
  redeemCode,
  redirectPlace,
  registerClient,
  registeredClient,
  spendAppPairingCode,
  withdrawRedirect,
  type AppApprover,
  type AuthorizationRequest,
} from '../admission/app-sign-in'
import { startAppSignInRequest, waitAppSignInRequest } from '../admission/app-sign-in-requests'
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
  /** The doors of this server: a browser signed in to this host approves with its own credential. Absent, it cannot. */
  doors?: Doors
  /** This origin serves the web client (not through the tunnel): the page links to its Approve a sign-in view. */
  servesWebClient?: boolean
}

/** Guessing a pairing code costs a request; a person types a few. */
const codeAttempts = createTokenBucketRateLimiter(10, 60_000)
/** Anyone who reaches the page can start a sign-in that waits in memory; a person starts a few. */
const inSolusStarts = createTokenBucketRateLimiter(10, 60_000)

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
  /** The access chosen on the page, for approval in the Solus app or as the signed-in person; a pairing code names its own. */
  access: accessSchema.optional(),
  pairing_code: z.string().max(16).optional(),
  /** Approve in Solus: the sign-in waits for a person to approve it in their own client (plans/035 §0.5). */
  in_solus: z.literal(true).optional(),
})
const waitSchema = z.object({ requestId: z.string().min(1), waitToken: z.string().min(1), in_solus: z.literal(true).optional() })
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

/** Schemes that run or read something in the browser that holds the code, or that no app receives a code at. */
const REFUSED_SCHEMES: ReadonlySet<string> = new Set(['javascript:', 'data:', 'file:', 'blob:', 'vbscript:', 'about:', 'filesystem:', 'ftp:', 'ws:', 'wss:'])

/**
 * A redirect address an app may use, and the only kind the consent page sends
 * the browser to: https, http on this computer, or a private-use scheme of an
 * app on this computer (RFC 8252 §7.1, as Cursor's `cursor:`). Plain http to
 * another computer would carry the code in the open. No fragment (RFC 6749 §3.1.2).
 */
export function allowedRedirect(uri: string): boolean {
  if (!URL.canParse(uri)) return false
  const url = new URL(uri)
  if (url.hash) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname)
  return !REFUSED_SCHEMES.has(url.protocol)
}

function oauthError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status })
}

/**
 * The sign-in a request describes, when its client is registered here and names
 * one of its redirect addresses. A client id is a signed copy of what the app
 * sent, so one made before a redirect rule changed is checked again here.
 */
function signInOf(params: z.infer<typeof authorizeSchema>): Omit<AuthorizationRequest, 'access'> | null {
  const client = registeredClient(params.client_id)
  if (!client || !client.redirectUris.includes(params.redirect_uri) || !allowedRedirect(params.redirect_uri)) return null
  return { clientId: params.client_id, appName: client.name, app: appOfClient(client), redirectUri: params.redirect_uri, codeChallenge: params.code_challenge, state: params.state ?? null }
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
  if (!parsed || !parsed.redirect_uris.every(allowedRedirect)) return oauthError('invalid_redirect_uri', 'Send redirect_uris as https addresses, http addresses on this computer, or an app scheme, without a fragment.')
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
  const signIn = params.success ? signInOf(params.data) : null
  if (!params.success || !signIn) return consentError('This sign-in link is not valid. Start the connection again from the app.')
  const html = consentPage(signIn, options.hostName, params.data, !options.viaTunnel && !!options.pairApprovals, options.doors ? getInstallationId() : null, options.servesWebClient ? getInstallationId() : null)
  return new Response(html, { headers: PAGE_HEADERS })
}

/**
 * The person a browser signed in to this host is, when they may connect an app
 * (one-click approval). The consent page reads this host's credential from its
 * own origin's storage and sends it as a bearer; nothing else sends one.
 *
 * Why this is safe against other sites:
 * - The credential is not ambient. No cookie is involved: a browser attaches
 *   nothing to a request by itself, and only a script on this origin can read
 *   the storage that holds the credential. A forged request from another site
 *   carries no credential, so it can only fail.
 * - Another site cannot send the header either. A cross-origin request with
 *   `Authorization` or a JSON body needs a preflight, and these routes answer
 *   no preflight (no CORS); `fromConsentPage` also refuses any other origin and
 *   any form post.
 * - The page cannot be framed (headers and its own check), and Approve stays
 *   off for 700 ms after the page shows or comes back to the front, so a click
 *   aimed at another page or window does not land on it. The page never
 *   approves without a click.
 * - It gives nothing new. The same credential, through the same door
 *   (`Doors.admitBearer`) and the same gate as `connectionsCreateAppPairingCode`,
 *   already makes a pairing code; this saves typing it. A host acting for a
 *   person (`act`) is an agent, not the person at the page, and is refused.
 * - The code goes only to the redirect address the client registered and this
 *   host checked (`allowedRedirect`), as with every other approval.
 */
async function signedInApprover(request: Request, options: McpOAuthOptions): Promise<{ approver: AppApprover; name: string } | null> {
  const header = request.headers.get('authorization') ?? ''
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!bearer || !options.doors) return null
  const admission = await options.doors.admitBearer(bearer, request.headers.get('solus-organization') ?? undefined).catch(() => null)
  if (!admission?.ok || admission.actingHostId) return null
  const principal = admission.principal
  // The rule of making a pairing code: its permission, then who may approve.
  const permission = permissionOf('connectionsCreateAppPairingCode')
  if (!permission || await authorizePrincipal(principal, permission, null, { name: 'connectionsCreateAppPairingCode' })) return null
  const approver = appApproverOf(principal)
  if (!approver) return null
  const name = approver.kind === 'member' ? approver.displayName
    : principal.kind === 'owner' && principal.via === 'grant' && principal.displayName ? principal.displayName : 'the host owner'
  return { approver, name }
}

const SIGNED_IN_REFUSED = 'This browser’s Solus sign-in cannot approve apps. Use a pairing code.'

/** The person the page would approve as, so it shows "Approve as {name}" only when that approval works. */
async function signedInName(request: Request, options: McpOAuthOptions): Promise<Response> {
  const signedIn = await signedInApprover(request, options)
  return signedIn ? Response.json({ name: signedIn.name }, { headers: { 'cache-control': 'no-store' } }) : Response.json({ error: SIGNED_IN_REFUSED }, { status: 403 })
}

async function approve(request: Request, options: McpOAuthOptions): Promise<Response> {
  const parsed = await parsedBody(request, approveSchema)
  const signIn = parsed ? signInOf(parsed) : null
  if (!parsed || !signIn) return Response.json({ error: 'This sign-in is not valid.' }, { status: 400 })
  if (parsed.in_solus) return startInSolus(signIn, parsed.access, options)
  if (parsed.pairing_code === undefined && request.headers.has('authorization')) {
    const signedIn = await signedInApprover(request, options)
    if (!signedIn) return Response.json({ error: SIGNED_IN_REFUSED }, { status: 403 })
    if (!parsed.access) return Response.json({ error: 'Choose the access to give.' }, { status: 400 })
    const denied = appAccessChecks().appDenial(signIn.app, signedIn.approver)
    if (denied) return Response.json({ error: denied }, { status: 403 })
    return Response.json({ redirect: approvedRedirect({ ...signIn, access: parsed.access }, signedIn.approver) })
  }
  if (parsed.pairing_code !== undefined) {
    if (!codeAttempts.allow(options.remoteAddress)) return Response.json({ error: 'Too many attempts. Wait a minute.' }, { status: 429 })
    const spent = spendAppPairingCode(parsed.pairing_code)
    if (!spent) return Response.json({ error: 'That pairing code is not valid. Make a new one in Solus.' }, { status: 403 })
    // The person's organization may allow only some apps (plans/035 §10).
    const denied = appAccessChecks().appDenial(signIn.app, spent.approver)
    if (denied) return Response.json({ error: denied }, { status: 403 })
    // The code names the access, chosen by the person who made it.
    return Response.json({ redirect: approvedRedirect({ ...signIn, access: spent.access }, spent.approver) })
  }
  // Pairing is local authorization: through the public tunnel, only the owner's pairing code approves.
  if (options.viaTunnel || !options.pairApprovals) return Response.json({ error: 'Use a pairing code from Solus.' }, { status: 403 })
  if (!parsed.access) return Response.json({ error: 'Choose the access to give.' }, { status: 400 })
  const access = parsed.access
  // Approval in the Solus app is the owner's.
  const denied = appAccessChecks().appDenial(signIn.app, { kind: 'owner' })
  if (denied) return Response.json({ error: denied }, { status: 403 })
  const checkCode = formatCheckCode((n) => randomInt(n))
  const started = options.pairApprovals.start({
    deviceLabel: `${signIn.appName} (MCP app, ${access} access)`,
    checkCode,
    fromAddress: options.remoteAddress,
    grant: { issue: () => approvedRedirect({ ...signIn, access }, { kind: 'owner' }), withdraw: withdrawRedirect },
  })
  if (!started) return Response.json({ error: 'Too many open requests. Try again later.' }, { status: 429 })
  return Response.json({ requestId: started.request.requestId, waitToken: started.waitToken, checkCode, expiresAt: started.request.expiresAt })
}

/**
 * Approve in Solus: on every path, for the owner and members alike, because the
 * person signs in to their own client, not to this page. The page shows a check
 * code and a link with the sign-in's id; whoever decides it there gives the app
 * their own access (`connectionsDecideAppSignIn`). Starting one gives nothing:
 * only the page that holds its wait token gets the result.
 */
function startInSolus(signIn: Omit<AuthorizationRequest, 'access'>, access: AuthorizationRequest['access'] | undefined, options: McpOAuthOptions): Response {
  if (!access) return Response.json({ error: 'Choose the access to give.' }, { status: 400 })
  if (!inSolusStarts.allow(options.remoteAddress)) return Response.json({ error: 'Too many attempts. Wait a minute.' }, { status: 429 })
  const started = startAppSignInRequest({ ...signIn, access })
  if (!started) return Response.json({ error: 'Too many sign-ins wait for approval. Try again later.' }, { status: 429 })
  const link = appSignInLink(getInstallationId(), started.requestId)
  return Response.json({ requestId: started.requestId, waitToken: started.waitToken, checkCode: started.checkCode, expiresAt: started.expiresAt, link, qrSvg: qrSvg(link) })
}

/** A QR code as inline SVG: dark on white with its quiet zone, whatever the page's colors, so a phone reads it. */
function qrSvg(text: string): string {
  const qr = encodeQrByteMode(text)
  const quiet = 4
  const size = qr.size + quiet * 2
  let path = ''
  qr.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z` }))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="200" height="200" shape-rendering="crispEdges" role="img" aria-label="QR code that opens this sign-in in Solus"><rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${path}"/></svg>`
}

async function approvalWait(request: Request, options: McpOAuthOptions): Promise<Response> {
  const parsed = await parsedBody(request, waitSchema)
  if (parsed?.in_solus) return Response.json(await waitAppSignInRequest(parsed.requestId, parsed.waitToken, request.signal))
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
  if (route === 'POST /oauth/mcp/approve' || route === 'POST /oauth/mcp/approve/wait' || route === 'POST /oauth/mcp/approver') {
    if (!fromConsentPage(request)) return Response.json({ error: 'forbidden' }, { status: 403 })
    if (route === 'POST /oauth/mcp/approver') return signedInName(request, options)
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

/** A value for an inline script: JSON that cannot close the script element. */
function scriptValue(value: string | z.infer<typeof authorizeSchema>): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** No other site may show these pages in a frame, where a click aimed at its own page could land on Approve. */
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
}

function consentError(message: string): Response {
  return new Response(page('Solus', `<h1>Cannot connect</h1><p>${escapeHtml(message)}</p>`, ''), { status: 400, headers: PAGE_HEADERS })
}

function page(title: string, main: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--border:#e7e5e4;--accent:#c2410c;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--border:#292524;--accent:#fb923c;--accent-fg:#1c1917}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}p strong{color:var(--fg)}label{display:flex;gap:8px;align-items:flex-start;padding:8px 0;cursor:pointer}
label span{display:block}label small{color:var(--muted)}fieldset{border:0;padding:0;margin:0 0 8px}legend,label.field{display:block;font-weight:600;padding:0;margin-bottom:4px;cursor:default}
dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 16px;margin:0 0 8px;font-size:14px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.muted{color:var(--muted);font-weight:400}.note{font-size:13px;margin:4px 0 16px}
button{width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--fg);font:inherit;cursor:pointer;margin-top:8px}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}button:disabled{opacity:.6;cursor:default}
input[type=text]{width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font:inherit;letter-spacing:.1em;text-transform:uppercase}
.code{font:600 22px/1 ui-monospace,monospace;letter-spacing:.15em;text-align:center;padding:12px;border:1px dashed var(--border);border-radius:8px;margin:8px 0 12px}
.status{min-height:1.5em;margin-top:12px;color:var(--muted)}.or{text-align:center;color:var(--muted);margin:12px 0 4px;font-size:13px}
.code.large{font-size:32px;padding:16px}.qr svg{display:block;width:200px;height:200px;margin:8px auto 4px;border-radius:8px}.caption{text-align:center;font-size:13px;margin:0 0 8px}
a.button{display:block;text-align:center;padding:10px;border-radius:8px;border:1px solid var(--border);color:var(--fg);text-decoration:none;margin:8px 0}
</style></head><body><main>${main}</main>${script ? `<script>${script}</script>` : ''}</body></html>`
}

/**
 * The part of the consent page's script that approves as the person signed in
 * to this host in this browser: their credential for this host, from this
 * origin's storage, goes only to this host's own routes. The button shows once
 * the host says that credential may approve (`/oauth/mcp/approver`).
 */
function signedInScript(hostId: string): string {
  return `const signedIn=(()=>{try{const list=JSON.parse(localStorage.getItem(${scriptValue(HOST_CREDENTIALS_KEY)})||'[]');const entry=Array.isArray(list)?list.find((e)=>e&&e.hostId===${scriptValue(hostId)}):null;return entry&&typeof entry.token==='string'?entry.token:''}catch{return ''}})();
if(signedIn)post('/oauth/mcp/approver',{},signedIn).then((r)=>{if(!r.ok)return;approveAs.textContent='Approve as '+r.body.name;approveAs.hidden=false;for(const button of [inSolus,ask,usePairing])if(button)button.classList.remove('primary')});
approveAs.onclick=async()=>{if(!armed||busy.has(approveAs))return;busy.add(approveAs);sync();const r=await post('/oauth/mcp/approve',{...request,access:access()},signedIn);if(r.ok)return go(r.body.redirect);status.textContent=r.body.error;busy.delete(approveAs);sync()};`
}

/** How long Approve stays off after the page shows or comes back to the front, so a click aimed at another window cannot land on it. */
const ARM_DELAY_MS = 700

/**
 * The consent page. `signedInHostId` is this host's id when a browser signed in
 * to it may approve as its person: the page looks for that host's credential in
 * its own origin's storage (`HOST_CREDENTIALS_KEY`, which the web client this
 * host serves writes) and, when the host accepts it, shows "Approve as {name}".
 * `webClientHostId` is this host's id when this origin serves the web client:
 * the waiting view links to its Approve a sign-in view (`?approveApp=&host=`).
 */
function consentPage(signIn: Omit<AuthorizationRequest, 'access'>, hostName: string, params: z.infer<typeof authorizeSchema>, canAskInApp: boolean, signedInHostId: string | null, webClientHostId: string | null): string {
  const app = escapeHtml(signIn.appName)
  const place = redirectPlace(signIn.redirectUri)
  const main = `<div id="consent">
<h1>Connect ${app}</h1>
<p>${app} wants to use Solus on <strong>${escapeHtml(hostName)}</strong>.</p>
<dl>
<dt>App</dt><dd>${app} <span class="muted">· name set by the app</span></dd>
<dt>Access goes to</dt><dd><strong>${escapeHtml(place.label)}</strong> <span class="muted">${place.onThisComputer ? 'on the computer that opened this page' : '· Whoever runs it gets this access.'}</span></dd>
</dl>
<p class="note">Only approve a sign-in you just started.</p>
<fieldset id="accessChoice"><legend>What it may do</legend>
<label><input type="radio" name="access" value="read"><span>Read<small><br>See works, projects, tasks, automations, and sessions.</small></span></label>
<label><input type="radio" name="access" value="write" checked><span>Read and write<small><br>Also start sessions and change records.</small></span></label>
<label><input type="radio" name="access" value="full"><span>Full<small><br>Also run tools that ask for approval in Solus.</small></span></label>
</fieldset>
${signedInHostId ? '<button class="primary" id="approveAs" hidden disabled></button>' : ''}
<button class="primary" id="inSolus" disabled>Approve in Solus</button>
<div id="inSolusWait" hidden><p>Approve this sign-in in Solus. Check that Solus shows this code:</p><div class="code large" id="inSolusCode"></div>
<div class="qr" id="inSolusQr"></div><p class="caption">Scan with the Solus app on your phone</p>
<a class="button" id="openSolus">Open Solus</a>
${webClientHostId ? '<a class="button" id="openWeb">Open Solus on the web</a>' : ''}
<p class="note">Or in Solus, open Use Solus in other apps, choose Approve a sign-in, and enter this code.</p></div>
${canAskInApp ? `<button id="ask" disabled>Ask the host owner</button><div id="check" hidden><p>The host owner sees the request in Solus. Check that it shows this code:</p><div class="code" id="checkCode"></div></div>` : ''}
<div class="or">or</div>
<label class="field" for="pairing">Pairing code</label>
<input type="text" id="pairing" placeholder="Pairing code" autocomplete="one-time-code" maxlength="9" aria-describedby="pairingHelp">
<p class="note" id="pairingHelp">Get one from Use Solus in other apps in Solus: the host's Access tab, or the command palette. The code gives the access chosen when it was made, so the choice above does not apply to it.</p>
<button id="usePairing" disabled>Use pairing code</button>
<button id="deny">Deny</button>
<p class="status" id="status" role="status"></p>
</div>
<div id="framed" hidden><h1>Open this page in its own window</h1><p>Solus does not approve a sign-in inside another page.</p></div>`
  // The browser goes only to the redirect address this host checked (allowedRedirect): a redirect
  // that names another place is not followed. Deny sends the app's own error back (RFC 6749 §4.1.2.1).
  const script = `const request=${scriptValue(params)};
const denied=${scriptValue(deniedRedirect(signIn))};
const $=(id)=>document.getElementById(id);
if(window.top!==window.self){$('consent').remove();$('framed').hidden=false}else{
const status=$('status');const target=new URL(request.redirect_uri);
const follow=(redirect)=>{let url=null;try{url=new URL(redirect)}catch{}
if(!url||url.protocol!==target.protocol||url.host!==target.host||url.pathname!==target.pathname){status.textContent='Solus returned an address this page will not open.';return false}
location.replace(url.href);return true};
const access=()=>document.querySelector('input[name=access]:checked').value;
const post=(path,data,bearer)=>fetch(path,{method:'POST',headers:bearer?{'content-type':'application/json',authorization:'Bearer '+bearer}:{'content-type':'application/json'},body:JSON.stringify(data)}).then(async(r)=>({ok:r.ok,body:await r.json()})).catch(()=>({ok:false,body:{error:'Could not reach this host. Try again.'}}));
const go=(redirect)=>{if(follow(redirect))status.textContent='Approved. Returning to the app…'};
const ask=$('ask');const usePairing=$('usePairing');const approveAs=$('approveAs');const inSolus=$('inSolus');const busy=new Set();let armed=false;let timer=0;
const sync=()=>{for(const button of [approveAs,inSolus,ask,usePairing])if(button)button.disabled=!armed||busy.has(button)};
const arm=()=>{armed=false;sync();clearTimeout(timer);timer=setTimeout(()=>{armed=true;sync()},${ARM_DELAY_MS})};
addEventListener('focus',arm);document.addEventListener('visibilitychange',arm);arm();
${signedInHostId ? signedInScript(signedInHostId) : ''}
$('deny').onclick=()=>{if(follow(denied))status.textContent='Denied. Returning to the app…'};
usePairing.onclick=async()=>{if(!armed||busy.has(usePairing))return;const code=$('pairing').value;if(!code){status.textContent='Enter a pairing code from Use Solus in other apps.';return}
busy.add(usePairing);sync();const r=await post('/oauth/mcp/approve',{...request,pairing_code:code});busy.delete(usePairing);sync();if(r.ok)go(r.body.redirect);else status.textContent=r.body.error};
inSolus.onclick=async()=>{if(!armed||busy.has(inSolus))return;busy.add(inSolus);sync();const r=await post('/oauth/mcp/approve',{...request,access:access(),in_solus:true});
const stop=(message)=>{$('inSolusWait').hidden=true;status.textContent=message;busy.delete(inSolus);sync()};
if(!r.ok)return stop(r.body.error);
$('inSolusCode').textContent=r.body.checkCode;$('inSolusQr').innerHTML=r.body.qrSvg;if(r.body.link.startsWith('solus://'))$('openSolus').href=r.body.link;${webClientHostId ? `$('openWeb').href=location.origin+'/?'+new URLSearchParams({approveApp:r.body.requestId,host:${scriptValue(webClientHostId)}});` : ''}$('inSolusWait').hidden=false;status.textContent='Waiting for approval in Solus…';
for(;;){const w=await post('/oauth/mcp/approve/wait',{requestId:r.body.requestId,waitToken:r.body.waitToken,in_solus:true});
if(!w.ok)return stop(w.body.error);if(w.body.status==='approved')return go(w.body.redirect);
if(w.body.status==='denied'){if(follow(denied))status.textContent='Denied in Solus. Returning to the app…';return}
if(w.body.status!=='pending')return stop('Nobody approved the sign-in within 10 minutes. Try again.')}};
if(ask)ask.onclick=async()=>{if(!armed||busy.has(ask))return;busy.add(ask);sync();const r=await post('/oauth/mcp/approve',{...request,access:access()});
if(!r.ok){status.textContent=r.body.error;busy.delete(ask);sync();return}
$('check').hidden=false;$('checkCode').textContent=r.body.checkCode;status.textContent='Waiting for approval in Solus…';
for(;;){const w=await post('/oauth/mcp/approve/wait',{requestId:r.body.requestId,waitToken:r.body.waitToken});
if(w.body.status==='approved')return go(w.body.redirect);if(w.body.status!=='pending'){status.textContent=w.body.status==='denied'?'The request was denied.':'The request expired. Try again.';busy.delete(ask);sync();return}}}}`
  return page(`Connect ${signIn.appName} to Solus`, main, script)
}
