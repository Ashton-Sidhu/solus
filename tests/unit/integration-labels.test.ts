import { describe, expect, test } from 'bun:test'
import { toolAccess, type IntegrationAuth, type IntegrationConnection, type IntegrationProbeResult } from '@solus/contracts/integration-types'
import { catalogCountText, connectionStatusText, readyToolsText, customUrlProblem, firstLine, IntegrationLabels, oauthRedirectUrl, probeRefusal, urlHost } from '../../packages/workspace-ui/src/components/settings/lib/integration-labels'

const labels = (auth: IntegrationAuth) => new IntegrationLabels({ auth, url: 'https://x.example/mcp' })

const tool = { name: 'ask_question', description: 'Ask about a repository', readOnly: true, destructive: false }

const connected: IntegrationConnection = { integrationId: 'linear', status: 'connected', label: 'Ada', info: null, error: null, updatedAt: '2026-10-08T00:00:00Z' }
const oauth: IntegrationAuth = { kind: 'oauth', discover: 'https://x.example/.well-known', registration: 'dynamic' }
const clientRequired: IntegrationAuth = { kind: 'oauth', discover: 'https://x.example/.well-known', registration: 'client-required' }

// Add is one step on the MCP page: only `undetermined` creates nothing
// (mcp-integrations.md §3.2), so it alone stops Add and says why.
describe('one-step Add', () => {
  test('only an undetermined probe refuses, and it says why', () => {
    expect(probeRefusal({ outcome: 'anonymous', auth: { kind: 'none' }, tools: [tool], signals: [] })).toBeNull()
    expect(probeRefusal({ outcome: 'oauth', auth: oauth, signals: [] })).toBeNull()
    expect(probeRefusal({ outcome: 'credentials-required', auth: { kind: 'bearer', scheme: 'bearer' }, signals: [] })).toBeNull()
    expect(probeRefusal({ outcome: 'undetermined', reason: 'not_mcp', signals: [] } satisfies IntegrationProbeResult)).toBe('This address is not an MCP server.')
  })

  test('after Add, a server with sign-in starts it at once; one with no OAuth client asks for the client first', () => {
    // WHY: adding and then configuring in a second place was the old, confusing flow.
    expect(labels({ kind: 'none' }).afterAdd).toBe('ready')
    expect(labels(oauth).afterAdd).toBe('connect')
    expect(labels({ kind: 'bearer', scheme: 'bearer' }).afterAdd).toBe('connect')
    expect(labels(clientRequired).afterAdd).toBe('oauth-client')
    expect(labels({ ...clientRequired, clientId: 'abc' }).afterAdd).toBe('connect')
  })
})

describe('installed server state', () => {
  test('tools are asked for only when the host can list them: an open server, or one the person is connected to', () => {
    // WHY: asking for the tools of a server with no sign-in showed an error instead of the next step.
    expect(labels({ kind: 'none' }).canListTools(null)).toBe(true)
    expect(labels(oauth).canListTools(null)).toBe(false)
    expect(labels(oauth).canListTools({ ...connected, status: 'needs-sign-in' })).toBe(false)
    expect(labels(oauth).canListTools(connected)).toBe(true)
  })

  test('each state reads in a few words, and only a server the person can sign in to offers Connect', () => {
    expect(labels({ kind: 'none' }).statusText(null)).toEqual({ text: 'Ready', tone: 'ready', canConnect: false })
    expect(labels(oauth).statusText(null)).toEqual({ text: 'Not connected', tone: 'attention', canConnect: true })
    expect(labels(oauth).statusText(connected)).toEqual({ text: 'Connected as Ada', tone: 'ready', canConnect: false })
    expect(labels(oauth).statusText({ ...connected, status: 'error', error: 'boom' })).toEqual({ text: 'Connection error', tone: 'error', canConnect: true })
    expect(labels(clientRequired).statusText(null)).toEqual({ text: 'Needs an OAuth client', tone: 'attention', canConnect: false })
  })
})

test('catalog count', () => {
  expect(catalogCountText(1306)).toBe('1,306 servers')
  expect(catalogCountText(1)).toBe('1 server')
  expect(catalogCountText(0)).toBe('0 servers')
})

test('a custom URL must be HTTPS with no credentials or fragment', () => {
  expect(customUrlProblem('https://mcp.deepwiki.com/mcp')).toBeNull()
  expect(customUrlProblem('')).not.toBeNull()
  expect(customUrlProblem('http://mcp.deepwiki.com/mcp')).not.toBeNull()
  expect(customUrlProblem('https://user:pass@mcp.example.com/mcp')).not.toBeNull()
  expect(customUrlProblem('https://mcp.example.com/mcp?mode=tools')).toBeNull()
})

test('row helpers', () => {
  expect(urlHost('https://mcp.deepwiki.com/mcp')).toBe('mcp.deepwiki.com')
  expect(urlHost('not a url')).toBe('not a url')
  expect(firstLine('\n  Ask a question.\nMore detail.')).toBe('Ask a question.')
  expect(firstLine('')).toBe('')
})

