import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { firstPartyClientById } from '@solus/contracts/first-party-clients'
import { SOLUS_SERVERS } from '@solus/server/integrations/solus-servers'
import { GoogleSolusServer } from '@solus/server/integrations/solus-servers/google'
import { boundFetch, solusMcpServer } from '@solus/server/integrations/solus-servers/solus-server'

/**
 * The Google suite as Solus MCP servers (docs/plans/mcp-integrations.md
 * §13.6), one per product. What matters: each sign-in asks for scopes Solus's
 * Google app may hold (a scope it may not hold is dropped and the tools fail
 * at Google), every tool that cannot be undone asks the user first, every
 * account is labelled by its email, and a server lists its tools to the
 * gateway like any MCP server.
 */

const GOOGLE_SERVERS = SOLUS_SERVERS.filter((server) => server instanceof GoogleSolusServer)

/** Tool names whose effect cannot be undone; the provider must ask before each. */
const IRREVERSIBLE = /^(delete|trash|send|share|clear|end)_/

test('the suite is all here', () => {
  expect(GOOGLE_SERVERS.map((server) => server.id).sort()).toEqual([
    'gmail', 'google-calendar', 'google-contacts', 'google-docs', 'google-drive', 'google-forms',
    'google-meet', 'google-search-console', 'google-sheets', 'google-slides', 'google-tasks',
  ])
})

describe.each(GOOGLE_SERVERS.map((server) => [server.name, server] as const))('%s', (_name, server) => {
  test('asks only for scopes Solus\'s Google app may hold', () => {
    const scopes = server.auth.sign.scopes ?? []
    // WHY: the sign-in drops a scope the app may not hold, and every tool that needs it then fails.
    expect(firstPartyClientById('google').scopesAllowed(scopes)).toEqual([...scopes])
    expect(scopes).toEqual(expect.arrayContaining(['openid', 'email']))
  })

  test('every tool that cannot be undone asks first, and none both reads only and destroys', () => {
    for (const tool of server.tools) {
      if (IRREVERSIBLE.test(tool.name)) expect({ tool: tool.name, destructive: tool.destructive }).toEqual({ tool: tool.name, destructive: true })
      expect(tool.readOnly && tool.destructive).toBe(false)
    }
    expect(new Set(server.tools.map((tool) => tool.name)).size).toBe(server.tools.length)
  })

  test('lists its tools to the gateway as an MCP server', async () => {
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
    await solusMcpServer(server, { authorization: async () => 'Bearer t', onRefused: () => {} }).connect(serverEnd)
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(clientEnd)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(server.tools.map((tool) => tool.name).sort())
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object')
    await client.close()
  })

  test('labels the account by its Google email', async () => {
    const asked: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      asked.push(String(input))
      return Response.json({ email: 'ada@example.com', sub: '1' })
    }) as typeof fetch
    const context = { fetch: boundFetch(server, { authorization: async () => 'Bearer t', onRefused: () => {}, fetch: fetchImpl }, new AbortController().signal), signal: new AbortController().signal }
    // WHY: the label is how "Add another account" refuses a duplicate and how tools name each account.
    expect(await server.identify(context)).toBe('ada@example.com')
    expect(asked).toEqual(['https://openidconnect.googleapis.com/v1/userinfo'])
  })
})
