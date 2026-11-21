import { hostListingSchema, type AccountHostListResponse, type HostListing } from '@solus/contracts/host-list'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { AccountDocumentCall } from './account-documents'
import type { HostEventSubscriber } from './host-event-subscriber'
import { forwardCompatibleArray } from './forward-compat'

/**
 * The person's host list (plans/031 D7, plans/033 §2) as plain requests. It is
 * read from one source: their account while signed in; while signed out, the host
 * this client runs beside, or device storage on a client with no such host (a
 * phone, the account origin). The host catalog joins the answer with this
 * device's credentials (`host-catalog.ts`); nothing is copied back.
 */
export interface HostListSource {
  /** Names the source: `account`, `host:<id>`, or `device`. The same key is the same list. */
  readonly key: string
  /** Null when the read failed. */
  read(): Promise<HostListing[] | null>
  put(listing: HostListing): Promise<void>
  remove(id: string): Promise<void>
  /** Tells when another client changed the list; absent where nothing tells. */
  subscribe?(onChange: () => void): () => void
}

/** The host this client runs beside, while the person is signed out. */
export function hostListHostSource(
  hostId: string,
  api: Pick<SolusAPI, 'hostListRead' | 'hostListPut' | 'hostListRemove'>,
  events?: Pick<HostEventSubscriber, 'subscribe'>,
): HostListSource {
  return {
    key: `host:${hostId}`,
    read: () => api.hostListRead().catch(() => null),
    put: (listing) => api.hostListPut(listing),
    remove: (id) => api.hostListRemove(id),
    subscribe: events ? (onChange) => events.subscribe('host.listChanged', onChange) : undefined,
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
    key: 'account',
    read: async () => {
      const result = await documents({ name: 'hosts', method: 'GET' }).catch(() => null)
      if (result?.kind !== 'ok') return null
      current = result.document
      return Object.values(result.document.hosts)
    },
    put: (listing) => write({ [listing.id]: listing }, []),
    remove: (id) => write({}, [id]),
  }
}

/** The part of `Storage` the device source uses: `localStorage`, or mobile's key-value store. */
export interface ListingStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const DEVICE_HOST_LIST_KEY = 'solus.hostList'

const deviceListSchema = forwardCompatibleArray(hostListingSchema)

/**
 * The list on the device itself, for a client with no device host while the person
 * is signed out (plans/033 §2, the exception from 031 D7). It is the third source,
 * not a second list beside the database: signed in, the account's list is read.
 */
export function deviceHostListSource(storage: ListingStorage): HostListSource {
  const readAll = (): HostListing[] => {
    const raw = storage.getItem(DEVICE_HOST_LIST_KEY)
    if (!raw) return []
    try {
      const decoded = deviceListSchema.safeParse(JSON.parse(raw))
      if (decoded.success) return decoded.data
    } catch {}
    storage.removeItem(DEVICE_HOST_LIST_KEY)
    return []
  }
  const writeAll = (listings: readonly HostListing[]): void => {
    if (listings.length === 0) storage.removeItem(DEVICE_HOST_LIST_KEY)
    else storage.setItem(DEVICE_HOST_LIST_KEY, JSON.stringify(listings))
  }
  return {
    key: 'device',
    read: async () => {
      try {
        return readAll()
      } catch {
        return null
      }
    },
    put: async (listing) => writeAll([...readAll().filter((kept) => kept.id !== listing.id), listing]),
    remove: async (id) => writeAll(readAll().filter((kept) => kept.id !== id)),
  }
}

export interface HostListSourceChoice {
  /** The account's documents while the person is signed in; null while signed out. */
  accountDocuments: AccountDocumentCall | null
  /** The host this client runs beside: the desktop's own, or the host that served the page. */
  deviceHost: {
    id: string
    api: Pick<SolusAPI, 'hostListRead' | 'hostListPut' | 'hostListRemove'>
    events?: Pick<HostEventSubscriber, 'subscribe'>
  } | null
  /** Device storage, for a client with no device host. */
  deviceStorage: ListingStorage | null
}

/**
 * Where the person's list is read now (plans/031 D7): the account while signed in,
 * else the device host, else device storage. Null when there is none of them.
 */
export function hostListSourceFor(choice: HostListSourceChoice): HostListSource | null {
  if (choice.accountDocuments) return hostListAccountSource(choice.accountDocuments)
  if (choice.deviceHost) return hostListHostSource(choice.deviceHost.id, choice.deviceHost.api, choice.deviceHost.events)
  if (choice.deviceStorage) return deviceHostListSource(choice.deviceStorage)
  return null
}
