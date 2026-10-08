import { describe, expect, mock, test } from 'bun:test'
import type { Integration, IntegrationConnection, IntegrationUpdateRequest, IntegrationConnectStartRequest, IntegrationConnectStartResult, IntegrationConnectSubmitRequest, IntegrationToolSummary } from '@solus/contracts/integration-types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { integrationsStore: store } = await import('@solus/workspace-ui/components/settings/integrations.store.svelte')

const integration = (id: string, name = id): Integration => ({
  id, organizationId: 'local', kind: 'mcp', slug: id, name, url: `https://${id}.example/mcp`,
  auth: { kind: 'none' }, createdBy: null, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z',
})
const tool = (name: string): IntegrationToolSummary => ({ name, description: '', readOnly: false, destructive: false })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('integrations store', () => {
  test('another client\'s changes reach the list without a reload', async () => {
    const records = new Map([['wiki', integration('wiki')]])
    connections.registerHost('events', {
      integrationList: async () => [...records.values()],
      integrationGet: async ({ id }: { id: string }) => records.get(id) ?? null,
    })
    const stop = store.watch('events')
    await flush()
    records.set('linear', integration('linear'))
    connections.emit('events', 'integration.changed', { integrationId: 'linear', change: 'created' })
    await flush()
    expect(store.states.get('events')?.integrations?.map((item) => item.id)).toEqual(['wiki', 'linear'])
    records.set('wiki', integration('wiki', 'DeepWiki'))
    connections.emit('events', 'integration.changed', { integrationId: 'wiki', change: 'updated' })
    await flush()
    expect(store.states.get('events')?.integrations?.[0]?.name).toBe('DeepWiki')
    connections.emit('events', 'integration.changed', { integrationId: 'linear', change: 'removed' })
    expect(store.states.get('events')?.integrations?.map((item) => item.id)).toEqual(['wiki'])
    expect(store.names()).toContain('DeepWiki')
    stop()
  })

  test('a tools change reloads only tools that were loaded', async () => {
    let calls = 0
    connections.registerHost('tools', {
      integrationList: async () => [integration('wiki'), integration('other')],
      integrationTools: async () => { calls++; return [tool(`t${calls}`)] },
    })
    const stop = store.watch('tools')
    await flush()
    await store.loadTools('tools', 'wiki')
    connections.emit('tools', 'integration.changed', { integrationId: 'wiki', change: 'tools' })
    connections.emit('tools', 'integration.changed', { integrationId: 'other', change: 'tools' })
    await flush()
    expect(calls).toBe(2)
    expect(store.states.get('tools')?.tools.get('wiki')).toEqual([tool('t2')])
    expect(store.states.get('tools')?.tools.has('other')).toBe(false)
    stop()
  })

  test('an older host without integrations reads as unsupported, not as an error', async () => {
    connections.registerHost('old', { integrationList: async () => { throw new Error('SolusServer: no handler for "integrationList"') } })
    await store.load('old')
    expect(store.states.get('old')?.isUnsupported).toBe(true)
    expect(store.states.get('old')?.error).toBe('')
  })

  test('disconnect drops an in-flight list; reconnect reloads it', async () => {
    let answer!: (value: Integration[]) => void
    connections.registerHost('reconnect', { integrationList: () => new Promise<Integration[]>((resolve) => { answer = resolve }) })
    const stop = store.watch('reconnect')
    connections.emitStatus('reconnect', 'reconnecting')
    answer([integration('stale')])
    await flush()
    expect(store.states.get('reconnect')?.isDisconnected).toBe(true)
    expect(store.states.get('reconnect')?.integrations).toBeNull()
    connections.emitStatus('reconnect', 'connected')
    answer([integration('fresh')])
    await flush()
    expect(store.states.get('reconnect')?.integrations?.map((item) => item.id)).toEqual(['fresh'])
    expect(store.states.get('reconnect')?.isDisconnected).toBe(false)
    stop()
  })

  test('a failed create keeps the list and reports why', async () => {
    connections.registerHost('write', {
      integrationList: async () => [],
      integrationCreate: async () => { throw new Error('Only a host administrator can add integrations.') },
    })
    await store.load('write')
    expect(await store.create('write', { name: 'Wiki', url: 'https://wiki.example/mcp' })).toBeNull()
    expect(store.states.get('write')?.integrations).toEqual([])
    expect(store.states.get('write')?.writeError).toBe('Only a host administrator can add integrations.')
    expect(store.states.get('write')?.saving).toBe(false)
  })
})

