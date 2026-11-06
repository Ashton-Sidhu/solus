import type { AccountHostListResponse, HostListing } from '@solus/contracts/host-list'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { AccountDocumentCall } from './account-documents'
import { listedRoutes } from '@solus/contracts/host-routes'
import { LOCAL_SERVER_ID, type SavedServer } from './server-registry'

/**
 * The person's host list (plans/031 D7) as plain requests. It is read from one
 * source: the host this client runs beside while the person is signed out, their
 * account while signed in. A client shows what the last read answered, beside the
 * hosts it keeps itself (`server-registry.ts`: its own pairings and their tokens);
 * it writes a host it pairs or forgets to the source. Nothing is copied back into
 * the registry, so there is nothing to reconcile.
 */
export interface HostListSource {
  read(): Promise<HostListing[] | null>
  put(listing: HostListing): Promise<void>
  remove(id: string): Promise<void>
}

/**
 * A host this client connected to itself: paired, added over SSH, or forwarded, so
 * it holds a token. The local host and a managed host are not on the list. The
 * listing never carries the token.
 */
export function listingOf(server: SavedServer): HostListing | null {
  if (server.id === LOCAL_SERVER_ID || server.uplink?.kind === 'managed' || !server.sessionToken) return null
  const listing: HostListing = { id: server.id, label: server.label, installationId: server.installationId, routes: listedRoutes(server.routes), lastConnected: server.lastConnected }
  if (server.hasUserLabel) listing.hasUserLabel = true
  if (server.os) listing.os = server.os
  if (server.identityKey) listing.identityKey = server.identityKey
  return listing
}

/** The hosts a client shows: its own, then each listed host it does not keep, with no token. */
export function withListedHosts(saved: readonly SavedServer[], listed: readonly HostListing[]): SavedServer[] {
  const kept = new Set(saved.map((server) => server.id))
  const others = listed.filter((listing) => !kept.has(listing.id)).map((listing): SavedServer => {
    const server: SavedServer = { id: listing.id, label: listing.label, sessionToken: '', installationId: listing.installationId, lastConnected: listing.lastConnected, routes: listing.routes }
    if (listing.hasUserLabel) server.hasUserLabel = true
    if (listing.os) server.os = listing.os
    if (listing.identityKey) server.identityKey = listing.identityKey
    return server
  })
  return [...saved, ...others]
}

/** The host this client runs beside, while the person is signed out. */
export function hostListHostSource(api: Pick<SolusAPI, 'hostListRead' | 'hostListPut' | 'hostListRemove'>): HostListSource {
  return {
    read: () => api.hostListRead().catch(() => null),
    put: (listing) => api.hostListPut(listing),
    remove: (id) => api.hostListRemove(id),
  }
}

/** A write that keeps meeting a newer revision gives up after this many reads. */
const ACCOUNT_WRITE_ATTEMPTS = 3

/**
 * The person's account document, while they are signed in. A write names only the
 * host it changes, so a revision that moved since the read is read again and the
 * write sent once more: two devices that change different hosts never conflict. A
 * write that does not land throws.
 */
export function hostListAccountSource(documents: AccountDocumentCall): HostListSource {
  let current: AccountHostListResponse | null = null
  const write = async (set: Record<string, HostListing>, reset: string[]): Promise<void> => {
    for (let attempt = 1; attempt <= ACCOUNT_WRITE_ATTEMPTS; attempt += 1) {
      if (!current) {
        const read = await documents({ name: 'hosts', method: 'GET' })
        if (read.kind !== 'ok') throw new Error(`The account host list could not be read: ${read.kind}.`)
        current = read.document
      }
      const result = await documents({ name: 'hosts', method: 'PATCH', body: { generation: current.generation, expectedRevision: current.revision, set, reset } })
      if (result.kind === 'ok') {
        current = result.document
        return
      }
      if (result.kind !== 'conflict') throw new Error(`The account host list was not written: ${result.kind}.`)
      current = result.current
    }
    throw new Error('The account host list kept changing; pair or forget the host again.')
  }
  return {
    read: async () => {
      const result = await documents({ name: 'hosts', method: 'GET' })
      if (result.kind !== 'ok') return null
      current = result.document
      return Object.values(result.document.hosts)
    },
    put: (listing) => write({ [listing.id]: listing }, []),
    remove: (id) => write({}, [id]),
  }
}
