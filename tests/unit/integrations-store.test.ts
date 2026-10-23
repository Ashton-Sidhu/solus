import { describe, expect, mock, test } from 'bun:test'
import type { Integration, IntegrationConnection, IntegrationUpdateRequest, IntegrationConnectStartRequest, IntegrationConnectStartResult, IntegrationConnectSubmitRequest, IntegrationToolSummary } from '@solus/contracts/integration-types'
import type { VaultConnection, VaultConnectResult } from '@solus/contracts/vault'
import type { AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { integrationsStore: store } = await import('@solus/workspace-ui/components/settings/integrations.store.svelte')
type CloudSignInPort = Parameters<typeof store.useCloudSignIn>[0] & object
const { connectionStatusText, IntegrationLabels } = await import('@solus/workspace-ui/components/settings/lib/integration-labels')

const integration = (id: string, name = id): Integration => ({
  id, organizationId: 'local', ownerKey: 'local:test', kind: 'mcp', slug: id, name, url: `https://${id}.example/mcp`,
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
    connections.emitPhase('reconnect', 'reconnecting')
    answer([integration('stale')])
    await flush()
    expect(store.states.get('reconnect')?.isDisconnected).toBe(true)
    expect(store.states.get('reconnect')?.integrations).toBeNull()
    connections.emitPhase('reconnect', 'connected')
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
  integrationId, status: 'connected', source: 'host', label, info: null, error: null, updatedAt: '2026-10-08T00:00:00Z',
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
      connections.emitPhase('drop', 'reconnecting')
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

  test('saving a custom client cancels the pending sign-in before replacing its credentials', async () => {
    const pages = recordOpenedPages()
    const calls: string[] = []
    connections.registerHost('oauth-replace', {
      integrationList: async () => [oauthIntegration('linear')],
      integrationConnectionList: async () => [],
      integrationConnectStart: async () => waiting('old-client-flow'),
      integrationConnectCancel: async ({ flowId }: { flowId: string }) => { calls.push(flowId); return { cancelled: true } },
      integrationUpdate: async () => { calls.push('save'); return { ...oauthIntegration('linear'), auth: { kind: 'oauth', discover: 'https://linear.example/.well-known/oauth-protected-resource', registration: 'dynamic', clientId: 'custom' } } },
    })
    const stop = store.watch('oauth-replace')
    try {
      await flush()
      await store.connect('oauth-replace', 'linear')
      await store.setOAuthClient('oauth-replace', 'linear', { clientId: 'custom' })
      expect(calls).toEqual(['old-client-flow', 'save'])
      expect(store.connectFlow('oauth-replace', 'linear')).toBeNull()
    } finally {
      stop()
      pages.restore()
    }
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

// Signed in, a person's sign-in to any server the host shows them runs at Solus
// Cloud (plans/020-agent-profile.md §5.3): the cloud is the OAuth client and the
// only refresher, and every host pulls the connection from there.
describe('integrations store: sign-in through Solus Cloud', () => {
  const ownServer = (id: string, ownerKey: string): Integration => ({ ...oauthIntegration(id), ownerKey })
  const cloudConnected = (integrationId: string): IntegrationConnection => ({ ...connected(integrationId, null), source: 'cloud' })

  /** A fake account: what it was asked, what it answers, and the timers the poll set. */
  function cloudPort(options: { userId?: string | null } = {}) {
    const asked = { starts: [] as string[], auths: [] as unknown[], keys: [] as Array<{ serverUrl: string; key: string; scheme?: string }>, disconnects: [] as string[], reads: 0, pulls: [] as string[] }
    const timers: Array<() => void> = []
    const connections: VaultConnection[] = []
    let start: VaultConnectResult | 'refused' = { kind: 'browser', url: 'https://app.solus.test/connect/linear' }
    const requests: Pick<AgentProfileCloudRequests, 'accountVault' | 'accountVaultConnect' | 'accountVaultSaveKey' | 'accountVaultDisconnect'> = {
      accountVault: async () => { asked.reads++; return { kind: 'ok', connections: [...connections] } },
      accountVaultConnect: async ({ ref, auth }) => {
        asked.starts.push(ref.kind === 'mcp' ? ref.serverUrl : ref.kind)
        asked.auths.push(auth)
        return start === 'refused' ? { kind: 'refused', message: 'This server is not in your agent profile.' } : { kind: 'ok', start }
      },
      accountVaultSaveKey: async ({ ref, key, scheme }) => {
        const serverUrl = ref.kind === 'mcp' ? ref.serverUrl : ref.kind
        asked.keys.push({ serverUrl, key, ...(scheme ? { scheme } : {}) })
        if (key === 'bad') return { kind: 'error', code: 'credential_refused', message: 'The server rejected that key.' }
        connections.push({ ref: { kind: 'mcp', serverUrl }, material: 'key', status: 'connected', label: null, updatedAt: 1 })
        return { kind: 'ok', connections: [...connections] }
      },
      accountVaultDisconnect: async ({ ref }) => {
        asked.disconnects.push(ref.kind === 'mcp' ? ref.serverUrl : ref.kind)
        return { kind: 'ok', connections: connections.filter((connection) => connection.ref.kind !== 'mcp' || ref.kind !== 'mcp' || connection.ref.serverUrl !== ref.serverUrl) }
      },
    }
    const port: CloudSignInPort = {
      // SAFETY: the store calls only the four connection methods in this suite; the document calls are the sync store's.
      requests: () => requests as AgentProfileCloudRequests,
      accountUserId: () => options.userId === undefined ? 'user-a' : options.userId,
      pullHosts: async (serverId) => { asked.pulls.push(serverId) },
      setTimer: (callback) => { timers.push(callback); return () => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1) } },
    }
    return { asked, timers, connections, port, setStart: (next: VaultConnectResult | 'refused') => { start = next } }
  }

  /** A host that holds the person's own server; its connection list follows what the cloud holds after a pull. */
  function hostWithOwnServer(serverId: string, ownerKey: string) {
    const sent = { starts: 0, disconnects: 0 }
    const connectionsOnHost = new Map<string, IntegrationConnection>()
    connections.registerHost(serverId, {
      integrationList: async () => [ownServer('linear', ownerKey)],
      integrationConnectionList: async () => [...connectionsOnHost.values()],
      integrationConnectStart: async () => { sent.starts++; return waiting('host-flow') },
      integrationDisconnect: async ({ id }: { id: string }) => { sent.disconnects++; connectionsOnHost.delete(id); return { disconnected: true } },
    })
    return { sent, connectionsOnHost }
  }

  test('a browser sign-in starts at the cloud, opens there, and ends when the account reads the server as connected: then every host pulls', async () => {
    const cloud = cloudPort()
    const host = hostWithOwnServer('cloud-browser', 'user-a')
    const pages = recordOpenedPages()
    store.useCloudSignIn(cloud.port)
    const stop = store.watch('cloud-browser')
    try {
      await flush()
      await store.connect('cloud-browser', 'linear')
      expect(cloud.asked.starts).toEqual(['https://linear.example/mcp'])
      // The host probed the server; the cloud signs in as that says, profile or not.
      expect(cloud.asked.auths).toEqual([oauthIntegration('linear').auth])
      expect(host.sent.starts).toBe(0)
      expect(store.connectFlow('cloud-browser', 'linear')).toMatchObject({ kind: 'waiting', through: 'cloud', url: 'https://app.solus.test/connect/linear' })
      await flush()
      expect(pages.opened).toEqual(['https://app.solus.test/connect/linear'])

      // Not connected yet: the poll reads again later, and nothing pulls.
      expect(cloud.timers).toHaveLength(1)
      cloud.timers.shift()!()
      await flush()
      expect(cloud.asked.reads).toBe(1)
      expect(cloud.asked.pulls).toEqual([])
      expect(store.connectFlow('cloud-browser', 'linear')?.kind).toBe('waiting')

      // The browser finished at the cloud. The host learns on its pull, so the row reads `cloud` after it.
      cloud.connections.push({ ref: { kind: 'mcp', serverUrl: 'https://linear.example/mcp' }, material: 'oauth', status: 'connected', label: 'Ada', updatedAt: 2 })
      host.connectionsOnHost.set('linear', cloudConnected('linear'))
      expect(cloud.timers).toHaveLength(1)
      cloud.timers.shift()!()
      await flush()
      expect(cloud.asked.pulls).toEqual(['cloud-browser'])
      expect(store.connectFlow('cloud-browser', 'linear')).toBeNull()
      expect(store.connection('cloud-browser', 'linear')?.source).toBe('cloud')
      expect(cloud.timers).toHaveLength(0)
    } finally {
      pages.restore()
      store.useCloudSignIn(null)
      stop()
    }
  })

  test('a cancelled cloud sign-in stops the read-back and cancels nothing on the host', async () => {
    const cloud = cloudPort()
    hostWithOwnServer('cloud-cancel', 'user-a')
    const pages = recordOpenedPages()
    store.useCloudSignIn(cloud.port)
    const stop = store.watch('cloud-cancel')
    try {
      await flush()
      await store.connect('cloud-cancel', 'linear')
      expect(cloud.timers).toHaveLength(1)
      await store.cancel('cloud-cancel', 'linear')
      expect(store.connectFlow('cloud-cancel', 'linear')).toBeNull()
      expect(cloud.timers).toHaveLength(0)
    } finally {
      pages.restore()
      store.useCloudSignIn(null)
      stop()
    }
  })

  test('a key goes to the cloud; a rejected one keeps the field with the reason, an accepted one ends the flow and pulls', async () => {
    const cloud = cloudPort()
    cloud.setStart({ kind: 'key' })
    const host = hostWithOwnServer('cloud-key', 'user-a')
    store.useCloudSignIn(cloud.port)
    const stop = store.watch('cloud-key')
    try {
      await flush()
      await store.connect('cloud-key', 'linear')
      expect(store.connectFlow('cloud-key', 'linear')).toEqual({ kind: 'token', through: 'cloud' })
      expect(await store.submit('cloud-key', 'linear', 'bad')).toBe(false)
      expect(store.connectFlow('cloud-key', 'linear')).toEqual({ kind: 'token', through: 'cloud', error: 'The server rejected that key.' })
      host.connectionsOnHost.set('linear', cloudConnected('linear'))
      expect(await store.submit('cloud-key', 'linear', ' sk-secret ')).toBe(true)
      expect(cloud.asked.keys).toEqual([{ serverUrl: 'https://linear.example/mcp', key: 'bad' }, { serverUrl: 'https://linear.example/mcp', key: 'sk-secret' }])
      expect(cloud.asked.pulls).toEqual(['cloud-key'])
      expect(store.connectFlow('cloud-key', 'linear')).toBeNull()
      expect(store.connection('cloud-key', 'linear')?.source).toBe('cloud')
    } finally {
      store.useCloudSignIn(null)
      stop()
    }
  })

  test('a refused start ends the flow with the cloud\'s message', async () => {
    const cloud = cloudPort()
    cloud.setStart('refused')
    hostWithOwnServer('cloud-refused', 'user-a')
    store.useCloudSignIn(cloud.port)
    const stop = store.watch('cloud-refused')
    try {
      await flush()
      await store.connect('cloud-refused', 'linear')
      expect(store.connectFlow('cloud-refused', 'linear')).toEqual({ kind: 'failed', message: 'This server is not in your agent profile.' })
      expect(cloud.timers).toHaveLength(0)
    } finally {
      store.useCloudSignIn(null)
      stop()
    }
  })

  test('a connection held in the account is disconnected there, then every host pulls; a host connection keeps the host path', async () => {
    const cloud = cloudPort()
    const host = hostWithOwnServer('cloud-disconnect', 'user-a')
    host.connectionsOnHost.set('linear', cloudConnected('linear'))
    store.useCloudSignIn(cloud.port)
    const stop = store.watch('cloud-disconnect')
    try {
      await flush()
      expect(store.connection('cloud-disconnect', 'linear')?.source).toBe('cloud')
      expect(await store.disconnect('cloud-disconnect', 'linear')).toBe(true)
      expect(cloud.asked.disconnects).toEqual(['https://linear.example/mcp'])
      expect(cloud.asked.pulls).toEqual(['cloud-disconnect'])
      expect(host.sent.disconnects).toBe(0)
      expect(store.connection('cloud-disconnect', 'linear')).toBeNull()

      host.connectionsOnHost.set('linear', connected('linear'))
      await store.loadConnections('cloud-disconnect')
      expect(await store.disconnect('cloud-disconnect', 'linear')).toBe(true)
      expect(host.sent.disconnects).toBe(1)
      expect(cloud.asked.disconnects).toHaveLength(1)
    } finally {
      store.useCloudSignIn(null)
      stop()
    }
  })

  test('signed out, or a server whose client only the host holds, signs in on the host', async () => {
    // WHY: the cloud signs in only for an account, and it cannot use a client only the host holds.
    const pages = recordOpenedPages()
    const signedOut = cloudPort({ userId: null })
    const host = hostWithOwnServer('cloud-off', 'user-a')
    store.useCloudSignIn(signedOut.port)
    let stop = store.watch('cloud-off')
    try {
      await flush()
      await store.connect('cloud-off', 'linear')
      expect(host.sent.starts).toBe(1)
      expect(signedOut.asked.starts).toEqual([])
      expect(store.connectFlow('cloud-off', 'linear')).toMatchObject({ kind: 'waiting', flowId: 'host-flow' })
    } finally {
      stop()
    }

    const clientRequired = cloudPort()
    const sent = { starts: 0 }
    connections.registerHost('cloud-client', {
      integrationList: async () => [{ ...oauthIntegration('linear'), auth: { kind: 'oauth', discover: 'https://linear.example/.well-known/oauth-protected-resource', registration: 'dynamic', clientId: 'admin-client' } }],
      integrationConnectionList: async () => [],
      integrationConnectStart: async () => { sent.starts++; return waiting('host-flow') },
    })
    store.useCloudSignIn(clientRequired.port)
    stop = store.watch('cloud-client')
    try {
      await flush()
      await store.connect('cloud-client', 'linear')
      expect(sent.starts).toBe(1)
      expect(clientRequired.asked.starts).toEqual([])
    } finally {
      pages.restore()
      store.useCloudSignIn(null)
      stop()
    }
  })

  test('the words: a cloud connection reads the account, and an unreachable cloud offers no sign-in', () => {
    expect(connectionStatusText(cloudConnected('linear'))).toEqual({ text: 'Connected in your Solus account', detail: null, action: 'Disconnect' })
    expect(connectionStatusText({ ...cloudConnected('linear'), label: 'ada@example.com' }).text).toBe('Connected in your Solus account as ada@example.com')
    const unreachable: IntegrationConnection = { ...cloudConnected('linear'), status: 'cloud-unreachable', error: 'Solus Cloud did not answer.' }
    expect(connectionStatusText(unreachable)).toEqual({ text: 'Solus Cloud unreachable', detail: 'Solus Cloud did not answer.', action: null })
    expect(new IntegrationLabels({ auth: oauthIntegration('linear').auth, url: 'https://x.example/mcp' }).statusText(unreachable)).toEqual({ text: 'Solus Cloud unreachable', tone: 'error', canConnect: false })
    expect(new IntegrationLabels({ auth: oauthIntegration('linear').auth, url: 'https://x.example/mcp' }).statusText(cloudConnected('linear'))).toEqual({ text: 'Connected in your Solus account', tone: 'ready', canConnect: false })
    // No Solus sign-in lets the host read the account: the cloud was not asked, so it is not called unreachable, and no server sign-in fixes it.
    const signedOut: IntegrationConnection = { ...cloudConnected('linear'), status: 'needs-solus-sign-in', error: 'Sign in to Solus so this host can use your account connections.' }
    expect(connectionStatusText(signedOut)).toEqual({ text: 'Sign in to Solus', detail: 'Sign in to Solus so this host can use your account connections.', action: null })
    expect(new IntegrationLabels({ auth: oauthIntegration('linear').auth, url: 'https://x.example/mcp' }).statusText(signedOut)).toEqual({ text: 'Sign in to Solus', tone: 'error', canConnect: false })
  })
})