const oauthIntegration = (id: string): Integration => ({
  ...integration(id), auth: { kind: 'oauth', discover: `https://${id}.example/.well-known/oauth-protected-resource`, registration: 'dynamic' },
})
const connected = (integrationId: string, label = 'Ada'): IntegrationConnection => ({
  integrationId, status: 'connected', label, info: null, error: null, updatedAt: '2026-10-08T00:00:00Z',
})
const waiting = (flowId: string, input: 'callback' | 'redirect-url' = 'callback'): IntegrationConnectStartResult => ({
  kind: 'waiting', flowId, url: `https://auth.example/authorize?flow=${flowId}`, input, expiresAt: new Date(Date.now() + 600_000).toISOString(),
})

/** A host whose sign-in answers are set per test; it records what the client sent. */
function signInHost(serverId: string, start: () => IntegrationConnectStartResult) {
  const sent = { starts: [] as IntegrationConnectStartRequest[], submits: [] as IntegrationConnectSubmitRequest[], cancels: [] as string[] }
  const connectionsOnHost = new Map<string, IntegrationConnection>()
  let rejectSubmit: string | null = null
  connections.registerHost(serverId, {
    integrationList: async () => [oauthIntegration('linear')],
    integrationConnectionList: async () => [...connectionsOnHost.values()],
    integrationConnectStart: async (request: IntegrationConnectStartRequest) => { sent.starts.push(request); return start() },
    integrationConnectSubmit: async (request: IntegrationConnectSubmitRequest) => {
      if (rejectSubmit) throw new Error(rejectSubmit)
      sent.submits.push(request)
      return { submitted: true }
    },
    integrationConnectCancel: async ({ flowId }: { flowId: string }) => { sent.cancels.push(flowId); return { cancelled: true } },
    integrationDisconnect: async ({ id }: { id: string }) => { connectionsOnHost.delete(id); return { disconnected: true } },
  })
  return { sent, connectionsOnHost, rejectSubmitWith: (message: string | null) => { rejectSubmit = message } }
}

/** The sign-in page opens on this device: through the client's own bridge, recorded here. */
function recordOpenedPages(): { opened: string[]; restore: () => void } {
  const opened: string[] = []
  const target = globalThis as { window?: object }
  const previous = target.window
  target.window = { solus: { openExternal: async (url: string) => { opened.push(url); return true } } }
  return { opened, restore: () => { if (previous === undefined) delete target.window; else target.window = previous } }
}

