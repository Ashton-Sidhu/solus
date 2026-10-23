import { describe, expect, test } from 'bun:test'
import type { DocumentSyncClock } from '@solus/client-core/document-sync'
import type { AccountVaultConnectResult, AccountVaultResult } from '@solus/contracts/host-api'
import { integrationUrlSchema, type Integration, type IntegrationConnection } from '@solus/contracts/integration-types'
import type { VaultConnection } from '@solus/contracts/vault'
import {
  appendCatalogEntries,
  catalogCountText,
  isNearEnd,
  cloudConnectStarted,
  connectFailed,
  connectFinished,
  connectReset,
  connectsThroughCloud,
  connectStarted,
  connectSubmitted,
  connectSubmitting,
  filterInstalled,
  connectionMap,
  extraAccountMap,
  withExtraAccount,
  withAddFinished,
  InstalledIntegration,
  type AddingAccount,
  isInstalled,
  probeRefusal,
  withConnection,
  type ConnectFlowState,
  type ConnectionListState,
  firstLine,
  isIntegrationUrl,
  OAUTH_CALLBACK_PATH,
  oauthClientText,
  isUnsupportedMethodError,
  upsertIntegration,
  urlHost,
  withoutIntegration,
} from '../../apps/mobile/src/features/settings/integrations'
import { CLOUD_CONNECT_POLL_MS, CLOUD_CONNECT_TIMEOUT_MS, CloudConnect, type CloudConnectRequests } from '../../apps/mobile/src/features/settings/lib/cloud-connect'

// docs/plans/mcp-integrations.md §3.2 and §7 on the phone: Add checks the
// server and creates it in one step. Only a server the probe cannot place
// stops the add, with the reason in plain words. The phone accepts the same
// addresses the host does, without the `URL` object React Native implements
// only in part.

const signals: never[] = []

const record = (id: string, name: string, patch: Partial<Integration> = {}): Integration => ({
  id, organizationId: 'local', ownerKey: 'local:test', kind: 'mcp', slug: id, name, url: `https://${id}.example/mcp`,
  auth: { kind: 'none' }, createdBy: null, createdAt: '', updatedAt: '', ...patch,
})
const oauthAuth = (registration: 'dynamic' | 'client-required', clientId?: string): Integration['auth'] =>
  ({ kind: 'oauth', discover: 'https://example.com/.well-known/oauth-protected-resource', registration, ...(clientId ? { clientId } : {}) })
const connectionOf = (integrationId: string, patch: Partial<IntegrationConnection> = {}): IntegrationConnection => ({
  integrationId, status: 'connected', source: 'host', label: null, info: null, error: null, updatedAt: '', ...patch,
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
    expect(new InstalledIntegration({ id: 'x', url: 'https://x.example/mcp', auth: oauthAuth('dynamic') }).afterAdd).toBe('connect')
    expect(new InstalledIntegration({ id: 'x', url: 'https://x.example/mcp', auth: { kind: 'bearer', scheme: 'bearer' } }).afterAdd).toBe('connect')
    expect(new InstalledIntegration({ id: 'x', url: 'https://x.example/mcp', auth: oauthAuth('client-required', 'abc') }).afterAdd).toBe('connect')
  })

  test('a new server with no OAuth client opens on the client form, not a sign-in that cannot start', () => {
    expect(new InstalledIntegration({ id: 'x', url: 'https://x.example/mcp', auth: oauthAuth('client-required') }).afterAdd).toBe('oauth-client')
  })

  test('a new server without sign-in needs nothing more', () => {
    expect(new InstalledIntegration({ id: 'x', url: 'https://x.example/mcp', auth: { kind: 'none' } }).afterAdd).toBe('ready')
  })

  test('a catalog entry whose address is installed says Added', () => {
    const list = [record('linear', 'Linear')]
    expect(isInstalled(list, 'https://linear.example/mcp')).toBe(true)
    expect(isInstalled(list, '  https://linear.example/mcp ')).toBe(true)
    expect(isInstalled(list, 'https://notion.example/mcp')).toBe(false)
  })
})

describe('set up with an agent (§13.4)', () => {
  test('a server that needs a key or a client offers the hand-off until the person connects', () => {
    const keyed = record('keyed', 'Keyed', { auth: { kind: 'bearer', scheme: 'bearer' } })
    const clientless = record('zoom', 'Zoom', { auth: oauthAuth('client-required') })
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...keyed }).setupNeedFor(undefined)).toBe('api-key')
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...clientless }).setupNeedFor(connectionOf('zoom', { status: 'needs-sign-in' }))).toBe('oauth-client')
    // WHY: a connected server has nothing to set up, so the row must not offer it.
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...keyed }).setupNeedFor(connectionOf('keyed'))).toBeNull()
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...record('open', 'Open') }).setupNeedFor(undefined)).toBeNull()
  })
})

