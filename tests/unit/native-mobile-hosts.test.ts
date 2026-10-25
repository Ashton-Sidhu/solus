import { describe, expect, test } from 'bun:test'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { dialableRoutes, type HostRoute } from '@solus/contracts/host-routes'
import { HostRegistry } from '../../apps/mobile/src/features/hosts/host-registry'
import { decodePairInput, decodeScannedCode, pairFailureMessage, previewHost } from '../../apps/mobile/src/features/hosts/lib/pair-input'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

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
    // The paired address is kept beside the directory's tunnel, and is dialed first.
    expect(merged?.routes.map(sourceAndUrl)).toEqual(['directory https://build.tunnel.solus.sh', 'pairing http://10.0.0.9:51234'])
    expect(dialableRoutes(merged?.routes ?? [], '').map((route) => route.kind)).toEqual(['lan', 'tunnel'])
    expect(registry.host('inst-only-cloud')?.paired).toBe(false)

    const removed: string[] = []
    registry.onHostRemoved((hostId) => removed.push(hostId))
    registry.forgetAccount('user-1')
    expect(registry.hosts().map((host) => host.id)).toEqual(['inst-cloud'])
    expect(registry.host('inst-cloud')?.uplink).toBeUndefined()
    // Only the directory's routes leave with the account.
    expect(registry.host('inst-cloud')?.routes.map(sourceAndUrl)).toEqual(['pairing http://10.0.0.9:51234'])
    expect(removed).toEqual(['inst-only-cloud'])
  })

  test('every saved host a scan finds is dialed on the local network, and keeps that address through directory reads', async () => {
    // WHY: docs/adr/0001-standard-authentication.md §2.2 rule 9 — a registered host
    // that is not linked has no route in the directory. docs/plans/host-routes.md D1:
    // a scan gives every saved host it finds a discovery route, paired hosts too,
    // and a directory read replaces only the directory's own routes.
    const { registry } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-paired', label: 'Paired', url: 'http://10.0.0.9:51234' }, 'tp')
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost({ routes: [] })])
    expect(registry.host('inst-cloud')?.routes).toEqual([])
    const lan = (installationId: string, host: string) => ({ host, port: 7777, name: installationId, installationId, source: 'lan' as const })
    registry.applyNearby([lan('inst-cloud', '192.168.1.20'), lan('inst-paired', '192.168.1.21')])
    expect(registry.host('inst-cloud')?.routes.map(sourceAndUrl)).toEqual(['discovery http://192.168.1.20:7777'])
    // A paired host keeps the address it paired at, beside the one the scan found.
    expect(registry.host('inst-paired')?.routes.map(sourceAndUrl)).toEqual(['discovery http://192.168.1.21:7777', 'pairing http://10.0.0.9:51234'])
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost({ routes: [] })])
    expect(registry.host('inst-cloud')?.routes.map(sourceAndUrl)).toEqual(['discovery http://192.168.1.20:7777'])
  })
})