// Per-person sign-in (mcp-integrations.md §4.3). The flow lives in the store so
// the Settings row and the conversation card show one state.
describe('integrations store: sign-in', () => {
  test('connect waits on the browser with the origin this client reaches the host on, then clears when the sign-in ends well', async () => {
    const host = signInHost('signin', () => waiting('flow-1'))
    const pages = recordOpenedPages()
    const stop = store.watch('signin')
    try {
      await flush()
      expect(store.states.get('signin')?.connectionsStatus).toBe('loaded')
      expect(store.connection('signin', 'linear')).toBeNull()
      await store.connect('signin', 'linear')
      expect(host.sent.starts).toEqual([{ id: 'linear', callbackBaseUrl: 'http://test.invalid' }])
      expect(store.connectFlow('signin', 'linear')).toMatchObject({ kind: 'waiting', flowId: 'flow-1', input: 'callback' })
      await flush()
      expect(pages.opened).toEqual(['https://auth.example/authorize?flow=flow-1'])

      // The browser finished on the host. The connection may land after the
      // event, so the flow reads it before it clears: never "Not connected" in between.
      host.connectionsOnHost.set('linear', connected('linear'))
      connections.emit('signin', 'host.integrationAuthFinished', { flowId: 'flow-1', integrationId: 'linear', outcome: 'connected' })
      await flush()
      expect(store.connectFlow('signin', 'linear')).toBeNull()
      expect(store.connection('signin', 'linear')?.label).toBe('Ada')
    } finally {
      pages.restore()
      stop()
    }
  })

  test('a failed sign-in keeps the host\'s message until the person tries again', async () => {
    signInHost('failed', () => waiting('flow-2'))
    const pages = recordOpenedPages()
    const stop = store.watch('failed')
    try {
      await flush()
      await store.connect('failed', 'linear')
      // Another flow's end is not this one's.
      connections.emit('failed', 'host.integrationAuthFinished', { flowId: 'flow-other', integrationId: 'linear', outcome: 'failed', message: 'Not this one.' })
      expect(store.connectFlow('failed', 'linear')?.kind).toBe('waiting')
      connections.emit('failed', 'host.integrationAuthFinished', { flowId: 'flow-2', integrationId: 'linear', outcome: 'failed', message: 'The server refused the code.' })
      expect(store.connectFlow('failed', 'linear')).toEqual({ kind: 'failed', message: 'The server refused the code.' })
      await flush()
      expect(store.connectFlow('failed', 'linear')).toEqual({ kind: 'failed', message: 'The server refused the code.' })
      await store.connect('failed', 'linear')
      expect(store.connectFlow('failed', 'linear')?.kind).toBe('waiting')
    } finally {
      pages.restore()
      stop()
    }
  })

  test('a pasted address goes to the waiting flow; a rejected one keeps the field with the reason', async () => {
    const host = signInHost('paste', () => waiting('flow-3', 'redirect-url'))
    const pages = recordOpenedPages()
    const stop = store.watch('paste')
    try {
      await flush()
      await store.connect('paste', 'linear')
      host.rejectSubmitWith('That address has no code in it.')
      expect(await store.submit('paste', 'linear', 'https://example.com/landed')).toBe(false)
      expect(store.connectFlow('paste', 'linear')).toMatchObject({ kind: 'waiting', flowId: 'flow-3', error: 'That address has no code in it.' })
      host.rejectSubmitWith(null)
      expect(await store.submit('paste', 'linear', ' https://example.com/callback?code=abc ')).toBe(true)
      expect(host.sent.submits).toEqual([{ flowId: 'flow-3', value: 'https://example.com/callback?code=abc' }])
      // The host finishes the exchange; until it says so, the flow is submitting.
      expect(store.connectFlow('paste', 'linear')).toEqual({ kind: 'submitting', flowId: 'flow-3' })
      await store.cancel('paste', 'linear')
      expect(host.sent.cancels).toEqual(['flow-3'])
      expect(store.connectFlow('paste', 'linear')).toBeNull()
    } finally {
      pages.restore()
      stop()
    }
  })

  test('an API key is sent by integration id and the flow ends once the connection is read', async () => {
    const host = signInHost('token', () => ({ kind: 'token', integrationId: 'linear' }))
    const stop = store.watch('token')
    await flush()
    await store.connect('token', 'linear')
    expect(store.connectFlow('token', 'linear')).toEqual({ kind: 'token' })
    host.connectionsOnHost.set('linear', connected('linear', 'API key'))
    expect(await store.submit('token', 'linear', 'sk-secret')).toBe(true)
    expect(host.sent.submits).toEqual([{ id: 'linear', value: 'sk-secret' }])
    expect(store.connectFlow('token', 'linear')).toBeNull()
    expect(store.connection('token', 'linear')?.status).toBe('connected')
    stop()
  })

  test('connectionChanged follows the caller\'s connection, and null removes it', async () => {
    const host = signInHost('changes', () => waiting('unused'))
    host.connectionsOnHost.set('linear', connected('linear'))
    const stop = store.watch('changes')
    await flush()
    expect(store.connection('changes', 'linear')?.status).toBe('connected')
    connections.emit('changes', 'integration.connectionChanged', { integrationId: 'linear', connection: { ...connected('linear'), status: 'needs-sign-in', error: 'The server answered 401.' } })
    expect(store.connection('changes', 'linear')?.status).toBe('needs-sign-in')
    connections.emit('changes', 'integration.connectionChanged', { integrationId: 'linear', connection: null })
    expect(store.connection('changes', 'linear')).toBeNull()
    stop()
  })

  test('a host that drops ends the flows that wait on it', async () => {
    signInHost('drop', () => waiting('flow-4'))
    const pages = recordOpenedPages()
    const stop = store.watch('drop')
    try {
      await flush()
      await store.connect('drop', 'linear')
      connections.emitStatus('drop', 'reconnecting')
      expect(store.connectFlow('drop', 'linear')).toBeNull()
    } finally {
      pages.restore()
      stop()
    }
  })

  test('a host older than per-person sign-in reads as unsupported, and its list still loads', async () => {
    connections.registerHost('phase1', {
      integrationList: async () => [oauthIntegration('linear')],
      integrationConnectionList: async () => { throw new Error('SolusServer: no handler for "integrationConnectionList"') },
    })
    await store.load('phase1')
    await flush()
    expect(store.states.get('phase1')?.integrations?.length).toBe(1)
    expect(store.states.get('phase1')?.connectionsStatus).toBe('unsupported')
  })
})

