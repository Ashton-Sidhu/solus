import { describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from '../helpers/bun-sqlite'
import { firstPartyClientById, firstPartyClientFor } from '@solus/contracts/first-party-clients'
import type { Integration } from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'

mock.module('node:sqlite', () => ({ DatabaseSync }))
// A build with Solus's GitHub and Google apps; a development build has neither.
mock.module('@solus/server/providers/github/client-id', () => ({ GITHUB_CLIENT_ID: 'solus-github' }))
mock.module('@solus/server/google/client-id', () => ({ GOOGLE_CLIENT_ID: 'solus-google' }))
mock.module('@solus/server/google/client-secret', () => ({ GOOGLE_CLIENT_SECRET: 'desktop-secret' }))

/**
 * First-party clients (docs/plans/mcp-integrations.md §13.1). What matters: a
 * server signs in through Solus's app only when its authorization server is
 * exactly that vendor's, the app asks for nothing it is not allowed, the
 * owner's own client still wins, and GitHub reuses the person's Solus GitHub
 * connection instead of a second sign-in.
 */

const GITHUB_MCP: Integration = {
  id: 'int-gh', organizationId: 'local', ownerKey: 'member-1', kind: 'mcp', slug: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/',
  auth: { kind: 'oauth', discover: 'https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/', registration: 'client-required', firstParty: 'github' },
  disabledTools: [], createdBy: null, createdAt: '', updatedAt: '',
}

describe('the registry', () => {
  test('matches an authorization server only by its exact endpoints', () => {
    expect(firstPartyClientFor({ authorizationEndpoint: 'https://github.com/login/oauth/authorize', tokenEndpoint: 'https://github.com/login/oauth/access_token' })?.id).toBe('github')
    // WHY: a look-alike server must never receive Solus's app (Executor's rule).
    expect(firstPartyClientFor({ authorizationEndpoint: 'https://github.com.evil.example/login/oauth/authorize', tokenEndpoint: 'https://github.com/login/oauth/access_token' })).toBeNull()
  })

  test('a sign-in asks only for scopes the app may hold', () => {
    const google = firstPartyClientById('google')
    expect(google.scopesAllowed(['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/cloud-platform'])).toEqual(['https://www.googleapis.com/auth/calendar.events'])
  })

  test('Solus\'s Google app may hold Executor\'s Google scopes, and still the ones Solus already asks for', () => {
    const google = firstPartyClientById('google')
    const wanted = ['https://mail.google.com/', 'https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/drive.readonly']
    expect(google.scopesAllowed(wanted)).toEqual(wanted)
    // WHY: an unknown scope stays out even when a server asks for it.
    expect(google.scopesAllowed(['https://www.googleapis.com/auth/cloud-platform'])).toEqual([])
  })

  test('disconnecting a token of Solus\'s Google app does not revoke it at Google', async () => {
    const { IntegrationOAuth } = await import('@solus/server/integrations/oauth')
    const calls: string[] = []
    const oauth = new IntegrationOAuth({
      // SAFETY: revoke reaches none of these for a first-party Google token.
      connections: {} as never, integrations: { get: () => null }, vault: { save: () => {} }, clients: {} as never,
      events: { connectionChanged: () => {}, authFinished: () => {} },
      fetch: async (input) => { calls.push(String(input)); return new Response('{}') },
    })
    const calendar: Integration = { ...GITHUB_MCP, id: 'int-cal', url: 'solus:google-calendar', auth: { kind: 'oauth', discover: 'https://accounts.google.com/.well-known/openid-configuration', registration: 'client-required', firstParty: 'google' } }
    await oauth.revoke(calendar, { accessToken: 'a', tokenType: 'Bearer', refreshToken: 'r', clientId: 'solus-google' })
    // WHY: Google ends every grant a person gave one app at once — their other Google integrations and Solus's Google connection with it.
    expect(calls).toEqual([])
  })

  test('a first-party server needs no client form and no hand-off; the owner\'s client still counts', () => {
    expect(new IntegrationSignIn(GITHUB_MCP).needsOwnerClient).toBe(false)
    expect(new IntegrationSignIn(GITHUB_MCP).setupNeed).toBeNull()
    expect(new IntegrationSignIn({ auth: { kind: 'oauth', discover: 'x', registration: 'client-required' }, url: 'https://x.example/mcp' }).needsOwnerClient).toBe(true)
  })
})

describe('first-party clients on this host', () => {
  test('the build\'s apps are offered; Google\'s runs the OAuth flow, GitHub\'s does not', async () => {
    const { firstPartyFor, firstPartyOAuthClient } = await import('@solus/server/integrations/first-party')
    expect(firstPartyFor({ authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token' }, 'solus:google-calendar')).toBe('google')
    expect(firstPartyOAuthClient('google')).toMatchObject({ clientId: 'solus-google', clientSecret: 'desktop-secret' })
    // GitHub's credential is the person's Solus GitHub connection, not an OAuth flow here.
    expect(firstPartyOAuthClient('github')).toBeNull()
  })

  test('only the vendor\'s own MCP server gets Solus\'s app, never another server that names its authorization server', async () => {
    const { firstPartyFor } = await import('@solus/server/integrations/first-party')
    const github = { authorizationEndpoint: 'https://github.com/login/oauth/authorize', tokenEndpoint: 'https://github.com/login/oauth/access_token' }
    const google = { authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token' }
    expect(firstPartyFor(github, 'https://api.githubcopilot.com/mcp/')).toBe('github')
    // WHY: any server can name GitHub's or Google's authorization server; it would then receive the person's Solus GitHub token or a token of Solus's Google app.
    expect(firstPartyFor(github, 'https://mcp.attacker.example/mcp')).toBeUndefined()
    expect(firstPartyFor(google, 'https://mcp.attacker.example/mcp')).toBeUndefined()
    // A record stored with a first-party client is checked again by its address on every use.
    expect(new IntegrationSignIn({ ...GITHUB_MCP, url: 'https://mcp.attacker.example/mcp' }).firstParty).toBeNull()
    expect(new IntegrationSignIn(GITHUB_MCP).firstParty).toBe('github')
  })

  test('a Solus Calendar server signs in with Solus\'s Google app', async () => {
    const { probeAddress } = await import('@solus/server/integrations/integration-create')
    expect(await probeAddress('solus:google-calendar')).toMatchObject({ outcome: 'oauth', auth: { firstParty: 'google' } })
  })
})

describe('GitHub through the Solus GitHub connection', () => {
  async function connectionsWith(credential: { token: string; label: string | null } | null, rowStatus: 'connected' | 'needs-sign-in' | null = 'connected') {
    const { IntegrationConnections } = await import('@solus/server/integrations/connections')
    const rows: Array<{ integrationId: string; status: string; label: string | null | undefined }> = []
    const store = {
      get: () => (rowStatus ? { integrationId: 'int-gh', accountId: 'default', status: rowStatus, source: 'host' as const, label: null, info: null, error: null, updatedAt: '' } : null),
      upsert: (integrationId: string, _person: string, write: { status: string; label?: string | null }) => {
        rows.push({ integrationId, status: write.status, label: write.label })
        return { integrationId, accountId: 'default', status: 'connected' as const, source: 'host' as const, label: write.label ?? null, info: null, error: null, updatedAt: '' }
      },
    }
    const asked: string[] = []
    const connections = new IntegrationConnections({
      // SAFETY: the tests below reach only `get` and `upsert` of the store.
      store: store as never,
      integrations: { get: () => GITHUB_MCP, list: () => [GITHUB_MCP] },
      vault: { read: async () => null, save: () => {}, remove: () => null, upload: async () => ({ kind: 'unreachable' as const }), forget: () => {} },
      clients: { removeClient: () => {} },
      // SAFETY: a GitHub first-party connection never reaches the OAuth flow.
      oauth: {} as never,
      events: { connectionChanged: () => {}, authFinished: () => {} },
      firstPartyCredential: async (_client, personKey) => { asked.push(personKey); return credential },
    })
    return { connections, rows, asked }
  }

  test('a call sends the person\'s Solus GitHub token, read as that person', async () => {
    const { connections, asked } = await connectionsWith({ token: 'gho_member', label: 'octocat' })
    expect(await connections.authorizationFor('int-gh', 'member-1')).toBe('Bearer gho_member')
    expect(asked).toEqual(['member-1'])
  })

  test('after Disconnect or a refusal, no call sends the GitHub token', async () => {
    // WHY: the token is the person's Solus GitHub connection and outlives this server's row; the row decides.
    expect(await (await connectionsWith({ token: 'gho_member', label: null }, null)).connections.authorizationFor('int-gh', 'member-1')).toBeNull()
    expect(await (await connectionsWith({ token: 'gho_member', label: null }, 'needs-sign-in')).connections.authorizationFor('int-gh', 'member-1')).toBeNull()
  })

  test('connecting needs no sign-in, and is refused plainly without a GitHub connection', async () => {
    const connected = await connectionsWith({ token: 'gho_member', label: 'octocat' })
    expect((await connected.connections.connectFirstParty(GITHUB_MCP, 'member-1')).label).toBe('octocat')
    const none = await connectionsWith(null)
    await expect(none.connections.connectFirstParty(GITHUB_MCP, 'member-1')).rejects.toThrow('Connect GitHub to Solus first')
  })
})
