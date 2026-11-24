import { describe, expect, test } from 'bun:test'
import { linkedOnlyMachines, linkMachines, machineLinkChoices, machineLinksHidden, machineLinkState, machineLinkStateText, machineLinkTone, machineLinkViews, worseLinkState, type LinkMachine } from '@solus/client-core/host-linking'
import type { HostLinkHealth } from '@solus/contracts/host-pairing'
import type { HostPairing, HostPairRequest } from '@solus/contracts/host-pairing'
import { identityKeyFor } from './helpers/signing-host'

const route = { kind: 'lan' as const, url: 'http://10.0.0.5:3000' }

function machine(id: string, hosts: HostPairing[] = []): LinkMachine {
  return {
    label: id,
    info: { installationId: id, identityKey: identityKeyFor(id), routes: [route], principal: 'local-owner', permissions: ['host.local.reach'], hostKind: 'personal', remoteAccess: 'private' },
    snapshot: { hosts, forgotten: [] },
    isCurrent: () => true,
    api: {
      hostsPair: async () => { throw new Error('Unexpected pairing') },
      hostsPairClient: async () => { throw new Error('Unexpected code request') },
      hostsUnlink: async () => { throw new Error('Unexpected unlink') },
      connectionsGeneratePairToken: async () => ({ token: 'one-use-token', code: '123456', expiresAt: 300 }),
      hostsLinkHealth: async () => [],
    },
  }
}

const listing = { id: 'target', installationId: 'target', label: 'target', identityKey: identityKeyFor('target'), routes: [route], lastConnected: 0 }
const pairing = { listing, pairedAt: 1, url: route.url }

test('one approval links a direct and an indirect machine separately; a refusal preserves the successful link', async () => {
  const source = machine('source')
  const target = machine('direct')
  const known = machine('known', [pairing])
  known.info.remoteAccess = 'off' // the app owns it, but other hosts have no route in
  let minted = 0
  known.api.hostsPairClient = async () => {
    minted++
    return { listing, url: route.url, code: 'via-code' }
  }
  const calls: HostPairRequest[] = []
  source.api.hostsPair = async (request) => {
    calls.push(request)
    if (request.link?.installationId === listing.installationId) throw new Error('Refused')
    return listing
  }
  const choices = machineLinkChoices(source, [source, target, known])
  expect(choices.map(({ id, viaLabel }) => [id, viaLabel])).toEqual([['direct', undefined], ['target', 'known']])
  expect(minted).toBe(0)
  expect(calls).toHaveLength(0)

  const outcomes = new Map()
  await linkMachines(source, choices, (id, result) => outcomes.set(id, result))
  expect(minted).toBe(1)
  expect(outcomes).toEqual(new Map([['direct', 'linked'], ['target', 'failed']]))
  expect(calls.find((request) => request.link?.installationId === 'target')).toMatchObject({
    url: route.url,
    code: `${route.url}/pair#token=via-code`,
    link: { installationId: 'target', identityKey: listing.identityKey },
  })
})

test('links use an authorized source and prefer a direct owner connection to a relay', async () => {
  const source = machine('source')
  const known = machine('known', [pairing])
  const target = machine('target')
  const choice = machineLinkChoices(source, [known, target]).find(({ id }) => id === 'target')
  expect(choice?.viaLabel).toBeUndefined()
  expect(await choice?.mint()).toBe('one-use-token')
  known.info.permissions = ['read.transcript']
  target.info.principal = 'remote-owner'
  expect(machineLinkChoices(source, [target, known])).toEqual([])
  source.info.principal = 'remote-owner'
  expect(machineLinkChoices(source, [machine('another')])).toEqual([])
})

test('the picker skips existing links and stops when the source connection changes during minting', async () => {
  const source = machine('source', [pairing])
  const target = machine('direct')
  let isCurrent = true
  let sent = 0
  source.isCurrent = () => isCurrent
  source.api.hostsPair = async () => { sent++; return listing }
  target.api.connectionsGeneratePairToken = async () => {
    isCurrent = false
    return { token: 'one-use-token', code: '123456', expiresAt: 300 }
  }
  const choices = machineLinkChoices(source, [machine('target'), target])
  expect(choices.map(({ id }) => id)).toEqual(['direct'])
  const outcomes = new Map()
  await linkMachines(source, choices, (id, result) => outcomes.set(id, result))
  expect(sent).toBe(0)
  expect(outcomes.get('direct')).toBe('failed')
})

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

function pairingTo(id: string, at = route.url): HostPairing {
  return { listing: { id, installationId: id, label: id, identityKey: identityKeyFor(id), routes: [{ ...route, url: at }], lastConnected: 0 }, pairedAt: 1, url: at }
}

