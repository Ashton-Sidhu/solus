import { expect, test } from 'bun:test'
import { linkMachines, machineLinkChoices, type LinkMachine } from '@solus/client-core/host-linking'
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
