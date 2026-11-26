import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { JSDOM } from 'jsdom'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const auth = await import('@solus/server/admission/auth')
const { createAppPairingCode, installAppAccessChecks, registerClient, resetAppSignInForTests } = await import('@solus/server/admission/app-sign-in')
const { OUTSIDE_APP_GUIDES, outsideAppOf } = await import('@solus/contracts/outside-apps')
const { PairApprovals } = await import('@solus/server/admission/pair-approvals')
const { serveMcpOAuth } = await import('@solus/server/transport/mcp-oauth')
const { serveMcp } = await import('@solus/server/transport/mcp-endpoint')
const { createDoors } = await import('@solus/server/admission/doors')
type Doors = ReturnType<typeof createDoors>

// WHY: an outside app (Claude Desktop, Cursor, a person's own CLI) reaches this
// host's tools only after the owner approves it, and only with the access the
// owner chose (plans/035 §10). The host is its own OAuth server, so this works
// on a host with no Solus account.

const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
// The pairing code limiter counts by address across the file: each test comes from its own.
let remoteAddress = '127.0.0.1'
let testNumber = 0
const allowEverything = { appDenial: () => null, memberHasAccess: async () => true }
beforeEach(() => {
  installAppAccessChecks(allowEverything)
  dataDir = mkdtempSync(join(tmpdir(), 'solus-mcp-app-sign-in-'))
  process.env.SOLUS_DATA_DIR = dataDir
  auth.resetAuthStateForTests()
  resetAppSignInForTests()
  remoteAddress = `127.0.0.${++testNumber}`
})
afterEach(() => {
  auth.resetAuthStateForTests()
  rmSync(dataDir, { recursive: true, force: true })
  if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = originalDataDir
})

const ORIGIN = 'http://localhost:4000'
const REDIRECT = 'http://127.0.0.1:33418/callback'
const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')

type OAuthOptions = { viaTunnel?: boolean; pairApprovals?: InstanceType<typeof PairApprovals>; doors?: Doors }
function oauth(path: string, init: RequestInit & { json?: object; form?: Record<string, string> } = {}, options: OAuthOptions = {}) {
  const headers = new Headers(init.headers)
  let requestBody = init.body
  if (init.json) { headers.set('content-type', 'application/json'); requestBody = JSON.stringify(init.json) }
  if (init.form) { headers.set('content-type', 'application/x-www-form-urlencoded'); requestBody = new URLSearchParams(init.form).toString() }
  return serveMcpOAuth(new Request(`${ORIGIN}${path}`, { ...init, headers, body: requestBody }), { viaTunnel: options.viaTunnel ?? false, remoteAddress, hostName: 'Studio Mac', pairApprovals: options.pairApprovals, doors: options.doors })
}

async function register(redirect = REDIRECT): Promise<string> {
  const response = await oauth('/oauth/mcp/register', { method: 'POST', json: { client_name: 'Claude Desktop', redirect_uris: [redirect] } })
  expect(response.status).toBe(201)
  return z.object({ client_id: z.string() }).parse(await response.json()).client_id
}

function authorizeParams(clientId: string, redirect = REDIRECT) {
  return { response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1' }
}

async function consentHtml(clientId: string, redirect = REDIRECT, options: OAuthOptions = {}): Promise<string> {
  const page = await oauth(`/oauth/mcp/authorize?${new URLSearchParams(authorizeParams(clientId, redirect))}`, {}, options)
  expect(page.status).toBe(200)
  return page.text()
}

/** The address the page's Deny button sends the browser to. */
function deniedAddress(html: string): string {
  const match = /const denied=("(?:[^"\\]|\\.)*")/.exec(html)
  if (!match?.[1]) throw new Error('The page has no Deny address')
  return z.string().parse(JSON.parse(match[1]))
}

