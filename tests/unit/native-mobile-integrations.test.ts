import { describe, expect, test } from 'bun:test'
import { integrationUrlSchema, type Integration, type IntegrationConnection } from '@solus/contracts/integration-types'
import {
  afterCreate,
  appendCatalogEntries,
  catalogCountText,
  isNearEnd,
  connectFailed,
  connectFinished,
  connectReset,
  connectStarted,
  connectSubmitted,
  connectSubmitting,
  filterInstalled,
  installedStatus,
  isInstalled,
  mayLoadTools,
  needsConnection,
  probeRefusal,
  withConnection,
  type ConnectFlowState,
  type ConnectionListState,
  firstLine,
  isIntegrationUrl,
  isMissingOAuthClient,
  needsOAuthClient,
  OAUTH_CALLBACK_PATH,
  oauthClientText,
  isUnsupportedMethodError,
  upsertIntegration,
  urlHost,
  withoutIntegration,
} from '../../apps/mobile/src/features/settings/integrations'

// docs/plans/mcp-integrations.md §3.2 and §7 on the phone: Add checks the
// server and creates it in one step. Only a server the probe cannot place
// stops the add, with the reason in plain words. The phone accepts the same
// addresses the host does, without the `URL` object React Native implements
// only in part.

const signals: never[] = []

const record = (id: string, name: string, patch: Partial<Integration> = {}): Integration => ({
  id, organizationId: 'local', kind: 'mcp', slug: id, name, url: `https://${id}.example/mcp`,
  auth: { kind: 'none' }, createdBy: null, createdAt: '', updatedAt: '', ...patch,
})
const oauthAuth = (registration: 'dynamic' | 'client-required', clientId?: string): Integration['auth'] =>
  ({ kind: 'oauth', discover: 'https://example.com/.well-known/oauth-protected-resource', registration, ...(clientId ? { clientId } : {}) })
const connectionOf = (integrationId: string, patch: Partial<IntegrationConnection> = {}): IntegrationConnection => ({
  integrationId, status: 'connected', label: null, info: null, error: null, updatedAt: '', ...patch,
})
const loaded = (...connections: IntegrationConnection[]): ConnectionListState =>
  ({ kind: 'loaded', byIntegration: new Map(connections.map((connection) => [connection.integrationId, connection])) })

describe('one-step add', () => {
  test('a server the probe places is created at once; an undetermined one stops with the reason', () => {
    const tool = { name: 'ask', description: '', readOnly: true, destructive: false }
    expect(probeRefusal({ outcome: 'anonymous', auth: { kind: 'none' }, tools: [tool], signals })).toBeNull()
    expect(probeRefusal({ outcome: 'oauth', auth: { kind: 'oauth', discover: 'x', registration: 'dynamic' }, signals })).toBeNull()
    expect(probeRefusal({ outcome: 'credentials-required', auth: { kind: 'bearer', scheme: 'bearer' }, signals })).toBeNull()
    expect(probeRefusal({ outcome: 'undetermined', reason: 'not_mcp', signals })).toBe('This address does not answer as an MCP server.')
  })

  test('a new server that needs sign-in starts the sign-in at once', () => {
    expect(afterCreate({ auth: oauthAuth('dynamic') })).toBe('connect')
    expect(afterCreate({ auth: { kind: 'bearer', scheme: 'bearer' } })).toBe('connect')
    expect(afterCreate({ auth: oauthAuth('client-required', 'abc') })).toBe('connect')
  })

  test('a new server with no OAuth client opens on the client form, not a sign-in that cannot start', () => {
    expect(afterCreate({ auth: oauthAuth('client-required') })).toBe('oauth-client')
  })

  test('a new server without sign-in needs nothing more', () => {
    expect(afterCreate({ auth: { kind: 'none' } })).toBe('none')
  })

  test('a catalog entry whose address is installed says Added', () => {
    const list = [record('linear', 'Linear')]
    expect(isInstalled(list, 'https://linear.example/mcp')).toBe(true)
    expect(isInstalled(list, '  https://linear.example/mcp ')).toBe(true)
    expect(isInstalled(list, 'https://notion.example/mcp')).toBe(false)
  })
})