describe('several accounts (§13.3)', () => {
  test('the first account stays where every row reads it; the others are listed apart', () => {
    const list = [connectionOf('gmail'), connectionOf('gmail', { accountId: 'second', label: 'me@example.com' }), connectionOf('linear')]
    // WHY: the rows, the status, and Connect all read the first account; an added one must not replace it.
    expect([...connectionMap(list).keys()].sort()).toEqual(['gmail', 'linear'])
    // A host from before §13.3 sends no account: its one connection is the first.
    expect(connectionMap(list).get('gmail')).toBe(list[0])
    expect(extraAccountMap(list).get('gmail')?.map((account) => account.label)).toEqual(['me@example.com'])
  })

  test('an account changes or leaves alone', () => {
    const start = extraAccountMap([connectionOf('gmail', { accountId: 'a', label: 'one' }), connectionOf('gmail', { accountId: 'b', label: 'two' })])
    const without = withExtraAccount(start, 'gmail', 'a', null)
    expect(without.get('gmail')?.map((account) => account.accountId)).toEqual(['b'])
    expect(start.get('gmail')).toHaveLength(2)
  })
})

describe('adding another account (§13.3)', () => {
  const waiting: AddingAccount = { flowId: 'flow-1', url: 'https://accounts.google.com/x', error: '' }
  const adds: ReadonlyMap<string, AddingAccount> = new Map([['gmail', waiting]])

  test('a failed or cancelled sign-in stops the add instead of waiting forever', () => {
    // WHY: an add only ends on a connected account; a refused duplicate or a cancel sends none.
    expect(withAddFinished(adds, { flowId: 'flow-1', integrationId: 'gmail', outcome: 'failed', message: 'me@gmail.com is already connected' }).get('gmail'))
      .toEqual({ flowId: null, url: null, error: 'me@gmail.com is already connected' })
    expect(withAddFinished(adds, { flowId: 'flow-1', integrationId: 'gmail', outcome: 'cancelled' }).has('gmail')).toBe(false)
  })

  test('another sign-in of the same integration leaves the add as it is', () => {
    expect(withAddFinished(adds, { flowId: 'flow-first', integrationId: 'gmail', outcome: 'failed' })).toBe(adds)
    expect(withAddFinished(adds, { flowId: 'flow-1', integrationId: 'gmail', outcome: 'connected' })).toBe(adds)
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
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...record('wiki', 'Wiki') }).status(loaded())).toEqual({ text: 'Ready', tone: 'muted', action: null })
  })

  test('no connection reads as Not connected and offers Connect on the row', () => {
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).status(loaded())).toEqual({ text: 'Not connected', tone: 'muted', action: 'connect' })
  })

  test('a connection names the account it signed in as', () => {
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).status(loaded(connectionOf('linear', { label: 'ada@example.com' }))).text).toBe('Connected as ada@example.com')
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).status(loaded(connectionOf('linear', { info: { displayName: 'Ada' } }))).text).toBe('Connected as Ada')
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).status(loaded(connectionOf('linear')))).toEqual({ text: 'Connected', tone: 'muted', action: null })
  })

  test('a lapsed or failed connection offers Reconnect on the row', () => {
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).status(loaded(connectionOf('linear', { status: 'needs-sign-in' })))).toEqual({ text: 'Needs sign-in', tone: 'danger', action: 'reconnect' })
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).status(loaded(connectionOf('linear', { status: 'error', error: 'invalid_grant' })))).toEqual({ text: 'Connection error', tone: 'danger', action: 'reconnect' })
  })

  test('a server with no OAuth client asks for one and offers no Connect that would fail', () => {
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...record('x', 'X', { auth: oauthAuth('client-required') }) }).status(loaded())).toEqual({ text: 'Needs an OAuth client', tone: 'danger', action: null })
  })

  test('while the connections are read, the row does not claim Not connected', () => {
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).status({ kind: 'loading' })).toMatchObject({ action: null })
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).status({ kind: 'loading' }).text).not.toBe('Not connected')
  })

  test('only an integration with sign-in has a connection', () => {
    expect(new InstalledIntegration({ id: 'x', url: 'https://x.example/mcp', auth: { kind: 'none' } }).needsConnection).toBe(false)
    expect(new InstalledIntegration({ id: 'x', url: 'https://x.example/mcp', auth: { kind: 'bearer', scheme: 'bearer' } }).needsConnection).toBe(true)
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
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...record('wiki', 'Wiki') }).mayLoadTools(loaded())).toBe(true)
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...record('wiki', 'Wiki') }).mayLoadTools({ kind: 'loading' })).toBe(true)
  })

  test('tools are not requested for an oauth integration with no connection', () => {
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).mayLoadTools(loaded())).toBe(false)
  })

  test('tools are not requested while the connection lapsed, failed, or is still being read', () => {
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).mayLoadTools(loaded(connectionOf('linear', { status: 'needs-sign-in' })))).toBe(false)
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).mayLoadTools(loaded(connectionOf('linear', { status: 'error' })))).toBe(false)
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).mayLoadTools({ kind: 'loading' })).toBe(false)
  })

  test('tools are read once the person is connected', () => {
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...linear }).mayLoadTools(loaded(connectionOf('linear')))).toBe(true)
  })
})