describe('native host connections', () => {
  test('one transport and supervisor per host, however often it is asked for', async () => {
    const { registry, connections, transports } = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }) })
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1', identityKey: identityKeyFor('inst-a') }, 'ta')
    const first = connections.connection('inst-a')
    const second = connections.connection('inst-a')
    expect(first).toBe(second)
    expect(transports).toHaveLength(1)
    // The dial goes out once the host has proved itself on its http route.
    await flushPromises()
    expect(transports[0]?.dials).toBe(1)
    expect(transports[0]?.options.sessionToken).toBe('ta')
  })

  test('a host that answers with another installation id is blocked, not used', async () => {
    // An https route needs no proof before the dial, so the check after it is what blocks the host.
    const { registry, connections, transports } = createHostWorld({ fetch: healthFetch({ 'https://a:1': 'someone-else' }) })
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'https://a:1' }, 'ta')
    const connection = connections.connection('inst-a')
    await transports[0]?.accept()
    expect(connection?.state.readiness).toBe('refused')
    expect(connection?.state.refusedReason).toBe('identity-mismatch')
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
    expect(connection?.state.refusedReason).toBeNull()
    expect(connection?.state.readiness).toBe('ready')
  })

  test('a matching host is accepted and its reported name fills an unnamed label', async () => {
    const { registry, connections, transports } = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }) })
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'a:1', url: 'http://a:1', identityKey: identityKeyFor('inst-a') }, 'ta')
    const connection = connections.connection('inst-a')
    await flushPromises()
    let accepted = 0
    connection?.onAccepted(() => { accepted += 1 })
    await transports[0]?.accept()
    expect(connection?.state.readiness).toBe('ready')
    expect(accepted).toBe(1)
    expect(registry.host('inst-a')?.label).toBe('Studio Mac')
  })

  test('an expired credential blocks the host; retry builds a fresh transport', async () => {
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    connections.connection('inst-a')
    transports[0]?.fail('auth-blocked')
    expect(connections.readiness('inst-a')).toMatchObject({ readiness: 'refused', refusedReason: 'auth' })
    connections.retry('inst-a')
    expect(transports[0]?.destroyed).toBe(true)
    expect(transports).toHaveLength(2)
  })

  test('a cloud host passes a refused token back to the account, and every dial goes through route choice', async () => {
    // WHY (simplify-auth-and-sync §4.4): one route policy. A failed dial is not
    // re-aimed round-robin; the next dial asks every route again, in parallel.
    const { registry, connections, transports, timers, grantOptions } = createHostWorld()
    await registry.load()
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost({
      routes: [{ kind: 'lan', url: 'http://10.0.0.20:51234' }, { kind: 'tunnel', url: 'https://build.tunnel.solus.sh' }],
    })])
    connections.connection('inst-cloud')
    const transport = transports[0]
    expect(transport?.options.sessionToken).toBe('')
    expect(await transport?.options.grants?.acquire()).toBe('grant-for-inst-cloud')
    expect(await transport?.options.grants?.acquire({ refused: 'grant-old' })).toBe('grant-for-inst-cloud')
    expect(grantOptions).toEqual([undefined, { refused: 'grant-old' }])
    expect(transport?.serverUrl).toBe('http://10.0.0.20:51234')
    await flushRouteChecks()
    expect(transport?.dials).toBe(1)
    transport?.fail('dial-failed')
    expect(transport?.serverUrl).toBe('http://10.0.0.20:51234')
    timers.runAll()
    await flushRouteChecks()
    expect(transport?.dials).toBe(2)
  })

  test('a phone away from the host network dials the tunnel first, and returns to the network on wake', async () => {
    // WHY: a dead local address used to cost a ticket timeout on every dial, and a
    // phone that fell back to the tunnel stayed there until that socket dropped.
    const answering: Record<string, string> = { 'https://build.tunnel.solus.sh': 'inst-cloud' }
    // Over its first connection through the tunnel, the host gives its identity key, so its LAN route can prove it later.
    const advertised = { routes: [], identityKey: identityKeyFor('inst-cloud') }
    const { registry, connections, transports } = createHostWorld({ fetch: healthFetch(answering), api: () => new FakeApi().on('connectionsGetServerInfo', () => advertised) })
    await registry.load()
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost({
      routes: [{ kind: 'lan', url: 'http://10.0.0.20:51234' }, { kind: 'tunnel', url: 'https://build.tunnel.solus.sh' }],
    })])
    connections.connection('inst-cloud')
    const transport = transports[0]
    await flushRouteChecks()
    expect(transport?.serverUrl).toBe('https://build.tunnel.solus.sh')
    expect(transport?.dials).toBe(1)
    await transport?.accept()
    expect(connections.state('inst-cloud')?.readiness).toBe('ready')
    await flushRouteChecks()
    expect(registry.host('inst-cloud')?.identityKey).toBe(advertised.identityKey)

    answering['http://10.0.0.20:51234'] = 'inst-cloud'
    connections.wake('activation')
    await flushRouteChecks()
    expect(transport?.serverUrl).toBe('http://10.0.0.20:51234')
    expect(transport?.dials).toBe(2)
  })

  test('a cloud host dial names its organization at the ticket; a paired host dial names none', async () => {
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost({ organizationIds: ['org-1'] })])
    await registry.savePaired({ id: 'inst-a', label: 'Studio Mac', url: 'http://10.0.0.8:51234' }, 'token-a')
    connections.connection('inst-cloud')
    connections.connection('inst-a')
    const [cloud, paired] = transports
    // An access token lists every organization that reaches the host; the dial picks one (ADR 0001 §6.4).
    expect(cloud?.options.dialOrganizationId?.()).toBe('org-1')
    expect(paired?.options.grants).toBeUndefined()
    expect(paired?.options.dialOrganizationId).toBeUndefined()
  })

  test('a managed host whose compute is not ready is not dialed', async () => {
    // WHY: a stopped host is not "offline": the way out is Start, not Retry.
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost({ kind: 'managed', category: 'managed', managedState: 'stopped' })])
    expect(connections.connection('inst-cloud')).toBeNull()
    expect(connections.readiness('inst-cloud')).toMatchObject({ readiness: 'unreachable', unreachableReason: 'not-running' })
    expect(transports).toHaveLength(0)
  })

  test('a managed host Solus Cloud is starting is checking, so screens wait for it', async () => {
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost({ kind: 'managed', category: 'managed', managedState: 'starting' })])
    expect(connections.connection('inst-cloud')).toBeNull()
    expect(connections.readiness('inst-cloud').readiness).toBe('checking')
    expect(transports).toHaveLength(0)
  })

  test('a host with no route this phone can dial has no address, and is not dialed', async () => {
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    registry.applyDirectory('user-1', 'https://app.solus.sh', [directoryHost({ routes: [] })])
    expect(connections.connection('inst-cloud')).toBeNull()
    expect(connections.readiness('inst-cloud')).toMatchObject({ readiness: 'unreachable', unreachableReason: 'no-address' })
    expect(transports).toHaveLength(0)
  })

  test('a host down past the grace is unreachable because it did not answer', async () => {
    // WHY: time is the only rule (docs/plans/host-readiness.md). Inside the
    // grace the host is still checking, so screens wait; after it they fail.
    const { registry, connections, transports, timers } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    connections.connection('inst-a')
    transports[0]?.fail('dial-failed')
    expect(connections.readiness('inst-a').readiness).toBe('checking')
    timers.runAll()
    expect(connections.readiness('inst-a')).toMatchObject({ readiness: 'unreachable', unreachableReason: 'no-answer', refusedReason: null })
  })

  test('forgetting a host disposes its connection', async () => {
    const { registry, connections, transports } = createHostWorld()
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
    connections.connection('inst-a')
    await registry.forget('inst-a')
    expect(transports[0]?.destroyed).toBe(true)
    expect(connections.state('inst-a')).toBeNull()
    // A screen still open on the forgotten host says it was removed, not that it connects.
    expect(connections.readiness('inst-a').readiness).toBe('gone')
  })

  test('a long suspension resumes every host now; a short one only pulls a due dial forward', async () => {
    const { registry, connections, transports, timers } = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }) })
    await registry.load()
    await registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1', identityKey: identityKeyFor('inst-a') }, 'ta')
    connections.connection('inst-a')
    await flushPromises()
    transports[0]?.fail('dial-failed')
    // The grace and the next dial.
    expect(timers.pending.size).toBe(2)
    connections.suspend(0)
    connections.resume(60_000)
    // The host proves itself on its http route again before the dial goes out.
    await flushPromises()
    expect(transports[0]?.dials).toBe(2)
    // The due dial ran now; only the grace, started again, waits.
    expect(timers.pending.size).toBe(1)
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
    expect(result).toEqual({ kind: 'found', preview: { url: 'http://h:1', host: 'h:1', name: 'Studio Mac', installationId: 'inst-h', os: 'macos', trusted: false } })
    expect((await previewHost(healthFetch({}), 'http://gone:1')).kind).toBe('unreachable')
  })

  // A host that trusts its local network lets this phone join without a code;
  // the preview is how the pairing screen knows not to ask for one.
  test('a host that does not require auth from this device is trusted', async () => {
    const trustingFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true, installationId: 'inst-h', name: 'Studio Mac', requireAuth: false }))
    const result = await previewHost(trustingFetch, 'http://h:1')
    expect(result.kind === 'found' && result.preview.trusted).toBe(true)
  })

  test('an expired code says so', () => {
    expect(pairFailureMessage(new Error('Invalid or expired pair token'))).toContain('expired')
  })
})

function sourceAndUrl(route: HostRoute): string {
  return `${route.source} ${route.url}`
}

/** Lets the parallel route checks before a dial settle. */
function flushRouteChecks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