describe('catalog list', () => {
  const entry = (id: string) => ({ id, kind: 'mcp' as const, slug: id, name: id, description: '', domain: '', categories: [], popularity: null, url: `https://${id}.example/mcp` })

  test('the count groups thousands and reads in the singular for one', () => {
    expect(catalogCountText(1306)).toBe('1,306 servers')
    expect(catalogCountText(1)).toBe('1 server')
  })

  test('the next page goes below the shown entries, and an entry already shown is not repeated', () => {
    // WHY: the list grows in place, so the entries the person is reading never move.
    expect(appendCatalogEntries([entry('a'), entry('b')], [entry('b'), entry('c')]).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  test('more loads before the person reaches the end', () => {
    expect(isNearEnd(800, 1000, 2100)).toBe(true)
    expect(isNearEnd(800, 0, 2100)).toBe(false)
  })
})

describe('installed search', () => {
  const list = [record('linear', 'Linear'), record('gh', 'GitHub', { url: 'https://api.githubcopilot.com/mcp' })]

  test('the search finds an installed server by name, slug, or address host', () => {
    expect(filterInstalled(list, 'lin').map((entry) => entry.id)).toEqual(['linear'])
    expect(filterInstalled(list, 'GH').map((entry) => entry.id)).toEqual(['gh'])
    expect(filterInstalled(list, 'copilot').map((entry) => entry.id)).toEqual(['gh'])
    expect(filterInstalled(list, 'notion')).toEqual([])
  })

  test('an empty search shows every installed server', () => {
    expect(filterInstalled(list, '  ')).toHaveLength(2)
  })
})

describe('integration address', () => {
  const cases = [
    'https://mcp.deepwiki.com/mcp',
    'https://example.com',
    'https://example.com:8443/sse',
    '  https://example.com/mcp  ',
    'http://example.com/mcp',
    'https://user:pass@example.com/mcp',
    'https://user@example.com/mcp',
    'https://example.com/mcp?key=1',
    'https://example.com/mcp#top',
    'https://example.com/{tenant}/mcp',
    'https://example.com/%7Btenant%7D/mcp',
    'https://',
    'mcp.deepwiki.com/mcp',
    '',
  ]

  test('the phone accepts exactly the addresses the host accepts', () => {
    for (const value of cases) {
      expect({ value, accepted: isIntegrationUrl(value) }).toEqual({ value, accepted: integrationUrlSchema.safeParse(value).success })
    }
  })

  test('a row shows the host of the address', () => {
    expect(urlHost('https://mcp.deepwiki.com/mcp')).toBe('mcp.deepwiki.com')
    expect(urlHost('https://example.com:8443/sse')).toBe('example.com')
  })
})

describe('integration list', () => {
  test('a created or renamed integration takes its place by name, once', () => {
    const list = [record('a', 'Alpha'), record('c', 'Charlie')]
    expect(upsertIntegration(list, record('b', 'bravo')).map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(upsertIntegration(list, record('a', 'Zulu')).map((entry) => entry.id)).toEqual(['c', 'a'])
    expect(withoutIntegration(list, 'a').map((entry) => entry.id)).toEqual(['c'])
  })

  test('a tool row shows the first line of its description', () => {
    expect(firstLine('\n  Ask a question.\nMore detail.')).toBe('Ask a question.')
  })

  test('an older host without the methods reads as unsupported, not as an error', () => {
    expect(isUnsupportedMethodError('Unknown method "integrationList"')).toBe(true)
    expect(isUnsupportedMethodError('SolusServer: no handler for "integrationList"')).toBe(true)
    expect(isUnsupportedMethodError('Not allowed')).toBe(false)
  })
})

// §4 on the phone: each person sees their own connection, and one sign-in
// moves from Connect to the end the host reports. A phone's browser cannot
// reach the host, so the flow usually asks for the address it ended on.

describe('installed status', () => {
  const linear = record('linear', 'Linear', { auth: oauthAuth('dynamic') })

  test('a server without sign-in is Ready and offers no Connect', () => {
    expect(installedStatus(record('wiki', 'Wiki'), loaded())).toEqual({ text: 'Ready', tone: 'muted', action: null })
  })

  test('no connection reads as Not connected and offers Connect on the row', () => {
    expect(installedStatus(linear, loaded())).toEqual({ text: 'Not connected', tone: 'muted', action: 'connect' })
  })

  test('a connection names the account it signed in as', () => {
    expect(installedStatus(linear, loaded(connectionOf('linear', { label: 'ada@example.com' }))).text).toBe('Connected as ada@example.com')
    expect(installedStatus(linear, loaded(connectionOf('linear', { info: { displayName: 'Ada' } }))).text).toBe('Connected as Ada')
    expect(installedStatus(linear, loaded(connectionOf('linear')))).toEqual({ text: 'Connected', tone: 'muted', action: null })
  })

  test('a lapsed or failed connection offers Reconnect on the row', () => {
    expect(installedStatus(linear, loaded(connectionOf('linear', { status: 'needs-sign-in' })))).toEqual({ text: 'Needs sign-in', tone: 'danger', action: 'reconnect' })
    expect(installedStatus(linear, loaded(connectionOf('linear', { status: 'error', error: 'invalid_grant' })))).toEqual({ text: 'Connection error', tone: 'danger', action: 'reconnect' })
  })

  test('a server with no OAuth client asks for one and offers no Connect that would fail', () => {
    expect(installedStatus(record('x', 'X', { auth: oauthAuth('client-required') }), loaded())).toEqual({ text: 'Needs an OAuth client', tone: 'danger', action: null })
  })

  test('while the connections are read, the row does not claim Not connected', () => {
    expect(installedStatus(linear, { kind: 'loading' })).toMatchObject({ action: null })
    expect(installedStatus(linear, { kind: 'loading' }).text).not.toBe('Not connected')
  })

  test('only an integration with sign-in has a connection', () => {
    expect(needsConnection({ auth: { kind: 'none' } })).toBe(false)
    expect(needsConnection({ auth: { kind: 'bearer', scheme: 'bearer' } })).toBe(true)
  })

  test('a changed connection replaces the old one; a disconnect removes it', () => {
    const before = new Map([['linear', connectionOf('linear', { status: 'needs-sign-in' })]])
    expect(withConnection(before, 'linear', connectionOf('linear', { label: 'Ada' })).get('linear')?.status).toBe('connected')
    expect(withConnection(before, 'linear', null).has('linear')).toBe(false)
    expect(before.get('linear')?.status).toBe('needs-sign-in')
  })
})

// Opening a server that is not connected must not ask it for tools: it can
// only answer with an error. The row says to connect instead.
describe('tools of an installed server', () => {
  const linear = record('linear', 'Linear', { auth: oauthAuth('dynamic') })

  test('tools are read from a server without sign-in', () => {
    expect(mayLoadTools(record('wiki', 'Wiki'), loaded())).toBe(true)
    expect(mayLoadTools(record('wiki', 'Wiki'), { kind: 'loading' })).toBe(true)
  })

  test('tools are not requested for an oauth integration with no connection', () => {
    expect(mayLoadTools(linear, loaded())).toBe(false)
  })

  test('tools are not requested while the connection lapsed, failed, or is still being read', () => {
    expect(mayLoadTools(linear, loaded(connectionOf('linear', { status: 'needs-sign-in' })))).toBe(false)
    expect(mayLoadTools(linear, loaded(connectionOf('linear', { status: 'error' })))).toBe(false)
    expect(mayLoadTools(linear, { kind: 'loading' })).toBe(false)
  })

  test('tools are read once the person is connected', () => {
    expect(mayLoadTools(linear, loaded(connectionOf('linear')))).toBe(true)
  })
})

describe('connect flow', () => {
  const waiting = connectStarted({ kind: 'waiting', flowId: 'f1', url: 'https://auth.example/authorize', input: 'redirect-url', expiresAt: '' }, 'Linear')
  const finished = (outcome: 'connected' | 'failed' | 'cancelled', message?: string, flowId = 'f1') =>
    connectFinished(waiting, { flowId, integrationId: 'linear', outcome, message }, 'Linear')

  test('a browser sign-in waits for the address the browser ended on', () => {
    expect(waiting).toEqual({ step: 'waiting', flowId: 'f1', url: 'https://auth.example/authorize', input: 'redirect-url', expiresAt: '', submitted: false, busy: false, error: null })
  })

  test('a key integration asks for the key; an integration with nothing to do is connected at once', () => {
    expect(connectStarted({ kind: 'token', integrationId: 'linear' }, 'Linear')).toEqual({ step: 'token', busy: false, error: null })
    const connection: IntegrationConnection = { integrationId: 'linear', status: 'connected', label: null, info: null, error: null, updatedAt: '' }
    expect(connectStarted({ kind: 'connected', connection }, 'Linear')).toEqual({ step: 'finished', ok: true, message: 'Connected to Linear.' })
  })

  test('a pasted address waits for the host; only the host ends the browser sign-in', () => {
    const sending = connectSubmitting(waiting)
    expect(sending).toMatchObject({ busy: true, error: null })
    expect(connectSubmitted(sending, 'Linear')).toMatchObject({ step: 'waiting', busy: false, submitted: true })
  })

  test('a stored key is the end of a key flow', () => {
    const sending = connectSubmitting({ step: 'token', busy: false, error: null })
    expect(connectSubmitted(sending, 'Linear')).toEqual({ step: 'finished', ok: true, message: 'Connected to Linear.' })
  })

  test('a refused submit keeps the flow open and says why', () => {
    expect(connectFailed(connectSubmitting(waiting), 'The address has no code')).toMatchObject({ step: 'waiting', busy: false, error: 'The address has no code' })
    const done: ConnectFlowState = { step: 'finished', ok: true, message: 'x' }
    expect(connectFailed(done, 'late')).toBe(done)
  })

  test('the host ends the flow it names, and no other', () => {
    expect(finished('connected')).toEqual({ step: 'finished', ok: true, message: 'Connected to Linear.' })
    expect(finished('failed')).toEqual({ step: 'finished', ok: false, message: 'Linear did not connect.' })
    expect(finished('failed', 'access_denied')).toEqual({ step: 'finished', ok: false, message: 'access_denied' })
    expect(finished('cancelled')).toBeNull()
    expect(finished('connected', undefined, 'f0')).toBe(waiting)
  })

  test('a reset finishes a waiting flow, since its end may have been missed', () => {
    expect(connectReset(waiting)).toEqual({ step: 'finished', ok: false, message: 'The connection to the host was reset. Connect again.' })
    const token: ConnectFlowState = { step: 'token', busy: false, error: null }
    expect(connectReset(token)).toBe(token)
  })
})

// §4.3 on the phone: a server with no dynamic registration asks an
// administrator for an OAuth client before anyone can connect, and shows the
// redirect path the service's OAuth app must list.
describe('administrator OAuth client', () => {
  const oauth = (registration: 'dynamic' | 'metadata-document' | 'client-required', client?: { clientId: string; hasClientSecret?: boolean }) =>
    ({ auth: { kind: 'oauth', discover: 'https://example.com/.well-known/oauth-protected-resource', registration, ...client } }) satisfies Pick<Integration, 'auth'>

  test('only an OAuth server that cannot register Solus asks for a client', () => {
    expect(needsOAuthClient(oauth('client-required'))).toBe(true)
    expect(needsOAuthClient(oauth('client-required', { clientId: 'abc' }))).toBe(true)
    expect(needsOAuthClient(oauth('dynamic'))).toBe(false)
    expect(needsOAuthClient(oauth('metadata-document'))).toBe(false)
    expect(needsOAuthClient({ auth: { kind: 'bearer', scheme: 'bearer' } })).toBe(false)
    expect(needsOAuthClient({ auth: { kind: 'none' } })).toBe(false)
  })

  test('Connect waits for the client ID; a secret is not required', () => {
    expect(isMissingOAuthClient(oauth('client-required'))).toBe(true)
    expect(isMissingOAuthClient(oauth('client-required', { clientId: 'abc' }))).toBe(false)
    expect(isMissingOAuthClient(oauth('client-required', { clientId: 'abc', hasClientSecret: true }))).toBe(false)
    expect(isMissingOAuthClient(oauth('dynamic'))).toBe(false)
    expect(oauthClientText.connectBlocked).toBe('Enter the OAuth client first')
  })

  test('the redirect path is the host callback, which the phone shows on the host address', () => {
    expect(OAUTH_CALLBACK_PATH).toBe('/oauth/integration/callback')
    expect(oauthClientText.redirectNote).toContain("on the host's address")
  })

  test('the form says whether a secret is saved and never claims to show it', () => {
    expect(oauthClientText.secretSaved).toBe('Secret saved')
    expect(oauthClientText.noSecret).toBe('No secret')
    expect(oauthClientText.clientSecretNote).toContain('stays on the host')
  })
})