/** The consent page in a browser, with its script running, framed in another page when `framed`. */
function consentInBrowser(html: string, framed = false, prepare?: (window: Window) => void) {
  const browser = new JSDOM('<!doctype html><iframe></iframe>', { url: `${ORIGIN}/oauth/mcp/authorize`, runScripts: 'outside-only' })
  const window = framed ? browser.window.document.querySelector('iframe')!.contentWindow! : browser.window
  prepare?.(window)
  const page = new JSDOM(html).window.document
  // Markup set this way runs no script; the page's script runs once, below.
  window.document.body.innerHTML = page.body.innerHTML
  window.eval(page.querySelector('script')!.textContent!)
  return { document: window.document, window, close: () => browser.window.close() }
}

async function tokenFor(clientId: string, redirect: string): Promise<Response> {
  const code = new URL(redirect).searchParams.get('code') ?? ''
  return oauth('/oauth/mcp/token', { method: 'POST', form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier } })
}

type Approver = Parameters<typeof createAppPairingCode>[0]
const OWNER: Approver = { kind: 'owner' }
const MEMBER: Approver = { kind: 'member', userId: 'alice', organizationId: 'org-a', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Alice' }

async function signInWithPairingCode(access: 'read' | 'write' | 'full', approver: Approver = OWNER): Promise<string> {
  const clientId = await register()
  const approved = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access, pairing_code: createAppPairingCode(approver, access).code } })
  const { redirect } = z.object({ redirect: z.string() }).parse(await approved.json())
  return z.object({ access_token: z.string() }).parse(await (await tokenFor(clientId, redirect)).json()).access_token
}

async function appClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: (url, init) => serveMcp(new Request(url, init), { appsSignIn: true }),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'Claude Desktop', version: '1.0.0' })
  await client.connect(transport)
  return client
}

describe('signing in an outside app', () => {
  test('the consent page names the app and the host', async () => {
    const clientId = await register()
    const page = await oauth(`/oauth/mcp/authorize?${new URLSearchParams(authorizeParams(clientId))}`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('<h1>Connect Claude Desktop</h1>')
    expect(html).toContain('Claude Desktop wants to use Solus on <strong>Studio Mac</strong>.')
    // The name is the app's own claim, and the page says so.
    expect(html).toContain('name set by the app')
    expect(html).toContain('Only approve a sign-in you just started.')
    // A client this host did not register, or a redirect it did not register, gets no page.
    expect((await oauth(`/oauth/mcp/authorize?${new URLSearchParams({ ...authorizeParams(clientId), redirect_uri: 'https://evil.example/cb' })}`)).status).toBe(400)
  })

  test('a pairing code from the owner approves; the code works once, with the verifier', async () => {
    const clientId = await register()
    const pairing = createAppPairingCode({ kind: 'owner' }, 'write').code
    const approved = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access: 'write', pairing_code: pairing } })
    const { redirect } = z.object({ redirect: z.string() }).parse(await approved.json())
    expect(new URL(redirect).searchParams.get('state')).toBe('st-1')
    // The same pairing code does not approve twice.
    expect((await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access: 'write', pairing_code: pairing } })).status).toBe(403)
    // A wrong verifier gets no token, and the code is spent.
    const code = new URL(redirect).searchParams.get('code') ?? ''
    const wrong = await oauth('/oauth/mcp/token', { method: 'POST', form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: 'x'.repeat(43) } })
    expect(wrong.status).toBe(400)
    expect((await tokenFor(clientId, redirect)).status).toBe(400)
  })

  test('a pairing code gives the access its maker chose, whatever the sign-in page sends', async () => {
    const clientId = await register()
    const approved = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access: 'full', pairing_code: createAppPairingCode(OWNER, 'read').code } })
    const { redirect } = z.object({ redirect: z.string() }).parse(await approved.json())
    const token = z.object({ scope: z.string() }).parse(await (await tokenFor(clientId, redirect)).json())
    expect(token.scope).toBe('read')
  })

  test('the owner approves in the Solus app, comparing the check code', async () => {
    const pairApprovals = new PairApprovals()
    const clientId = await register()
    const started = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access: 'read' } }, { pairApprovals })
    const request = z.object({ requestId: z.string(), waitToken: z.string(), checkCode: z.string() }).parse(await started.json())
    const [open] = pairApprovals.list()
    expect(open).toMatchObject({ deviceLabel: 'Claude Desktop (MCP app, read access)', checkCode: request.checkCode })
    pairApprovals.decide(request.requestId, 'approve')
    const waited = await oauth('/oauth/mcp/approve/wait', { method: 'POST', json: { requestId: request.requestId, waitToken: request.waitToken } }, { pairApprovals })
    const { redirect } = z.object({ status: z.literal('approved'), redirect: z.string() }).parse(await waited.json())
    const token = await tokenFor(clientId, redirect)
    expect(z.object({ scope: z.string() }).parse(await token.json()).scope).toBe('read')
  })

  test('through the public tunnel only a pairing code approves', async () => {
    const pairApprovals = new PairApprovals()
    const clientId = await register()
    const asked = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access: 'write' } }, { pairApprovals, viaTunnel: true })
    expect(asked.status).toBe(403)
    expect(pairApprovals.list()).toEqual([])
  })

  test('another site cannot start an approval in the person’s name', async () => {
    const clientId = await register()
    const form = await oauth('/oauth/mcp/approve', { method: 'POST', form: { ...authorizeParams(clientId), access: 'full' } }, { pairApprovals: new PairApprovals() })
    expect(form.status).toBe(403)
    const crossSite = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access: 'full' }, headers: { origin: 'https://evil.example' } }, { pairApprovals: new PairApprovals() })
    expect(crossSite.status).toBe(403)
  })
})

