import { describe, expect, test } from 'bun:test'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { HostRegistry } from '../../apps/mobile/src/features/hosts/host-registry'
import { decodePairInput, decodeScannedCode, pairFailureMessage, previewHost } from '../../apps/mobile/src/features/hosts/lib/pair-input'
import { createHostWorld, flushPromises, healthFetch } from './helpers/native-mobile-fakes'

const directoryHost = (overrides: Partial<DirectoryHost> = {}): DirectoryHost => ({
  hostId: 'cloud-host-1',
  installationId: 'inst-cloud',
  label: 'Build box',
  routes: [{ kind: 'tunnel', url: 'https://build.tunnel.solus.sh' }],
  kind: 'personal',
  category: 'personal',
  organizationIds: [],
  ...overrides,
})

describe('native host registry', () => {
  test('a paired host and its credential survive an app restart, kept apart', async () => {
    const { storage, secrets, registry } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'Studio Mac', url: 'http://10.0.0.8:51234' }, 'token-a')

    // The credential is in the keychain only; plain storage holds no token.
    expect(storage.getItem('solus.mobile.hosts.v1')).not.toContain('token-a')
    expect(secrets.values.get('solus.mobile.host.inst-a.token')).toBe('token-a')

    const restarted = new HostRegistry(storage, secrets)
    expect(restarted.hosts()).toEqual([])
    await restarted.load()
    expect(restarted.hosts().map((host) => host.id)).toEqual(['inst-a'])
    expect(restarted.credential('inst-a')).toBe('token-a')
  })

  test('pairing a second host keeps the first', async () => {
    const { registry } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    await registry.savePaired({ id: 'inst-b', label: 'B', url: 'http://b:1' }, 'tb')
    expect(registry.hosts().map((host) => host.id)).toEqual(['inst-a', 'inst-b'])
  })

  test('a paired host whose keychain entry is gone is not restored as paired', async () => {
    const { storage, secrets, registry } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    secrets.values.clear()
    const restarted = new HostRegistry(storage, secrets)
    await restarted.load()
    expect(restarted.hosts()).toEqual([])
  })

  test('forgetting a host removes its credential and tells every owner of its state', async () => {
    const { secrets, registry } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    const removed: string[] = []
    registry.onHostRemoved((hostId) => removed.push(hostId))
    await registry.forget('inst-a')
    expect(registry.hosts()).toEqual([])
    expect(secrets.values.size).toBe(0)
    expect(removed).toEqual(['inst-a'])
  })

  test('cloud sign-out drops directory hosts but keeps a host paired directly', async () => {
    const { registry } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-cloud', label: 'Mine', hasUserLabel: true, url: 'http://10.0.0.9:51234' }, 'tc')
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost(), directoryHost({ hostId: 'h2', installationId: 'inst-only-cloud', label: 'Only cloud' })])

    const merged = registry.host('inst-cloud')
    expect(merged?.paired).toBe(true)
    expect(merged?.label).toBe('Mine')
    // Direct route first, the directory's tunnel after it.
    expect(merged?.routes.map((route) => route.kind)).toEqual(['direct', 'tunnel'])
    expect(registry.host('inst-only-cloud')?.paired).toBe(false)

    const removed: string[] = []
    registry.onHostRemoved((hostId) => removed.push(hostId))
    registry.forgetAccount('user-1')
    expect(registry.hosts().map((host) => host.id)).toEqual(['inst-cloud'])
    expect(registry.host('inst-cloud')?.uplink).toBeUndefined()
    expect(registry.host('inst-cloud')?.routes).toEqual([{ kind: 'direct', url: 'http://10.0.0.9:51234' }])
    expect(removed).toEqual(['inst-only-cloud'])
  })
})

