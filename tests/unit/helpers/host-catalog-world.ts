import type { HostListing } from '@solus/contracts/host-list'
import type { DirectoryHost, DirectoryWorkspace, UplinkDirectory } from '@solus/contracts/uplink'
import { HostCatalog } from '@solus/client-core/host-catalog'
import type { HostCredential, HostCredentialStorage } from '@solus/client-core/host-credentials'
import type { HostListSource } from '@solus/client-core/host-list-source'

/** Every write to device storage and to the list, in order, as `<what> <id>`. */
export type Journal = string[]

export function memoryCredentials(journal: Journal, initial: Record<string, HostCredential> = {}): HostCredentialStorage & { stored: Map<string, HostCredential> } {
  const stored = new Map(Object.entries(initial))
  return {
    stored,
    read: async () => new Map(stored),
    write: async (hostId, credential) => {
      journal.push(`credential.write ${hostId}`)
      stored.set(hostId, credential)
    },
    remove: async (hostId) => {
      journal.push(`credential.remove ${hostId}`)
      stored.delete(hostId)
    },
  }
}

/** A list source whose answer the test sets; `failing` makes reads answer null and writes throw. */
export function fakeList(journal: Journal, key: string, listings: HostListing[] = []) {
  const state = { listings: new Map(listings.map((listing) => [listing.id, listing])), failing: false, onChange: null as (() => void) | null }
  const source: HostListSource = {
    key,
    read: async () => state.failing ? null : [...state.listings.values()],
    put: async (listing) => {
      if (state.failing) throw new Error('offline')
      journal.push(`${key}.put ${listing.id}`)
      state.listings.set(listing.id, listing)
    },
    remove: async (id) => {
      if (state.failing) throw new Error('offline')
      journal.push(`${key}.remove ${id}`)
      state.listings.delete(id)
    },
    subscribe: (onChange) => {
      state.onChange = onChange
      return () => { state.onChange = null }
    },
  }
  return { source, state }
}

/** The account directory: `answer` is what a read returns; null with `signedOut` false is a failed read. */
export function fakeDirectory(directoryUrl = 'https://app.solus.test') {
  const state = { answer: null as UplinkDirectory | null, signedOut: false }
  return {
    state,
    reader: {
      listDirectory: async () => state.answer,
      isSignedOut: () => state.signedOut,
    },
    answer(hosts: DirectoryHost[], workspaces: DirectoryWorkspace[] = []): void {
      state.answer = { directoryUrl, hosts, workspaces }
      state.signedOut = false
    },
  }
}

export function catalogOf(options: {
  credentials: HostCredentialStorage
  directory?: ReturnType<typeof fakeDirectory> | null
  now?: number
  clientOrigin?: string
}): HostCatalog {
  return new HostCatalog({
    credentials: options.credentials,
    directory: () => options.directory?.reader ?? null,
    now: () => options.now ?? 10,
    clientOrigin: () => options.clientOrigin ?? '',
  })
}

export const listingFor = (id: string, overrides: Partial<HostListing> = {}): HostListing => ({
  id, label: `Host ${id}`, installationId: id, lastConnected: 1, routes: [{ kind: 'lan', url: `http://${id}.lan:3000`, source: 'pairing', seenAt: 1 }], ...overrides,
})

export const credentialFor = (id: string, overrides: Partial<HostCredential> = {}): HostCredential => ({
  token: `token-${id}`, routes: [{ kind: 'lan', url: `http://${id}.lan:3000`, source: 'pairing', seenAt: 1 }], ...overrides,
})

export const directoryHostFor = (installationId: string, overrides: Partial<DirectoryHost> = {}): DirectoryHost => ({
  hostId: `cloud-${installationId}`, installationId, label: `Cloud ${installationId}`, os: 'linux', kind: 'personal', category: 'personal',
  routes: [{ kind: 'tunnel', url: `https://${installationId}.tunnel.test` }], organizationIds: [], ...overrides,
})