// An administrator's OAuth client for a server with no dynamic registration
// (mcp-integrations.md §4.3). The secret goes to the host once; the client never keeps it.
describe('integrations store: OAuth client', () => {
  const clientRequired = (patch: { clientId?: string; hasClientSecret?: boolean } = {}): Integration => ({
    ...integration('acme'), auth: { kind: 'oauth', discover: 'https://acme.example/.well-known/oauth-protected-resource', registration: 'client-required', ...patch },
  })

  test('save and remove go through integrationUpdate, and the secret never lands in state', async () => {
    const sent: IntegrationUpdateRequest[] = []
    let record = clientRequired()
    connections.registerHost('oauth-client', {
      integrationList: async () => [record],
      integrationUpdate: async (request: IntegrationUpdateRequest) => {
        sent.push(request)
        record = request.oauthClient ? clientRequired({ clientId: request.oauthClient.clientId, hasClientSecret: !!request.oauthClient.clientSecret }) : clientRequired()
        return record
      },
    })
    await store.load('oauth-client')
    expect(store.oauthRedirectUrl('oauth-client')).toBe('http://test.invalid/oauth/integration/callback')

    expect(await store.setOAuthClient('oauth-client', 'acme', { clientId: 'cid', clientSecret: 'top-secret' })).not.toBeNull()
    expect(sent).toEqual([{ id: 'acme', oauthClient: { clientId: 'cid', clientSecret: 'top-secret' } }])
    expect(store.states.get('oauth-client')?.integrations?.[0]?.auth).toMatchObject({ clientId: 'cid', hasClientSecret: true })
    expect(JSON.stringify(store.states.get('oauth-client'))).not.toContain('top-secret')

    await store.setOAuthClient('oauth-client', 'acme', null)
    expect(sent[1]).toEqual({ id: 'acme', oauthClient: null })
    expect(store.states.get('oauth-client')?.integrations?.[0]?.auth).not.toHaveProperty('clientId')
    expect(store.states.get('oauth-client')?.saving).toBe(false)
  })

  test('a refused client keeps the record and reports why', async () => {
    connections.registerHost('oauth-refused', {
      integrationList: async () => [clientRequired()],
      integrationUpdate: async () => { throw new Error('Only a host administrator can change integrations.') },
    })
    await store.load('oauth-refused')
    expect(await store.setOAuthClient('oauth-refused', 'acme', { clientId: 'cid' })).toBeNull()
    expect(store.states.get('oauth-refused')?.writeError).toBe('Only a host administrator can change integrations.')
    expect(store.states.get('oauth-refused')?.integrations?.[0]?.auth).not.toHaveProperty('clientId')
  })
})
