import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const auth = await import('@solus/server/admission/auth')
const { createAppPairingCode, installAppAccessChecks, resetAppSignInForTests } = await import('@solus/server/admission/app-sign-in')
const { outsideAppOf } = await import('@solus/contracts/outside-apps')
const { PairApprovals } = await import('@solus/server/admission/pair-approvals')
const { serveMcpOAuth } = await import('@solus/server/transport/mcp-oauth')
const { serveMcp } = await import('@solus/server/transport/mcp-endpoint')

// WHY: an outside app (Claude Desktop, Cursor, a person's own CLI) reaches this
// host's tools only after the owner approves it, and only with the access the
// owner chose (plans/035 §10). The host is its own OAuth server, so this works
// on a host with no Solus account.

const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
const allowEverything = { appDenial: () => null, memberHasAccess: async () => true }
beforeEach(() => {
  installAppAccessChecks(allowEverything)
  dataDir = mkdtempSync(join(tmpdir(), 'solus-mcp-app-sign-in-'))
  process.env.SOLUS_DATA_DIR = dataDir
  auth.resetAuthStateForTests()
  resetAppSignInForTests()
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

function oauth(path: string, init: RequestInit & { json?: object; form?: Record<string, string> } = {}, options: { viaTunnel?: boolean; pairApprovals?: InstanceType<typeof PairApprovals> } = {}) {
  const headers = new Headers(init.headers)
  let requestBody = init.body
  if (init.json) { headers.set('content-type', 'application/json'); requestBody = JSON.stringify(init.json) }
  if (init.form) { headers.set('content-type', 'application/x-www-form-urlencoded'); requestBody = new URLSearchParams(init.form).toString() }
  return serveMcpOAuth(new Request(`${ORIGIN}${path}`, { ...init, headers, body: requestBody }), { viaTunnel: options.viaTunnel ?? false, remoteAddress: '127.0.0.1', hostName: 'Studio Mac', pairApprovals: options.pairApprovals })
}

async function register(): Promise<string> {
  const response = await oauth('/oauth/mcp/register', { method: 'POST', json: { client_name: 'Claude Desktop', redirect_uris: [REDIRECT] } })
  expect(response.status).toBe(201)
  return z.object({ client_id: z.string() }).parse(await response.json()).client_id
}

function authorizeParams(clientId: string) {
  return { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1' }
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
  const approved = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access, pairing_code: createAppPairingCode(approver).code } })
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
    expect(html).toContain('Claude Desktop wants to use Solus')
    expect(html).toContain('Studio Mac')
    // A client this host did not register, or a redirect it did not register, gets no page.
    expect((await oauth(`/oauth/mcp/authorize?${new URLSearchParams({ ...authorizeParams(clientId), redirect_uri: 'https://evil.example/cb' })}`)).status).toBe(400)
  })

  test('a pairing code from the owner approves; the code works once, with the verifier', async () => {
    const clientId = await register()
    const pairing = createAppPairingCode({ kind: 'owner' }).code
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

describe("an outside app's grant", () => {
  test('lists only the tools its access allows, and none that need a session', async () => {
    const read = await appClient(await signInWithPairingCode('read'))
    const readTools = (await read.listTools()).tools.map((tool) => tool.name)
    expect(readTools).toContain('list_works')
    expect(readTools).not.toContain('start_sessions')
    expect(readTools).not.toContain('move_checkout')
    await read.close()
    const write = await appClient(await signInWithPairingCode('write'))
    const writeTools = (await write.listTools()).tools.map((tool) => tool.name)
    expect(writeTools).toContain('start_sessions')
    // update_work needs approval: a write grant does not reach it.
    expect(writeTools).not.toContain('update_work')
    const refused = await write.callTool({ name: 'update_work', arguments: { work_id: 'w', expected_content_version: 0 } })
    expect(refused.isError).toBe(true)
    await write.close()
    const full = await appClient(await signInWithPairingCode('full'))
    expect((await full.listTools()).tools.map((tool) => tool.name)).toContain('update_work')
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
    const refused = await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access: 'write', pairing_code: createAppPairingCode(MEMBER).code } })
    expect(refused.status).toBe(403)
    expect(z.object({ error: z.string() }).parse(await refused.json()).error).toContain('does not allow')
    // The owner's own work is not that organization's.
    expect((await oauth('/oauth/mcp/approve', { method: 'POST', json: { ...authorizeParams(clientId), access: 'write', pairing_code: createAppPairingCode(OWNER).code } })).status).toBe(200)
  })

  test("a member's app stops when the member loses access to the host", async () => {
    const token = await signInWithPairingCode('read', MEMBER)
    installAppAccessChecks({ ...allowEverything, memberHasAccess: async () => false })
    const call = await serveMcp(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), { appsSignIn: true })
    expect(call.status).toBe(403)
  })
})