// WHY: the consent page is where a person gives an app their access. It must
// say where that access goes, let the person say no, and resist a page that
// frames it or a click aimed at another window (plans/035 §10).
describe('the consent page', () => {
  test('says the access stays on this computer for a loopback redirect, and that anyone who runs a web app gets it otherwise', async () => {
    const local = await consentHtml(await register())
    expect(local).toContain('<strong>127.0.0.1:33418</strong> <span class="muted">on the computer that opened this page</span>')
    expect(local).not.toContain('Whoever runs it gets this access.')
    const web = 'https://claude.ai/api/mcp/auth_callback'
    const remote = await consentHtml(await register(web), web)
    expect(remote).toContain('<strong>claude.ai</strong> <span class="muted">· Whoever runs it gets this access.</span>')
    expect(remote).not.toContain('on the computer that opened this page')
  })

  test('Deny sends the browser to the registered redirect address with access_denied and the state', async () => {
    const denied = new URL(deniedAddress(await consentHtml(await register())))
    expect(`${denied.origin}${denied.pathname}`).toBe(REDIRECT)
    expect(Object.fromEntries(denied.searchParams)).toEqual({ error: 'access_denied', state: 'st-1' })
    // No code goes with a denial, and a redirect address the client did not register gets no page to deny from.
    const clientId = await register()
    const other = await oauth(`/oauth/mcp/authorize?${new URLSearchParams({ ...authorizeParams(clientId), redirect_uri: 'http://127.0.0.1:9/elsewhere' })}`)
    expect(other.status).toBe(400)
  })

  test('no other site may frame the page, and a framed page shows no buttons', async () => {
    const clientId = await register()
    const page = await oauth(`/oauth/mcp/authorize?${new URLSearchParams(authorizeParams(clientId))}`)
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    const invalid = await oauth('/oauth/mcp/authorize?client_id=x')
    expect(invalid.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    // A browser that ignores both headers still runs the page's own check.
    const framed = consentInBrowser(await page.text(), true).document
    expect(framed.querySelectorAll('button')).toHaveLength(0)
    expect(framed.querySelector('#framed:not([hidden]) h1')?.textContent).toBe('Open this page in its own window')
  })

  test('Approve stays off for 700 ms after the page shows and after the window comes back', async () => {
    const html = await consentHtml(await register(), REDIRECT, { pairApprovals: new PairApprovals() })
    const { window, close } = consentInBrowser(html)
    const approveButtons = () => ['ask', 'usePairing'].map((id) => window.document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled)
    expect(approveButtons()).toEqual([true, true])
    // Deny is never held back.
    expect(window.document.querySelector<HTMLButtonElement>('#deny')!.disabled).toBe(false)
    await Bun.sleep(800)
    expect(approveButtons()).toEqual([false, false])
    window.dispatchEvent(new window.Event('focus'))
    expect(approveButtons()).toEqual([true, true])
    await Bun.sleep(800)
    window.document.dispatchEvent(new window.Event('visibilitychange'))
    expect(approveButtons()).toEqual([true, true])
    close()
  })

  test('the access choice shows only where approval in the Solus app is offered: a pairing code names its own', async () => {
    const clientId = await register()
    const inApp = await consentHtml(clientId, REDIRECT, { pairApprovals: new PairApprovals() })
    expect(inApp).toContain('name="access"')
    expect(inApp).toContain('so the choice above does not apply to it')
    const tunnel = await consentHtml(clientId, REDIRECT, { pairApprovals: new PairApprovals(), viaTunnel: true })
    expect(tunnel).not.toContain('name="access"')
    expect(tunnel).toContain('The code gives the access chosen when it was made.')
    // The page sends no access with a pairing code, and approval in the app must name one.
    const withCode = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), pairing_code: createAppPairingCode(OWNER, 'read').code } })
    expect(withCode.status).toBe(200)
    expect((await oauth('/oauth/mcp/approve', { method: 'POST', json: authorizeParams(clientId) }, { pairApprovals: new PairApprovals() })).status).toBe(400)
  })

  test('an app may register only a redirect address that cannot run in the browser or carry the code in the open', async () => {
    const refused = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'blob:https://claude.ai/0a1b',
      'http://evil.example/cb',
      'http://192.168.1.4:8080/cb',
      'https://claude.ai/cb#code',
    ]
    for (const redirect of refused) {
      const response = await oauth('/oauth/mcp/register', { method: 'POST', json: { client_name: 'App', redirect_uris: [redirect] } })
      expect({ redirect, status: response.status }).toEqual({ redirect, status: 400 })
    }
    for (const redirect of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:4567/cb', 'http://[::1]:4567/cb', 'cursor://anysphere.cursor-retrieval/oauth/callback']) await register(redirect)
    // A client id is a signed copy of what the app sent: one signed before these rules is checked again.
    const old = registerClient('Old app', ['http://evil.example/cb'])
    expect((await oauth(`/oauth/mcp/authorize?${new URLSearchParams(authorizeParams(old, 'http://evil.example/cb'))}`)).status).toBe(400)
    const approved = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(old, 'http://evil.example/cb'), pairing_code: createAppPairingCode(OWNER, 'write').code } })
    expect(approved.status).toBe(400)
  })
})