function health(installationId: string, change: Partial<HostLinkHealth> = {}): HostLinkHealth {
  return { installationId, status: 'reachable', lastReachedAt: NOW - DAY, lastError: null, expiresAt: NOW + 20 * DAY, ...change }
}

describe('the state of a machine link', () => {
  // A person sees a link that will not work before an agent tries it.
  test('a link that answers is reachable, and says when it expires within a week', () => {
    expect(machineLinkStateText(machineLinkState(health('a'), NOW))).toBe('Reachable')
    const soon = machineLinkState(health('a', { expiresAt: NOW + 3 * DAY }), NOW)
    expect(machineLinkStateText(soon)).toBe('Expires in 3 days')
    expect(machineLinkTone(soon)).toBe('warn')
  })

  test('a link whose last use failed is failing even when the machine answers, with the reason', () => {
    const state = machineLinkState(health('a', { lastError: 'It refused the credential of this link.' }), NOW)
    expect(state).toEqual({ kind: 'failing', detail: 'It refused the credential of this link.' })
    expect(machineLinkTone(state)).toBe('bad')
  })

  test('an expired or silent link wants attention, and an unread one is only checking', () => {
    expect(machineLinkTone(machineLinkState(health('a', { status: 'expired', expiresAt: null }), NOW))).toBe('bad')
    expect(machineLinkTone(machineLinkState(health('a', { status: 'unreachable' }), NOW))).toBe('warn')
    expect(machineLinkState(undefined, NOW)).toEqual({ kind: 'checking' })
    // An older host cannot say: the link never claims to be checking for ever.
    expect(machineLinkStateText(machineLinkState('unavailable', NOW))).toBe('Health unknown')
  })

  test('a two-way link shows the direction in more trouble', () => {
    const good = machineLinkState(health('a'), NOW)
    const bad = machineLinkState(health('b', { status: 'expired', expiresAt: null }), NOW)
    expect(worseLinkState(good, bad)).toBe(bad)
    expect(worseLinkState(bad, good)).toBe(bad)
  })
})

describe('the view of every link', () => {
  test('two machines that link to each other make one two-way link, with the health of each direction', () => {
    const a = machine('a', [pairingTo('b')])
    const b = machine('b', [pairingTo('a')])
    const views = machineLinkViews([a, b], new Map([['a', [health('b')]], ['b', [health('a', { status: 'unreachable' })]]]), NOW)
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ sourceId: 'a', targetId: 'b', state: { kind: 'reachable' }, back: { state: { kind: 'unreachable' } }, canLinkBack: false })
  })

  test('a one-way link offers Link back only when the target is connected here and can link to the source', () => {
    const a = machine('a', [pairingTo('b')])
    const b = machine('b')
    expect(machineLinkViews([a, b], new Map(), NOW)[0]?.canLinkBack).toBe(true)
    // The target is not connected here: nothing can ask it to link back.
    expect(machineLinkViews([a], new Map(), NOW)[0]?.canLinkBack).toBe(false)
    // The source has no address another machine can use.
    a.info.remoteAccess = 'off'
    expect(machineLinkViews([a, b], new Map(), NOW)[0]?.canLinkBack).toBe(false)
  })

  test('a link target that this device has no entry for is known only through its links', () => {
    const a = machine('a', [pairingTo('nas', 'http://10.0.0.9:3000')])
    const b = machine('b', [pairingTo('nas'), pairingTo('a')])
    const views = machineLinkViews([a, b], new Map(), NOW)
    expect(linkedOnlyMachines(views, new Set(['a', 'b']))).toEqual([{ installationId: 'nas', label: 'nas', url: 'http://10.0.0.9:3000', viaLabels: ['a', 'b'] }])
    expect(linkedOnlyMachines(views, new Set(['a', 'b', 'nas']))).toEqual([])
  })
})

describe('why the links of a machine are not shown', () => {
  const owner = { principal: 'local-owner' as const, permissions: ['host.local.reach' as const] }
  test('each reason, in the order a person can act on it', () => {
    expect(machineLinksHidden({ isConnected: false, info: owner, hasSnapshot: true, hasReadFailed: false })).toBe('disconnected')
    expect(machineLinksHidden({ isConnected: true, info: null, hasSnapshot: false, hasReadFailed: false })).toBe('reading')
    expect(machineLinksHidden({ isConnected: true, info: { principal: 'guest', permissions: [] }, hasSnapshot: false, hasReadFailed: false })).toBe('not-owner')
    expect(machineLinksHidden({ isConnected: true, info: owner, hasSnapshot: false, hasReadFailed: true })).toBe('failed')
    expect(machineLinksHidden({ isConnected: true, info: owner, hasSnapshot: true, hasReadFailed: true })).toBeNull()
  })
})