describe('connect flow', () => {
  const waiting = connectStarted({ kind: 'waiting', flowId: 'f1', url: 'https://auth.example/authorize', input: 'redirect-url', expiresAt: '' }, 'Linear')
  const finished = (outcome: 'connected' | 'failed' | 'cancelled', message?: string, flowId = 'f1') =>
    connectFinished(waiting, { flowId, integrationId: 'linear', outcome, message }, 'Linear')

  test('a browser sign-in waits for the address the browser ended on', () => {
    expect(waiting).toEqual({ step: 'waiting', through: 'host', flowId: 'f1', url: 'https://auth.example/authorize', input: 'redirect-url', expiresAt: '', submitted: false, busy: false, error: null })
  })

  test('a key integration asks for the key; an integration with nothing to do is connected at once', () => {
    expect(connectStarted({ kind: 'token', integrationId: 'linear' }, 'Linear')).toEqual({ step: 'token', through: 'host', busy: false, error: null })
    const connection: IntegrationConnection = { integrationId: 'linear', status: 'connected', source: 'host', label: null, info: null, error: null, updatedAt: '' }
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

  test('every OAuth server offers its client setup', () => {
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...oauth('client-required') }).takesOAuthClient).toBe(true)
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...oauth('client-required', { clientId: 'abc' }) }).takesOAuthClient).toBe(true)
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...oauth('dynamic') }).takesOAuthClient).toBe(true)
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...oauth('metadata-document') }).takesOAuthClient).toBe(true)
    expect(new InstalledIntegration({ id: 'x', url: 'https://x.example/mcp', auth: { kind: 'bearer', scheme: 'bearer' } }).takesOAuthClient).toBe(false)
    expect(new InstalledIntegration({ id: 'x', url: 'https://x.example/mcp', auth: { kind: 'none' } }).takesOAuthClient).toBe(false)
  })

  test('Connect waits for the client ID; a secret is not required', () => {
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...oauth('client-required') }).needsOwnerClient).toBe(true)
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...oauth('client-required', { clientId: 'abc' }) }).needsOwnerClient).toBe(false)
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...oauth('client-required', { clientId: 'abc', hasClientSecret: true }) }).needsOwnerClient).toBe(false)
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...oauth('dynamic') }).needsOwnerClient).toBe(false)
    expect(oauthClientText.connectBlocked).toBe('Enter the OAuth client first')
  })

  test('the redirect path is the host callback, which the phone shows on the host address', () => {
    expect(OAUTH_CALLBACK_PATH).toBe('/oauth/integration/callback')
    expect(oauthClientText.redirectNote).toContain('signs in through this host')
  })

  test('the form says whether a secret is saved and never claims to show it', () => {
    expect(oauthClientText.secretSaved).toBe('Secret saved')
    expect(oauthClientText.noSecret).toBe('No secret')
    expect(oauthClientText.clientSecretNote).toContain('stays on the host')
  })
})

// plans/020-agent-profile.md §5.3 on the phone: a signed-in person signs in at
// Solus Cloud, for any server the host shows them. The cloud is the one
// refresher, so the sign-in ends when the account reports the server connected,
// and every host is then asked to pull so its row moves to the cloud path.