describe('native host connections', () => {
  test('one transport and supervisor per host, however often it is asked for', async () => {
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    const first = connections.connection('inst-a')
    const second = connections.connection('inst-a')
    expect(first).toBe(second)
    expect(transports).toHaveLength(1)
    expect(transports[0]?.dials).toBe(1)
    expect(transports[0]?.options.sessionToken).toBe('ta')
  })

  test('a host that answers with another installation id is blocked, not used', async () => {
    const { registry, connections, transports } = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'someone-else' }) })
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    const connection = connections.connection('inst-a')
    await transports[0]?.accept()
    expect(connection?.state.phase).toBe('blocked')
    expect(connection?.state.blockedReason).toBe('identity-mismatch')
  })

  test('a managed host is accepted although its server reports its own installation id', async () => {
    const url = 'https://bills.solus.sh'
    const { registry, connections, transports } = createHostWorld({ fetch: healthFetch({ [url]: 'a37b55ff' }) })
    await registry.load()
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost({
      installationId: 'managed:bills', kind: 'managed', category: 'managed', managedState: 'ready',
      routes: [{ kind: 'tunnel', url }],
    })])
    const connection = connections.connection('managed:bills')
    await transports[0]?.accept()
    expect(connection?.state.blockedReason).toBeNull()
    expect(connection?.state.phase).not.toBe('blocked')
  })

  test('a matching host is accepted and its reported name fills an unnamed label', async () => {
    const { registry, connections, transports } = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }) })
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'a:1', url: 'http://a:1' }, 'ta')
    const connection = connections.connection('inst-a')
    let accepted = 0
    connection?.onAccepted(() => { accepted += 1 })
    await transports[0]?.accept()
    expect(connection?.state.phase).toBe('connected')
    expect(accepted).toBe(1)
    expect(registry.host('inst-a')?.label).toBe('Studio Mac')
  })

  test('an expired credential blocks the host; retry builds a fresh transport', async () => {
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    connections.connection('inst-a')
    transports[0]?.fail('auth-blocked')
    expect(connections.state('inst-a')?.blockedReason).toBe('auth')
    connections.retry('inst-a')
    expect(transports[0]?.destroyed).toBe(true)
    expect(transports).toHaveLength(2)
  })

  test('a cloud host forwards forced grant renewal and falls back from direct to tunnel', async () => {
    const { registry, connections, transports, timers, grantOptions } = createHostWorld()
    await registry.load()
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost({
      routes: [{ kind: 'direct', url: 'http://10.0.0.20:51234' }, { kind: 'tunnel', url: 'https://build.tunnel.solus.sh' }],
    })])
    connections.connection('inst-cloud')
    const transport = transports[0]
    expect(transport?.options.sessionToken).toBe('')
    expect(await transport?.options.acquireGrant?.()).toBe('grant-for-inst-cloud')
    expect(await transport?.options.acquireGrant?.({ fresh: true })).toBe('grant-for-inst-cloud')
    expect(grantOptions).toEqual([undefined, { fresh: true }])
    expect(transport?.serverUrl).toBe('http://10.0.0.20:51234')
    transport?.fail('dial-failed')
    expect(transport?.serverUrl).toBe('https://build.tunnel.solus.sh')
    timers.runAll()
    expect(transport?.dials).toBe(2)
  })

  test('a managed host whose compute is not ready is not dialed', async () => {
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost({ kind: 'managed', category: 'managed', managedState: 'stopped' })])
    expect(connections.connection('inst-cloud')).toBeNull()
    expect(connections.state('inst-cloud')?.phase).toBe('waiting-for-compute')
    expect(transports).toHaveLength(0)
  })

  test('forgetting a host disposes its connection', async () => {
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    connections.connection('inst-a')
    await registry.forget('inst-a')
    expect(transports[0]?.destroyed).toBe(true)
    expect(connections.state('inst-a')).toBeNull()
  })

  test('a long suspension resumes every host now; a short one only pulls a due dial forward', async () => {
    const { registry, connections, transports, timers } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    connections.connection('inst-a')
    transports[0]?.fail('dial-failed')
    expect(timers.pending.size).toBe(1)
    connections.suspend(0)
    connections.resume(60_000)
    expect(transports[0]?.dials).toBe(2)
    expect(timers.pending.size).toBe(0)
    await flushPromises()
  })
})

describe('pairing input', () => {
  test('a pairing link carries the address and the token', () => {
    expect(decodePairInput('http://10.0.0.8:51234/pair#token=abc')).toEqual({ kind: 'link', url: 'http://10.0.0.8:51234', pairToken: 'abc' })
  })

  test('a bare address assumes the Solus port and takes the typed code', () => {
    expect(decodePairInput('10.0.0.8', ' ABC123 ')).toEqual({ kind: 'address', url: 'http://10.0.0.8:3000', pairToken: 'ABC123' })
  })

  test('a scanned code must be a pairing link', () => {
    expect(decodeScannedCode('http://10.0.0.8:51234').kind).toBe('invalid')
    expect(decodeScannedCode('otpauth://totp/x').kind).toBe('invalid')
    expect(decodeScannedCode('http://h:1/pair#token=t').kind).toBe('link')
  })

  test('the target is shown from its health answer before pairing', async () => {
    const result = await previewHost(healthFetch({ 'http://h:1': 'inst-h' }), 'http://h:1')
    expect(result).toEqual({ kind: 'found', preview: { url: 'http://h:1', host: 'h:1', name: 'Studio Mac', installationId: 'inst-h', os: 'macos' } })
    expect((await previewHost(healthFetch({}), 'http://gone:1')).kind).toBe('unreachable')
  })

  test('an expired code says so', () => {
    expect(pairFailureMessage(new Error('Invalid or expired pair token'))).toContain('expired')
  })
})
