import { describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpOAuth } from '@solus/contracts/integrations/oauth-protocol'
import { probeAddress } from '@solus/server/integrations/integration-create'
import { googleCalendarServer, GOOGLE_CALENDAR_SCOPES } from '@solus/server/integrations/solus-servers/google-calendar'
import { boundFetch, solusMcpServer, SolusServerAuthError, vendorJson, type SolusSessionDeps } from '@solus/server/integrations/solus-servers/solus-server'

// The gateway's input requests open the session store, which Bun reads through its own SQLite.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/**
 * Solus MCP servers (docs/plans/mcp-integrations.md §13.6). What matters: the
 * server is an ordinary MCP server to the gateway, its tools reach only the
 * vendor's hosts with the person's current token, a refused token asks for a
 * new sign-in, and Google's sign-in asks for what a refresh token needs.
 */

interface Recorded { url: string; method: string; authorization: string | null; redirect: RequestRedirect | undefined }

function fakeVendor(answer: (url: URL) => Response = () => Response.json({ items: [] })) {
  const requests: Recorded[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    requests.push({ url: url.href, method: init?.method ?? 'GET', authorization: headers.get('authorization'), redirect: init?.redirect })
    return answer(url)
  }) as typeof fetch
  return { fetchImpl, requests }
}

async function connected(deps: SolusSessionDeps) {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  await solusMcpServer(googleCalendarServer, deps).connect(serverEnd)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(clientEnd)
  return client
}

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? '').join('')