describe('a sign-in through Solus Cloud', () => {
  const SERVER = 'https://mcp.linear.app/mcp'
  const mine = record('linear', 'Linear', { ownerKey: 'user-1', url: SERVER, auth: oauthAuth('dynamic') })

  test('whenever the person is signed in, shared server or own, unless only the host holds the OAuth client', () => {
    // WHY: signed in, the connection lives in the account and every host reads it from there.
    expect(connectsThroughCloud(mine, 'user-1')).toBe(true)
    expect(connectsThroughCloud(record('shared', 'Shared', { ownerKey: 'local:test', url: SERVER, auth: oauthAuth('dynamic') }), 'user-1')).toBe(true)
    expect(connectsThroughCloud(mine, null)).toBe(false)
    expect(connectsThroughCloud(record('custom', 'Custom', { url: SERVER, auth: oauthAuth('dynamic', 'my-client') }), 'user-1')).toBe(false)
    expect(connectsThroughCloud(record('admin', 'Admin', { url: SERVER, auth: oauthAuth('client-required') }), 'user-1')).toBe(false)
    // Without the record's address and auth there is nothing to send the cloud.
    expect(connectsThroughCloud({ id: 'linear', name: 'Linear' }, 'user-1')).toBe(false)
  })

  test('the labels: connected through the account, and a cloud the host could not reach offers no Reconnect', () => {
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...mine }).status(loaded(connectionOf('linear', { source: 'cloud', label: 'ada@example.com' })))).toEqual({ text: 'Connected in your Solus account as ada@example.com', tone: 'muted', action: null })
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...mine }).status(loaded(connectionOf('linear', { source: 'cloud', status: 'cloud-unreachable' })))).toEqual({ text: 'Solus Cloud unreachable', tone: 'danger', action: null })
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...mine }).status(loaded(connectionOf('linear', { source: 'cloud', status: 'needs-solus-sign-in' })))).toEqual({ text: 'Sign in to Solus', tone: 'danger', action: null })
    expect(new InstalledIntegration({ url: 'https://x.example/mcp', ...mine }).status(loaded(connectionOf('linear', { source: 'cloud', status: 'needs-sign-in' })))).toMatchObject({ action: 'reconnect' })
    // A host reset ends a host flow, never a cloud one.
    const cloudWaiting = cloudConnectStarted({ kind: 'browser', url: 'https://app.solus.sh/connect' }, SERVER, 'Linear')
    expect(connectReset(cloudWaiting)).toBe(cloudWaiting)
    expect(connectReset(connectStarted({ kind: 'waiting', flowId: 'f', url: 'u', input: 'callback', expiresAt: '' }, 'Linear')).step).toBe('finished')
  })

  /** A fake account session: the connections it holds, and every call made. */
  function fakeAccount(start: AccountVaultConnectResult, held: VaultConnection[] = []) {
    const calls: string[] = []
    const connections = held
    const list = (): AccountVaultResult => ({ kind: 'ok', connections: structuredClone(connections) })
    const requests: CloudConnectRequests = {
      accountVault: async () => { calls.push('list'); return list() },
      accountVaultConnect: async (request) => { calls.push(`start:${request.ref.kind === 'mcp' ? request.ref.serverUrl : request.ref.kind}`); return start },
      accountVaultSaveKey: async (request) => {
        calls.push(`key:${request.key}`)
        if (request.key === 'good') connections.push({ ref: request.ref, material: 'key', status: 'connected', label: null, updatedAt: 1 })
        return list()
      },
      accountVaultDisconnect: async (request) => { calls.push(`disconnect:${request.ref.kind === 'mcp' ? request.ref.serverUrl : request.ref.kind}`); return { kind: 'ok', connections: [] } },
    }
    return { requests, calls, connections }
  }

  function clockAt(start = 0): DocumentSyncClock & { advance(ms: number): Promise<void> } {
    let now = start
    const timers = new Map<number, { at: number; callback: () => void }>()
    let next = 1
    return {
      now: () => now,
      setTimer: (callback, ms) => {
        const id = next++
        timers.set(id, { at: now + ms, callback })
        return () => { timers.delete(id) }
      },
      async advance(ms) {
        now += ms
        for (const [id, timer] of [...timers]) {
          if (timer.at > now) continue
          timers.delete(id)
          timer.callback()
          await Promise.resolve()
          await Promise.resolve()
        }
      },
    }
  }

  function device(account: ReturnType<typeof fakeAccount>, clock = clockAt()) {
    const opened: string[] = []
    let pulls = 0
    const states: Array<ConnectFlowState | null> = []
    const cloud = new CloudConnect({ requests: account.requests, openBrowser: async (url) => { opened.push(url) }, pullEverywhere: () => { pulls += 1 }, clock }, (_key, state) => states.push(state))
    return { cloud, opened, pulls: () => pulls, states, last: () => states.at(-1) }
  }

  test('a browser sign-in opens the page, reads the account until the server is connected, then every host pulls', async () => {
    const account = fakeAccount({ kind: 'ok', start: { kind: 'browser', url: 'https://app.solus.sh/connect?x' } })
    const clock = clockAt()
    const { cloud, opened, pulls, last } = device(account, clock)
    await cloud.start('linear', SERVER, 'Linear', oauthAuth('dynamic'))
    expect(opened).toEqual(['https://app.solus.sh/connect?x'])
    expect(last()).toMatchObject({ step: 'waiting', through: 'cloud', input: 'callback', url: 'https://app.solus.sh/connect?x' })
    await clock.advance(CLOUD_CONNECT_POLL_MS)
    await clock.advance(CLOUD_CONNECT_POLL_MS)
    expect(account.calls.filter((call) => call === 'list')).toHaveLength(2)
    expect(last()).toMatchObject({ step: 'waiting' })
    expect(pulls()).toBe(0)
    account.connections.push({ ref: { kind: 'mcp', serverUrl: SERVER }, material: 'oauth', status: 'connected', label: 'ada', updatedAt: 1 })
    await clock.advance(CLOUD_CONNECT_POLL_MS)
    expect(last()).toEqual({ step: 'finished', ok: true, message: 'Connected to Linear through Solus Cloud.' })
    expect(pulls()).toBe(1)
    expect(cloud.has('linear')).toBe(false)
    // The flow ended: no further reads.
    await clock.advance(CLOUD_CONNECT_POLL_MS * 3)
    expect(account.calls.filter((call) => call === 'list')).toHaveLength(3)
  })

  test('a sign-in nobody finishes ends after ten minutes without a pull; Cancel ends it at once', async () => {
    const account = fakeAccount({ kind: 'ok', start: { kind: 'browser', url: 'https://app.solus.sh/connect' } })
    const clock = clockAt()
    const { cloud, pulls, last, states } = device(account, clock)
    await cloud.start('linear', SERVER, 'Linear', oauthAuth('dynamic'))
    for (let elapsed = 0; elapsed < CLOUD_CONNECT_TIMEOUT_MS; elapsed += CLOUD_CONNECT_POLL_MS) await clock.advance(CLOUD_CONNECT_POLL_MS)
    expect(last()).toEqual({ step: 'finished', ok: false, message: 'The sign-in did not finish in time. Connect again.' })
    expect(pulls()).toBe(0)

    await cloud.start('linear', SERVER, 'Linear', oauthAuth('dynamic'))
    const before = states.length
    cloud.cancel('linear')
    expect(states.slice(before)).toEqual([null])
    await clock.advance(CLOUD_CONNECT_POLL_MS * 2)
    expect(states).toHaveLength(before + 1)
  })

  test('a pasted key goes to the account, and a refused start says why', async () => {
    const account = fakeAccount({ kind: 'ok', start: { kind: 'key' } })
    const { cloud, pulls, last } = device(account)
    await cloud.start('linear', SERVER, 'Linear', oauthAuth('dynamic'))
    expect(last()).toEqual({ step: 'token', through: 'cloud', busy: false, error: null })
    await cloud.submitKey('linear', ' bad ')
    expect(last()).toEqual({ step: 'token', through: 'cloud', busy: false, error: 'The server did not accept the key.' })
    await cloud.submitKey('linear', 'good')
    expect(account.calls).toEqual([`start:${SERVER}`, 'key:bad', 'key:good'])
    expect(last()).toMatchObject({ step: 'finished', ok: true })
    expect(pulls()).toBe(1)

    const refused = device(fakeAccount({ kind: 'refused', message: 'This server is not in your agent profile.' }))
    await refused.cloud.start('linear', SERVER, 'Linear', oauthAuth('dynamic'))
    expect(refused.last()).toEqual({ step: 'finished', ok: false, message: 'This server is not in your agent profile.' })
    expect(refused.pulls()).toBe(0)
  })

  test('a disconnect of an account-held connection leaves the account, then every host pulls', async () => {
    const account = fakeAccount({ kind: 'ok', start: { kind: 'none' } })
    const { cloud, pulls } = device(account)
    await cloud.disconnect(SERVER)
    expect(account.calls).toEqual([`disconnect:${SERVER}`])
    expect(pulls()).toBe(1)
    const offline = device({ ...account, requests: { ...account.requests, accountVaultDisconnect: async () => ({ kind: 'offline' }) } })
    await expect(offline.cloud.disconnect(SERVER)).rejects.toThrow('Solus Cloud did not answer')
    expect(offline.pulls()).toBe(0)
  })
})