// The row shows the caller's own state and the one action that changes it
// (mcp-integrations.md §4.1 rule 5): a broken connection offers Reconnect, never Disconnect.
describe('connection status wording', () => {
  const connection = (patch: Partial<IntegrationConnection>): IntegrationConnection => ({
    integrationId: 'linear', status: 'connected', label: null, info: null, error: null, updatedAt: '2026-10-08T00:00:00Z', ...patch,
  })

  test('no connection offers Connect', () => {
    expect(connectionStatusText(null)).toEqual({ text: 'Not connected', detail: null, action: 'Connect' })
  })

  test('a connection names its account: the label first, then what the server reported', () => {
    expect(connectionStatusText(connection({ label: 'Ada at Acme', info: { displayName: 'Ada' } }))).toEqual({ text: 'Connected as Ada at Acme', detail: null, action: 'Disconnect' })
    expect(connectionStatusText(connection({ info: { displayName: 'Ada' } })).text).toBe('Connected as Ada')
    expect(connectionStatusText(connection({ label: ' ', info: { email: 'ada@acme.example' } })).text).toBe('Connected as ada@acme.example')
    expect(connectionStatusText(connection({})).text).toBe('Connected')
  })

  test('a connection that stopped working says why and offers Reconnect', () => {
    expect(connectionStatusText(connection({ status: 'needs-sign-in', error: 'The server answered 401.' }))).toEqual({ text: 'Needs sign-in', detail: 'The server answered 401.', action: 'Reconnect' })
    expect(connectionStatusText(connection({ status: 'error', error: 'Refresh failed.' }))).toEqual({ text: 'Connection error', detail: 'Refresh failed.', action: 'Reconnect' })
  })
})

// A server with no dynamic registration needs an administrator's OAuth client
// before anyone can sign in (mcp-integrations.md §4.3). The row says what is
// missing, and once set, what was saved, never the secret.
describe('OAuth client wording', () => {
  const discover = 'https://x.example/.well-known/oauth-protected-resource'

  test('every OAuth server offers manual setup without blocking automatic sign-in', () => {
    expect(labels({ kind: 'oauth', discover, registration: 'dynamic' }).clientText).toMatchObject({ state: 'automatic' })
    expect(labels({ kind: 'oauth', discover, registration: 'metadata-document' }).clientText).toMatchObject({ state: 'automatic' })
    expect(labels({ kind: 'none' }).clientText).toBeNull()
    expect(labels({ kind: 'bearer', scheme: 'bearer' }).clientText).toBeNull()
  })

  test('no client says what to do and blocks Connect', () => {
    expect(labels({ kind: 'oauth', discover, registration: 'client-required' }).clientText).toEqual({
      state: 'missing',
      connectHint: 'Enter the OAuth client first',
    })
  })

  test('a set client shows its ID and whether a secret was saved', () => {
    expect(labels({ kind: 'oauth', discover, registration: 'client-required', clientId: 'abc123', hasClientSecret: true }).clientText).toEqual({
      state: 'set', message: 'OAuth client set', clientId: 'abc123', secret: 'Secret saved',
      changeHint: 'Enter the secret again to keep it. An empty field saves no secret.',
    })
    expect(labels({ kind: 'oauth', discover, registration: 'client-required', clientId: 'abc123' }).clientText).toMatchObject({ secret: 'No secret', changeHint: null })
  })

  test('a custom client remains visible for a server with automatic registration', () => {
    expect(labels({ kind: 'oauth', discover, registration: 'dynamic', clientId: 'custom' }).clientText).toMatchObject({ state: 'set', clientId: 'custom' })
  })

  test('the redirect URL is the host callback at the origin this client reaches it on', () => {
    expect(oauthRedirectUrl('https://solus.example:8443')).toBe('https://solus.example:8443/oauth/integration/callback')
  })
})

// The connect dialog (docs/integrations.md): add, then the OAuth client when the
// server needs one, then sign-in, then the tools to keep on.
describe('connect dialog', () => {
  test('a server goes to its tools only when the host can list them', () => {
    // WHY: the tools step reads tools/list, which fails for a server the person has not signed in to.
    expect(labels({ kind: 'none' }).connectStep(null)).toBe('tools')
    expect(labels(oauth).connectStep(null)).toBe('sign-in')
    expect(labels(oauth).connectStep({ ...connected, status: 'needs-sign-in' })).toBe('sign-in')
    expect(labels(oauth).connectStep(connected)).toBe('tools')
    expect(labels(clientRequired).connectStep(null)).toBe('oauth-client')
    expect(labels({ ...clientRequired, clientId: 'abc' }).connectStep(null)).toBe('sign-in')
    expect(labels({ kind: 'bearer', scheme: 'bearer' }).connectStep(null)).toBe('sign-in')
  })

  test('a tool reads as Read only when the server says it is read-only; destructive wins', () => {
    // WHY: a tool with no hint may write, so calling it Read would hide a write from the person.
    expect(toolAccess({ readOnly: true, destructive: false })).toBe('Read')
    expect(toolAccess({ readOnly: false, destructive: false })).toBe('Write')
    expect(toolAccess({ readOnly: true, destructive: true })).toBe('Destructive')
  })

  test('the last step counts the tools that stay on', () => {
    expect(readyToolsText(2)).toBe('2 tools are ready for the next run')
    expect(readyToolsText(1)).toBe('1 tool is ready for the next run')
    expect(readyToolsText(0)).toBe('No tools are on. Agents get none from this server.')
  })
})