// WHY: a person picks the app to connect in Solus, and each guide must hand
// over Solus (never another product's name) and say the limits the person
// will meet in that app.
describe('the outside app catalog', () => {
  const guide = (id: string) => {
    const found = OUTSIDE_APP_GUIDES.find((entry) => entry.id === id)
    if (!found) throw new Error(`No guide ${id}`)
    return found
  }
  const url = 'https://box.solus.dev/mcp'

  test('each guide carries the note its app needs', () => {
    expect(guide('claude').note).toBe('The Free plan allows one custom connector.')
    expect(guide('grok-bot').note).toBe('Shared with all your Grok Bots.')
    expect(guide('hermes-agent').note).toBe('On a remote host, paste the final address back when asked.')
  })

  test('Muse and Instinct run in the cloud and get a message; OpenClaw and Hermes Agent run on a computer and get commands', () => {
    for (const id of ['muse', 'instinct']) {
      const cloud = guide(id)
      expect(cloud).toMatchObject({ app: id, needsPublicUrl: true })
      if (cloud.handoff.kind !== 'copy-message') throw new Error(`${id} copies a message`)
      expect(cloud.handoff.message(url)).toContain(url)
      expect(cloud.handoff.link).toStartWith('https://')
    }
    for (const id of ['openclaw', 'hermes-agent']) {
      const local = guide(id)
      expect(local).toMatchObject({ app: 'local', needsPublicUrl: false })
      if (local.handoff.kind !== 'commands') throw new Error(`${id} has commands`)
      const commands = local.handoff.commands(url).join('\n')
      expect(commands).toContain(`--url ${url}`)
      expect(commands).toContain(' solus')
    }
    expect(JSON.stringify(OUTSIDE_APP_GUIDES.map((entry) => [entry.steps, entry.note]))).not.toMatch(/t3/i)
  })
})

