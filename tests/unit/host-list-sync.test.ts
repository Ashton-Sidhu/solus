import { describe, expect, test } from 'bun:test'
import type { AccountHostListPatchRequest, AccountHostListResponse, HostListing } from '@solus/contracts/host-list'
import type { AccountHostListResult } from '@solus/contracts/host-api'
import { hostListAccountSource, listingOf, reconcileHostList } from '@solus/client-core/host-list-sync'
import type { SavedServer } from '@solus/client-core/server-registry'

// plans/031 D7: the host list has one source at a time, and this client's registry
// caches it beside the client's own tokens. A token never leaves the client.

const route = (url: string, source: 'pairing' | 'directory' | 'ssh' = 'pairing') => ({ url, kind: 'lan' as const, source, seenAt: 1 })
const paired = (id: string, extra: Partial<SavedServer> = {}): SavedServer => ({
  id, label: `Host ${id}`, sessionToken: `token-${id}`, installationId: id, lastConnected: 1, routes: [route(`http://${id}:3020`)], ...extra,
})
const listing = (id: string, extra: Partial<HostListing> = {}): HostListing => ({
  id, label: `Host ${id}`, installationId: id, lastConnected: 1, routes: [route(`http://${id}:3020`)], ...extra,
})

describe('a listing', () => {
  test('is a host the person connected to themselves, with no token; a directory-only or managed host is none', () => {
    expect(listingOf(paired('a'))).toEqual(listing('a'))
    expect(JSON.stringify(listingOf(paired('a')))).not.toContain('token-a')
    const directoryOnly = paired('d', { sessionToken: '', routes: [route('https://d.tunnel', 'directory')], uplink: { hostId: 'd', directoryUrl: 'https://app' } })
    expect(listingOf(directoryOnly)).toBeNull()
    expect(listingOf(paired('m', { uplink: { hostId: 'm', directoryUrl: 'https://app', kind: 'managed' } }))).toBeNull()
    expect(listingOf(paired('local'))).toBeNull()
  })
})

describe('a reconcile with the source', () => {
  test('a host only the source has joins without a token; a host only this client has goes to the source', () => {
    const result = reconcileHostList([paired('mine')], [listing('theirs')], new Set())
    expect(result.saved.map((server) => [server.id, server.sessionToken])).toEqual([['mine', 'token-mine'], ['theirs', '']])
    expect(result.toPut.map((host) => host.id)).toEqual(['mine'])
    expect(result.synced.sort()).toEqual(['mine', 'theirs'])
  })

  test('a host this client agreed on before, and the source no longer has, was removed elsewhere and leaves', () => {
    // WHY: the source is the truth; without the synced record a forget on one device
    // would come back from every other device's cache.
    const result = reconcileHostList([paired('gone'), paired('kept')], [listing('kept')], new Set(['gone', 'kept']))
    expect(result.saved.map((server) => server.id)).toEqual(['kept'])
    expect(result.toPut).toEqual([])
  })

  test('a host both have keeps this client\'s token and takes the source\'s name and its routes at new addresses', () => {
    const result = reconcileHostList(
      [paired('a', { routes: [route('http://a:3020')] })],
      [listing('a', { label: 'Studio', hasUserLabel: true, routes: [route('http://a:3020'), route('http://a.tail:3020', 'ssh')] })],
      new Set(['a']),
    )
    expect(result.saved[0]).toMatchObject({ sessionToken: 'token-a', label: 'Studio', hasUserLabel: true })
    expect(result.saved[0]!.routes.map((host) => host.url)).toEqual(['http://a:3020', 'http://a.tail:3020'])
  })
})

describe('the account source', () => {
  test('a write that meets a newer revision reads it and writes again, naming only its host', async () => {
    // WHY: two devices that change different hosts must never conflict.
    const doc = (revision: number, hosts: Record<string, HostListing>): AccountHostListResponse => ({ schemaVersion: 1, generation: 0, revision, hosts, updatedAt: 1 })
    const patches: AccountHostListPatchRequest[] = []
    let stored = doc(1, { other: listing('other') })
    const requests = {
      accountHostListGet: async (): Promise<AccountHostListResult> => ({ kind: 'ok', hosts: stored }),
      accountHostListPatch: async (request: AccountHostListPatchRequest): Promise<AccountHostListResult> => {
        patches.push(request)
        // Another device wrote first: the revision moved to 2.
        if (request.expectedRevision === 1) {
          stored = doc(2, { other: listing('other'), third: listing('third') })
          return { kind: 'conflict', reason: 'host_list_conflict', current: stored }
        }
        stored = doc(3, { ...stored.hosts, ...request.set })
        return { kind: 'ok', hosts: stored }
      },
      accountHostListDelete: async (): Promise<AccountHostListResult> => ({ kind: 'ok', hosts: doc(1, {}) }),
    }
    const source = hostListAccountSource('acct', requests)
    expect((await source.read())!.map((host) => host.id)).toEqual(['other'])
    await source.put(listing('mine'))
    expect(patches.map((patch) => [patch.expectedRevision, Object.keys(patch.set)])).toEqual([[1, ['mine']], [2, ['mine']]])
    expect(Object.keys(stored.hosts).sort()).toEqual(['mine', 'other', 'third'])
  })
})