describe('a Solus MCP server', () => {
  test('lists its tools with the hints approval and reads across accounts rely on', async () => {
    const client = await connected({ authorization: async () => 'Bearer t', onRefused: () => {} })
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    expect([...byName.keys()].sort()).toEqual(['create_event', 'delete_event', 'find_free_busy', 'list_calendars', 'list_events', 'update_event'])
    // WHY: `destructiveHint` makes the provider ask before the call; `readOnlyHint` lets it run.
    expect(byName.get('delete_event')?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false })
    expect(byName.get('list_events')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(byName.get('list_events')?.inputSchema.type).toBe('object')
  })

  test('a call reaches the vendor with the token read at that moment, and no redirect', async () => {
    const vendor = fakeVendor()
    let token = 'first'
    const client = await connected({ authorization: async () => `Bearer ${token}`, onRefused: () => {}, fetch: vendor.fetchImpl })
    await client.callTool({ name: 'list_events', arguments: { timeMin: '2026-10-23T00:00:00Z', timeMax: '2026-10-24T00:00:00Z' } })
    token = 'refreshed'
    await client.callTool({ name: 'list_calendars', arguments: {} })
    // WHY: a token the host refreshed must be used without a new session.
    expect(vendor.requests.map((request) => request.authorization)).toEqual(['Bearer first', 'Bearer refreshed'])
    expect(new URL(vendor.requests[0].url).pathname).toBe('/calendar/v3/calendars/primary/events')
    expect(vendor.requests.every((request) => request.redirect === 'error')).toBe(true)
  })

  test('a refused token marks the connection for a new sign-in', async () => {
    const refused: SolusServerAuthError[] = []
    const vendor = fakeVendor(() => new Response('{}', { status: 401 }))
    const client = await connected({ authorization: async () => 'Bearer old', onRefused: (error) => refused.push(error), fetch: vendor.fetchImpl })
    const result = await client.callTool({ name: 'list_calendars', arguments: {} })
    expect(result.isError).toBe(true)
    expect(refused).toHaveLength(1)
  })

  test('input that does not match the schema is refused before any request', async () => {
    const vendor = fakeVendor()
    const client = await connected({ authorization: async () => 'Bearer t', onRefused: () => {}, fetch: vendor.fetchImpl })
    const result = await client.callTool({ name: 'delete_event', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Invalid input')
    expect(vendor.requests).toEqual([])
  })
})

describe('the bound fetch', () => {
  test('refuses a host the server does not name, before any request', async () => {
    // WHY: the person's token must reach only the vendor (§4.1 rule 4).
    const vendor = fakeVendor()
    const fetchFor = boundFetch(googleCalendarServer, { authorization: async () => 'Bearer t', onRefused: () => {}, fetch: vendor.fetchImpl }, new AbortController().signal)
    await expect(fetchFor('https://evil.example/steal')).rejects.toThrow('may not reach evil.example')
    await expect(fetchFor('http://www.googleapis.com/calendar/v3')).rejects.toThrow()
    expect(vendor.requests).toEqual([])
  })
})

describe('Google sign-in for a Solus server', () => {
  test('asks for the Calendar scopes and offline access, without a resource', async () => {
    const oauth = new McpOAuth({ fetch, now: Date.now })
    const metadata = { authorizationEndpoint: new URL('https://accounts.google.com/o/oauth2/v2/auth'), tokenEndpoint: new URL('https://oauth2.googleapis.com/token') }
    const { url } = await oauth.authorization({
      metadata,
      client: { clientId: 'client-1', tokenEndpointAuthMethod: 'client_secret_post', redirectUris: [] },
      redirectUri: 'http://127.0.0.1:4100/oauth/integration/callback',
      options: { ...googleCalendarServer.auth.sign, params: { ...googleCalendarServer.auth.sign.params, client_id: 'attacker' } },
    })
    const params = new URL(url).searchParams
    // WHY: `openid email` names the account, so several accounts read the same in every Google server.
    expect(params.get('scope')?.split(' ')).toEqual(['openid', 'email', ...GOOGLE_CALENDAR_SCOPES])
    // WHY: Google returns a refresh token only for offline access on consent; without it the connection ends in an hour.
    expect(params.get('access_type')).toBe('offline')
    // WHY: without the chooser, a browser signed in to one Google account connects it again on "Add another account".
    expect(params.get('prompt')).toBe('select_account consent')
    expect(params.has('resource')).toBe(false)
    // WHY: a server's parameters must not replace the protocol's own.
    expect(params.get('client_id')).toBe('client-1')
  })
})

describe('probing a solus: address', () => {
  test('the server\'s code decides its auth, with no request', async () => {
    expect(await probeAddress('solus:google-calendar')).toEqual({
      outcome: 'oauth',
      auth: { kind: 'oauth', discover: 'https://accounts.google.com/.well-known/openid-configuration', registration: 'client-required' },
      signals: [],
    })
  })

  test('a server this build does not have is refused', async () => {
    expect(await probeAddress('solus:unknown-server')).toMatchObject({ outcome: 'undetermined', reason: 'not_mcp' })
  })
})

describe('the gateway and a solus integration', () => {
  test('opens the Solus server in the host and lists its tools for the person', async () => {
    const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
    const { withActingScope } = await import('@solus/server/vault/acting-scope')
    const { HOST_IDENTITY } = await import('@solus/server/execution/seats/acting-identity')
    const integration = {
      id: 'int-cal', organizationId: 'local', ownerKey: 'member-1', kind: 'solus' as const, slug: 'google-calendar', name: 'Google Calendar',
      url: 'solus:google-calendar', auth: { kind: 'oauth' as const, discover: googleCalendarServer.auth.discover, registration: 'client-required' as const },
      disabledTools: [], createdBy: null, createdAt: '', updatedAt: '',
    }
    const gateway = new IntegrationGateway({ get: () => integration, list: () => [integration] })
    const asked: string[] = []
    gateway.useCredentials({
      authorizationFor: async (_id, personKey) => { asked.push(personKey); return 'Bearer member-token' },
      markNeedsSignIn: () => {},
      statusFor: () => null,
    })
    const tools = await withActingScope({ identity: HOST_IDENTITY, personKey: 'member-1' }, () => gateway.toolsFor('int-cal', 'member-1'))
    expect(tools.map((tool) => tool.name)).toContain('list_events')
    // WHY: the session belongs to the person whose credential it was opened with (§4.1).
    expect(asked).toEqual(['member-1'])
    await gateway.close()
  })
})

describe('several accounts on one integration (§13.3)', () => {
  test('a read spans every account; a write needs one named', async () => {
    const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
    const { withActingScope } = await import('@solus/server/vault/acting-scope')
    const { HOST_IDENTITY } = await import('@solus/server/execution/seats/acting-identity')
    const integration = {
      id: 'int-cal2', organizationId: 'local', ownerKey: 'member-1', kind: 'solus' as const, slug: 'google-calendar', name: 'Google Calendar',
      url: 'solus:google-calendar', auth: { kind: 'oauth' as const, discover: googleCalendarServer.auth.discover, registration: 'client-required' as const },
      disabledTools: [], createdBy: null, createdAt: '', updatedAt: '',
    }
    const account = (accountId: string, label: string) => ({ integrationId: 'int-cal2', accountId, status: 'connected' as const, source: 'host' as const, label, info: null, error: null, updatedAt: '' })
    const gateway = new IntegrationGateway({ get: () => integration, list: () => [integration] })
    gateway.useCredentials({
      authorizationFor: async (_id, _person, accountId) => `Bearer token-${accountId ?? 'default'}`,
      markNeedsSignIn: () => {},
      accountsFor: () => [account('default', 'work@example.com'), account('second', 'me@example.com')],
    })
    const seen: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '')
      return Response.json({ items: [] })
    }) as typeof fetch
    const context = { provider: 'claude-code' as const, cwd: '/tmp', sessionId: () => undefined, abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {} }
    const asMember = <T>(fn: () => T) => withActingScope({ identity: HOST_IDENTITY, personKey: 'member-1' }, fn)
    try {
      const read = await asMember(() => gateway.call('int-cal2', 'list_calendars', {}, context))
      // WHY: a read the person did not narrow shows every account, each part named.
      expect(seen.sort()).toEqual(['Bearer token-default', 'Bearer token-second'])
      expect(read.text).toContain('## work@example.com')
      expect(read.text).toContain('## me@example.com')

      seen.length = 0
      const unnamed = await asMember(() => gateway.call('int-cal2', 'delete_event', { eventId: 'e1' }, context))
      // WHY: a write must never guess which account to change.
      expect(unnamed.ok).toBe(false)
      expect(unnamed.text).toContain('work@example.com, me@example.com')
      expect(seen).toEqual([])

      await asMember(() => gateway.call('int-cal2', 'delete_event', { eventId: 'e1', solus_account: 'me@example.com' }, context))
      expect(seen).toEqual(['Bearer token-second'])
      expect(gateway.accountChoices('int-cal2', 'member-1')).toEqual(['work@example.com', 'me@example.com'])
    } finally {
      globalThis.fetch = realFetch
      await gateway.close()
    }
  })
})

describe('a vendor answer', () => {
  test('an error page that is not JSON reads as its status', async () => {
    // WHY: the agent must learn the service is down, not see a JSON parse error.
    await expect(vendorJson(new Response('<html>Bad gateway</html>', { status: 503 }))).rejects.toThrow('The service answered HTTP 503.')
    await expect(vendorJson(Response.json({ error: { message: 'Not found' } }, { status: 404 }))).rejects.toThrow('Not found')
    expect(await vendorJson(Response.json({ items: [] }))).toEqual({ items: [] })
  })
})
