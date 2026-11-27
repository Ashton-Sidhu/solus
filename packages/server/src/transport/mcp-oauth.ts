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
import { publicAddressNamedBy } from './web-page-requests'

/**
 * The host's OAuth server for outside apps (plans/035 §10): metadata, client
 * registration, the consent page, the approval, and the token. The host is
 * also the resource server: its `/mcp` takes the tokens it issues here.
 */
export interface McpOAuthOptions {
  pairApprovals?: PairApprovals
  /**
   * The request came through a proxy: the Solus tunnel, Tailscale Serve or Funnel,
   * or the person's own ingress (plans/035 §0.8). Its caller is not on the host's
   * network, so the owner is not asked: approve in Solus, or with a pairing code.
   */
  proxied: boolean
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

/**
 * The origin the app reached, so the metadata names the address the app used
 * (plans/035 §0.8): the Solus tunnel, Tailscale Serve and Funnel name it in
 * their headers; the person's own ingress is the `publicAddress` origin, https
 * even when the ingress sends no `X-Forwarded-Proto`.
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url)
  const ingress = publicAddressNamedBy({ host: request.headers.get('host') ?? url.host, 'x-forwarded-host': request.headers.get('x-forwarded-host') ?? undefined })
  if (ingress) return ingress
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
  const html = consentPage(signIn, options.hostName, params.data, !options.proxied && !!options.pairApprovals, options.doors ? getInstallationId() : null, options.servesWebClient ? getInstallationId() : null)
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
  // Pairing is local authorization: through a proxy, the owner is not asked.
  if (options.proxied || !options.pairApprovals) return Response.json({ error: 'Use a pairing code from Solus.' }, { status: 403 })
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

/** The Solus mark (`resources/icon.iconset/icon_32x32@2x.png`), inline: the page loads nothing from another place. Its square fills 46 of its 64 pixels, so the page draws it at 56 px in a 40 px tile. */
const SOLUS_MARK = 'data:image/png;base64,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'

function page(title: string, main: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--page:#f9f8f4;--card:#fffffd;--fg:#2a2618;--fg2:#484538;--fg3:#7d7a6e;--hairline:#e6e3da;--border:#d2cfc5;--wash:#f1efe9;--accent:#d97757;--on-accent:#fff;--shadow:0 1px 2px #2a26180f,0 12px 32px #2a26181a}
@media (prefers-color-scheme:dark){:root{--page:#21201d;--card:#2a2926;--fg:#f0ede5;--fg2:#bdbab3;--fg3:#8d8a83;--hairline:#ffffff14;--border:#ffffff26;--wash:#ffffff0d;--accent:#e68e6b;--on-accent:#21201d;--shadow:0 0 0 1px var(--hairline),0 12px 32px #00000066}}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:48px 16px;background:var(--page);color:var(--fg);font:14px/21px Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
main{width:100%;max-width:440px;background:var(--card);border-radius:16px;box-shadow:var(--shadow);padding:clamp(24px,6vw,32px)}
#consent{display:flex;flex-direction:column;gap:24px}
h1{margin:0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.015em}p{margin:0}h1+p{margin-top:6px;color:var(--fg2)}
.marks{display:flex;align-items:center;gap:10px}.marks svg{flex-shrink:0}
.tile{flex-shrink:0;display:grid;place-items:center;width:40px;height:40px;border-radius:10px}
.mark{display:block;overflow:hidden;box-shadow:0 0 0 1px var(--hairline)}.mark img{display:block;margin:-8px}
.initial{background:var(--wash);box-shadow:0 0 0 1px var(--hairline);color:var(--fg2);font-size:17px;font-weight:600}
dl{margin:0;display:flex;flex-direction:column;gap:6px}
.fact{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px;padding:4px 0;font-size:13px;line-height:16px}
dt{color:var(--fg3)}dd{margin:0;text-align:right;font-weight:500}dd strong{font-weight:500}
dd .muted{display:block;margin-top:2px;color:var(--fg3);font-weight:400;font-size:12px}
.access{appearance:none;-webkit-appearance:none;padding:3px 26px 3px 9px;border:0;border-radius:6px;background:var(--wash) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237d7a6e' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 8px center;color:var(--fg);font:inherit;font-weight:500;cursor:pointer}
.access:focus-visible{outline:2px solid var(--fg3);outline-offset:1px}
dd.explain{flex-basis:100%;text-align:left;font-weight:400;font-size:12px;color:var(--fg3)}dd.explain span{display:none}
dl:has(option[value=read]:checked) [data-access=read],dl:has(option[value=write]:checked) [data-access=write],dl:has(option[value=full]:checked) [data-access=full]{display:inline}
.group,.field,#other,#inSolusWait,#check{display:flex;flex-direction:column;gap:10px}
.field label{font-weight:600;line-height:18px}
input[type=text]{width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--fg);font-family:inherit;font-size:20px;line-height:24px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;outline:none}
input[type=text]::placeholder{color:var(--fg3);opacity:.6;font-weight:500}
input[type=text]:focus{border-color:var(--fg3);box-shadow:0 0 0 3px var(--wash)}
.buttons{display:flex;gap:8px}
button,a.button{display:block;padding:11px 18px;border:0;border-radius:8px;background:var(--wash);color:var(--fg);font:inherit;font-weight:500;line-height:18px;text-align:center;text-decoration:none;cursor:pointer}
button.primary{flex:1;background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
button:hover:not(:disabled),a.button:hover{background:color-mix(in srgb,var(--fg) 10%,transparent)}button.primary:hover:not(:disabled){background:color-mix(in oklab,var(--accent) 88%,#000)}
button:disabled{opacity:.55;cursor:default}button:focus-visible,a.button:focus-visible{outline:2px solid var(--fg3);outline-offset:2px}
#other button,.field button{width:100%}
.other-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:2px;font-size:13px;line-height:16px;color:var(--fg3)}
button.link{width:auto;padding:0;border:0;background:none;color:var(--fg);font-weight:500;line-height:16px;text-decoration:underline;text-underline-offset:3px}button.link:hover:not(:disabled){background:none;color:var(--fg2)}
#other{gap:12px;padding-top:8px}#inSolusWait p,#check p{color:var(--fg2)}
.code{padding:14px;border-radius:10px;background:var(--wash);text-align:center;font-size:22px;line-height:1;font-weight:600;letter-spacing:.12em}.code.large{font-size:30px;padding:18px}
.qr svg{display:block;width:184px;height:184px;margin:4px auto 0;border-radius:8px}.caption{text-align:center}
.note,.caption{font-size:13px;line-height:19px;color:var(--fg3)}
.status{color:var(--fg2);font-size:13px;line-height:19px}.status:empty{display:none}
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
if(signedIn)post('/oauth/mcp/approver',{},signedIn).then((r)=>{if(!r.ok)return;approveAs.textContent='Approve as '+r.body.name;approveAs.hidden=false;for(const button of [inSolus,ask,usePairing])if(button)button.classList.remove('primary');
const code=$('codeEntry');code.append(usePairing);$('inSolusWait').after(code);$('otherLead').textContent='Not '+r.body.name+'?';showOther.textContent='Use a code or the Solus app'});
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
  const initial = escapeHtml(Array.from(signIn.appName.trim())[0]?.toUpperCase() ?? '?')
  const place = redirectPlace(signIn.redirectUri)
  // The main path is the code from Solus, or one click for a browser signed in to this host; the other paths open under "No code?".
  const main = `<div id="consent">
<div class="marks"><div class="tile initial" role="img" aria-label="${app}, name set by the app" title="${app}: name set by the app">${initial}</div>
<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="var(--border)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div class="tile mark"><img src="${SOLUS_MARK}" width="56" height="56" alt="Solus"></div></div>
<div><h1>Connect ${app} to Solus</h1>
<p>${app} wants to use ${escapeHtml(hostName)} as you. Only approve a sign-in you just started.</p></div>
<dl>
<div class="fact"><dt>Access goes to</dt><dd><strong>${escapeHtml(place.label)}</strong> <span class="muted">${place.onThisComputer ? 'On the computer that opened this page' : 'Whoever runs it gets this access.'}</span></dd></div>
<div class="fact"><dt id="accessLabel">It can</dt><dd><select class="access" id="access" name="access" aria-labelledby="accessLabel">
<option value="read">Read</option>
<option value="write" selected>Read and write</option>
<option value="full">Full</option></select></dd>
<dd class="explain"><span data-access="read">See works, projects, tasks, automations, and sessions.</span><span data-access="write">Also start sessions and change records.</span><span data-access="full">Also run tools that ask for approval in Solus.</span></dd></div>
</dl>
<div class="group">
<div class="field" id="codeEntry"><label for="pairing">Code from Solus</label>
<input type="text" id="pairing" placeholder="XXXX-XXXX" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="9" aria-describedby="pairingHelp" autofocus></div>
<div class="buttons">${signedInHostId ? '<button class="primary" id="approveAs" hidden disabled></button>' : ''}<button class="primary" id="usePairing" disabled>Approve</button><button id="deny">Deny</button></div>
<p class="status" id="status" role="status"></p>
</div>
<div class="other-row"><span id="otherLead">No code?</span><button type="button" class="link" id="showOther" aria-expanded="false" aria-controls="other">Approve from the Solus app</button></div>
<div id="other" hidden>
<button class="primary" id="inSolus" disabled>Approve in Solus</button>
<div id="inSolusWait" hidden><p>Approve this sign-in in Solus. Check that Solus shows this code:</p><div class="code large" id="inSolusCode"></div>
<div class="qr" id="inSolusQr"></div><p class="caption">Scan with the Solus app on your phone</p>
<a class="button" id="openSolus">Open Solus</a>
${webClientHostId ? '<a class="button" id="openWeb">Open Solus on the web</a>' : ''}
<p class="note">Or in Solus, open Use Solus in other apps, choose Approve a sign-in, and enter this code.</p></div>
${canAskInApp ? `<button id="ask" disabled>Ask the host owner</button><div id="check" hidden><p>The host owner sees the request in Solus. Check that it shows this code:</p><div class="code" id="checkCode"></div></div>` : ''}
<p class="note" id="pairingHelp">To make a code, open Use Solus in other apps in Solus: the host's Access tab, or the command palette. A code gives the access chosen when it was made, so the choice above does not apply to it.</p>
</div>
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
const access=()=>document.getElementById('access').value;
const post=(path,data,bearer)=>fetch(path,{method:'POST',headers:bearer?{'content-type':'application/json',authorization:'Bearer '+bearer}:{'content-type':'application/json'},body:JSON.stringify(data)}).then(async(r)=>({ok:r.ok,body:await r.json()})).catch(()=>({ok:false,body:{error:'Could not reach this host. Try again.'}}));
const go=(redirect)=>{if(follow(redirect))status.textContent='Approved. Returning to the app…'};
const ask=$('ask');const usePairing=$('usePairing');const approveAs=$('approveAs');const inSolus=$('inSolus');const busy=new Set();let armed=false;let timer=0;
const showOther=$('showOther');showOther.onclick=()=>{const other=$('other');other.hidden=!other.hidden;showOther.setAttribute('aria-expanded',String(!other.hidden))};
const sync=()=>{for(const button of [approveAs,inSolus,ask,usePairing])if(button)button.disabled=!armed||busy.has(button)};
const arm=()=>{armed=false;sync();clearTimeout(timer);timer=setTimeout(()=>{armed=true;sync()},${ARM_DELAY_MS})};
addEventListener('focus',arm);document.addEventListener('visibilitychange',arm);arm();
${signedInHostId ? signedInScript(signedInHostId) : ''}
$('pairing').onkeydown=(e)=>{if(e.key==='Enter')usePairing.click()};
$('deny').onclick=()=>{if(follow(denied))status.textContent='Denied. Returning to the app…'};
usePairing.onclick=async()=>{if(!armed||busy.has(usePairing))return;const code=$('pairing').value;if(!code){status.textContent='Enter the code from Solus.';return}
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