describe("an outside app's grant", () => {
  test('lists only the tools its access allows, and none that need a session', async () => {
    const read = await appClient(await signInWithPairingCode('read'))
    const readTools = (await read.listTools()).tools.map((tool) => tool.name)
    expect(readTools).toContain('list_works')
    // An app reads its own exchanges, a session's links, and pull requests.
    expect(readTools).toEqual(expect.arrayContaining(['read_session_exchange', 'list_links', 'pull_request_read', 'ci_logs']))
    expect(readTools).not.toContain('start_sessions')
    expect(readTools).not.toContain('move_checkout')
    await read.close()
    const write = await appClient(await signInWithPairingCode('write'))
    const writeTools = (await write.listTools()).tools.map((tool) => tool.name)
    expect(writeTools).toEqual(expect.arrayContaining(['start_sessions', 'send_session']))
    // update_work, link, and a PR merge need approval: a write grant does not reach them.
    expect(writeTools).not.toContain('update_work')
    expect(writeTools).not.toContain('link')
    expect(writeTools).not.toContain('pull_request_merge')
    // A PR is opened from a session's own checkout.
    expect(writeTools).not.toContain('pull_request_create')
    const refused = await write.callTool({ name: 'update_work', arguments: { work_id: 'w', expected_content_version: 0 } })
    expect(refused.isError).toBe(true)
    await write.close()
    const full = await appClient(await signInWithPairingCode('full'))
    expect((await full.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['update_work', 'link', 'unlink', 'pull_request_merge']))
    await full.close()
  })

  test('is not a device token, and ends when the owner revokes it', async () => {
    const token = await signInWithPairingCode('write')
    expect(auth.verifySessionToken(token)).toBeNull()
    const listed = auth.listPairedDevices().find((device) => device.app)
    // Its redirect address is on this computer, so it is a local app.
    expect(listed).toMatchObject({ deviceLabel: 'Claude Desktop', app: { access: 'write', appId: 'local' } })
    auth.revokeDevice(listed!.deviceId)
    const response = await serveMcp(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), { appsSignIn: true })
    expect(response.status).toBe(401)
    // The challenge names where to sign in again.
    expect(response.headers.get('WWW-Authenticate')).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`)
  })
})

// WHY: an organization decides which outside apps its members may connect;
// with no rule every app is allowed (plans/035 §10). The app is known by where
// its sign-in returns, and an app acts as the person who approved it.
describe('which apps may connect, and as whom', () => {
  test('an app is known by where its sign-in returns', () => {
    expect(outsideAppOf(['https://claude.ai/api/mcp/auth_callback'])).toBe('claude')
    expect(outsideAppOf(['https://chatgpt.com/connector_platform_oauth_redirect'])).toBe('chatgpt')
    expect(outsideAppOf(['http://localhost:33418/callback', 'http://127.0.0.1:33418/callback'])).toBe('local')
    expect(outsideAppOf(['cursor://anysphere.cursor-retrieval/oauth/callback'])).toBe('cursor')
    expect(outsideAppOf(['https://evil.example/cb'])).toBe('other')
    // A client that names two apps is not trusted as either.
    expect(outsideAppOf(['https://claude.ai/cb', 'https://evil.example/cb'])).toBe('other')
  })

  test("an organization that does not allow the app refuses its sign-in and its later calls", async () => {
    const token = await signInWithPairingCode('write', MEMBER)
    const client = await appClient(token)
    await client.close()
    // The organization narrows its apps after the approval.
    installAppAccessChecks({ ...allowEverything, appDenial: (app, approver) => approver.kind === 'member' && app === 'local' ? 'Example Corp does not allow Apps on your computer to use Solus.' : null })
    const call = await serveMcp(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), { appsSignIn: true })
    expect(call.status).toBe(403)
    const clientId = await register()
    const refused = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access: 'write', pairing_code: createAppPairingCode(MEMBER, 'write').code } })
    expect(refused.status).toBe(403)
    expect(z.object({ error: z.string() }).parse(await refused.json()).error).toContain('does not allow')
    // The owner's own work is not that organization's.
    expect((await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access: 'write', pairing_code: createAppPairingCode(OWNER, 'write').code } })).status).toBe(200)
  })

  test("a member's app stops when the member loses access to the host", async () => {
    const token = await signInWithPairingCode('read', MEMBER)
    installAppAccessChecks({ ...allowEverything, memberHasAccess: async () => false })
    const call = await serveMcp(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), { appsSignIn: true })
    expect(call.status).toBe(403)
  })
})

// WHY: a person already signed in to this host in this browser approves an app
// with one click, as themselves, with the access they pick; nobody else may,
// and the organization's app list still applies (plans/035 §10).
describe('approving as the person signed in to this host', () => {
  const doors = () => createDoors({ place: 'host' })
  const approveAs = (clientId: string, bearer: string, access: 'read' | 'write' | 'full', useDoors: Doors = doors()) =>
    oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access }, headers: { authorization: `Bearer ${bearer}` } }, { doors: useDoors })
  const nameFor = (bearer: string, useDoors: Doors = doors()) =>
    oauth('/oauth/mcp/approver', { method: 'POST', json: {}, headers: { authorization: `Bearer ${bearer}` } }, { doors: useDoors })
  const grantOf = async (clientId: string, approved: Response) => {
    const { redirect } = z.object({ redirect: z.string() }).parse(await approved.json())
    const token = z.object({ access_token: z.string(), scope: z.string() }).parse(await (await tokenFor(clientId, redirect)).json())
    return { scope: token.scope, approver: auth.verifyAppToken(token.access_token)?.approver }
  }

  test("a paired device's token approves as the owner, with the access picked on the page", async () => {
    const device = auth.issueSessionToken('Chrome on Studio Mac')
    expect(await (await nameFor(device.token)).json()).toEqual({ name: 'the host owner' })
    const clientId = await register()
    const approved = await approveAs(clientId, device.token, 'full')
    expect(approved.status).toBe(200)
    expect(await grantOf(clientId, approved)).toEqual({ scope: 'full', approver: { kind: 'owner' } })
  })

  test("an organization member's token approves as that member", async () => {
    const now = Math.floor(Date.now() / 1000)
    const claims = { iss: 'https://cloud.test', aud: 'host:h1', sub: 'alice', jti: 'j1', iat: now, exp: now + 600, access: 'org-member' as const, hostKind: 'personal' as const, displayName: 'Alice', grant_id: 'grant-alice', organizations: [{ id: 'org-a', role: 'member' as const, teamIds: ['t1'] }] }
    const memberDoors = createDoors({ place: 'host', verifyAccessToken: async (token) => token === 'alice.jwt.token' ? { ok: true, claims } : { ok: false, reason: 'invalid' } })
    const asMember = (path: string, json: object) => oauth(path, { method: 'POST', json, headers: { authorization: 'Bearer alice.jwt.token', 'solus-organization': 'org-a' } }, { doors: memberDoors })
    expect(await (await asMember('/oauth/mcp/approver', {})).json()).toEqual({ name: 'Alice' })
    const clientId = await register()
    const approved = await asMember('/oauth/mcp/approve', { ...authorizeParams(clientId), access: 'read' })
    expect(await grantOf(clientId, approved)).toEqual({ scope: 'read', approver: { kind: 'member', userId: 'alice', organizationId: 'org-a', organizationRole: 'member', teamIds: ['t1'], hostKind: 'personal', displayName: 'Alice' } })
  })

  test('a revoked or unknown token, or a host acting for a person, approves nothing', async () => {
    const device = auth.issueSessionToken('Old phone')
    auth.revokeDevice(device.deviceId)
    const clientId = await register()
    for (const bearer of [device.token, 'not-a-token']) {
      expect((await nameFor(bearer)).status).toBe(403)
      const refused = await approveAs(clientId, bearer, 'write')
      expect(refused.status).toBe(403)
      // A refused credential never falls back to another way of approving.
      expect(z.object({ error: z.string() }).parse(await refused.json()).error).toContain('Use a pairing code')
    }
    const owner = { kind: 'owner' as const, via: 'grant' as const, userId: 'u1', deviceId: 'host-2', expiresAt: Date.now() + 60_000, deviceLabel: 'Solus account' }
    const actingHost: Doors = { admitCredential: async () => ({ ok: false, reason: 'not-accepted' }), admitBearer: async () => ({ ok: true, principal: owner, actingHostId: 'host-2' }) }
    expect((await approveAs(clientId, 'delegated.jwt.token', 'write', actingHost)).status).toBe(403)
    // Without the doors (the Solus API server), a credential is not taken at all.
    expect((await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access: 'write' }, headers: { authorization: `Bearer ${auth.issueSessionToken('Laptop').token}` } })).status).toBe(403)
  })

  test('a credential that may not make app pairing codes (host.use) approves nothing', async () => {
    const guest = { kind: 'guest' as const, organizationId: null, guestId: 'g1', displayName: 'Guest', deviceId: 'g1', expiresAt: Date.now() + 60_000, deviceLabel: 'Shared link', share: { resource: { kind: 'session' as const, id: 's1' }, role: 'viewer' as const, sharedByUserId: 'u1', linkSecretHash: 'h' } }
    const guestDoors: Doors = { admitCredential: async () => ({ ok: false, reason: 'not-accepted' }), admitBearer: async () => ({ ok: true, principal: guest }) }
    const clientId = await register()
    expect((await nameFor('guest-token', guestDoors)).status).toBe(403)
    expect((await approveAs(clientId, 'guest-token', 'read', guestDoors)).status).toBe(403)
  })

  test("the organization's app list refuses an app it does not allow", async () => {
    installAppAccessChecks({ ...allowEverything, appDenial: (app) => app === 'local' ? 'This host does not allow Apps on your computer to use Solus.' : null })
    const refused = await approveAs(await register(), auth.issueSessionToken('Chrome').token, 'write')
    expect(refused.status).toBe(403)
    expect(z.object({ error: z.string() }).parse(await refused.json()).error).toContain('does not allow')
  })

  test('another site cannot approve with the credential', async () => {
    const token = auth.issueSessionToken('Chrome').token
    const crossSite = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(await register()), access: 'full' }, headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } }, { doors: doors() })
    expect(crossSite.status).toBe(403)
    expect((await oauth('/oauth/mcp/approver', { method: 'POST', json: {}, headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } }, { doors: doors() })).status).toBe(403)
  })

  test("the page shows Approve as {name} only for a browser that holds this host's credential, and approves with it", async () => {
    const useDoors = doors()
    const clientId = await register()
    const html = await consentHtml(clientId, REDIRECT, { doors: useDoors, viaTunnel: true })
    const open = (credentials: object[]) => consentInBrowser(html, false, (window) => {
      window.localStorage.setItem('solus.hostCredentials', JSON.stringify(credentials))
      Object.assign(window, { fetch: (path: string, init: RequestInit) => serveMcpOAuth(new Request(`${ORIGIN}${path}`, init), { viaTunnel: true, remoteAddress, hostName: 'Studio Mac', doors: useDoors }) })
    })
    const button = (window: Window) => window.document.querySelector<HTMLButtonElement>('#approveAs')!
    // Another host's credential is not this host's.
    const other = open([{ hostId: 'another-host', token: auth.issueSessionToken('Chrome').token, routes: [] }])
    await Bun.sleep(50)
    expect(button(other.window).hidden).toBe(true)
    expect(other.document.querySelector<HTMLElement>('#accessChoice')!.hidden).toBe(true)
    other.close()
    const signedIn = open([{ hostId: auth.getInstallationId(), token: auth.issueSessionToken('Chrome').token, routes: [] }])
    await Bun.sleep(800)
    expect(button(signedIn.window).hidden).toBe(false)
    expect(button(signedIn.window).textContent).toBe('Approve as the host owner')
    expect(signedIn.document.querySelector<HTMLElement>('#accessChoice')!.hidden).toBe(false)
    signedIn.document.querySelector<HTMLInputElement>('input[name=access][value=read]')!.checked = true
    button(signedIn.window).click()
    await Bun.sleep(50)
    expect(signedIn.document.querySelector('#status')!.textContent).toBe('Approved. Returning to the app…')
    signedIn.close()
  })
})
