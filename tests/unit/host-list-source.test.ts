import { describe, expect, test } from 'bun:test'
import type { AccountHostListResponse, HostListing } from '@solus/contracts/host-list'
import type { AccountDocumentRequest, AccountDocumentResult } from '@solus/contracts/account-documents'
import { hostListAccountSource, listingOf, withListedHosts } from '@solus/client-core/host-list-source'
import type { AccountDocumentCall } from '@solus/client-core/account-documents'
import type { SavedServer } from '@solus/client-core/server-registry'

// plans/031 D7: the host list is plain requests to one source, the device host
// signed out and the account signed in. A client shows the last answer beside the
// hosts it keeps itself; its own tokens never leave it.

const route = (url: string, source: 'pairing' | 'directory' = 'pairing') => ({ url, kind: 'lan' as const, source, seenAt: 1 })
const paired = (id: string, extra: Partial<SavedServer> = {}): SavedServer => ({
  id, label: `Host ${id}`, sessionToken: `token-${id}`, installationId: id, lastConnected: 1, routes: [route(`http://${id}:3020`)], ...extra,
})
const listing = (id: string): HostListing => ({ id, label: `Host ${id}`, installationId: id, lastConnected: 1, routes: [route(`http://${id}:3020`)] })

describe('a listing', () => {
  test('is a host this client paired, never its token; a directory-only, managed, or unpaired host is none', () => {
    expect(listingOf(paired('a'))).toEqual(listing('a'))
    expect(JSON.stringify(listingOf(paired('a')))).not.toContain('token-a')
    expect(listingOf(paired('d', { sessionToken: '', routes: [route('https://d.tunnel', 'directory')], uplink: { hostId: 'd', directoryUrl: 'https://app' } }))).toBeNull()
    expect(listingOf(paired('m', { uplink: { hostId: 'm', directoryUrl: 'https://app', kind: 'managed' } }))).toBeNull()
    expect(listingOf(paired('other', { sessionToken: '' }))).toBeNull()
    expect(listingOf(paired('local'))).toBeNull()
  })
})

describe('what a client shows', () => {
  test('its own hosts as it keeps them, then each listed host it does not keep, with no token', () => {
    const shown = withListedHosts([paired('mine')], [listing('mine'), listing('theirs')])
    expect(shown.map((server) => [server.id, server.sessionToken])).toEqual([['mine', 'token-mine'], ['theirs', '']])
  })
})

describe('the account source', () => {
  const doc = (revision: number, hosts: Record<string, HostListing>): AccountHostListResponse => ({ schemaVersion: 1, generation: 0, revision, hosts, updatedAt: 1 })

  test('a write that meets a newer revision reads it and writes again, naming only its host', async () => {
    // WHY: two devices that change different hosts must never conflict.
    const patches: Array<{ expectedRevision: number | null; keys: string[] }> = []
    let stored = doc(1, { other: listing('other') })
    const documents = (async (request: AccountDocumentRequest<'hosts'>): Promise<AccountDocumentResult<'hosts'>> => {
      if (request.method === 'GET') return { kind: 'ok', document: stored }
      if (request.method !== 'PATCH') return { kind: 'ok', document: doc(1, {}) }
      patches.push({ expectedRevision: request.body.expectedRevision, keys: Object.keys(request.body.set) })
      if (request.body.expectedRevision === 1) {
        stored = doc(2, { other: listing('other'), third: listing('third') })
        return { kind: 'conflict', reason: 'host_list_conflict', current: stored }
      }
      stored = doc(3, { ...stored.hosts, ...request.body.set })
      return { kind: 'ok', document: stored }
    }) as AccountDocumentCall
    const source = hostListAccountSource(documents)
    expect((await source.read())!.map((host) => host.id)).toEqual(['other'])
    await source.put(listing('mine'))
    expect(patches).toEqual([{ expectedRevision: 1, keys: ['mine'] }, { expectedRevision: 2, keys: ['mine'] }])
    expect(Object.keys(stored.hosts).sort()).toEqual(['mine', 'other', 'third'])
  })

  test('a write the account did not take fails, so the person is told', async () => {
    const offline = (async () => ({ kind: 'offline' })) as AccountDocumentCall
    await expect(hostListAccountSource(offline).put(listing('mine'))).rejects.toThrow()
    expect(await hostListAccountSource(offline).read()).toBeNull()
  })
})
