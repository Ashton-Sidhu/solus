/**
 * The pull request cache in this browser's IndexedDB, for desktop and web.
 *
 * The rules are not here: `PullRequestCache` (client-core) names the records
 * to remove, so desktop, web and mobile keep the same bounds. A record's size
 * and age live apart from its payload, so the bounds read small rows only.
 *
 * Where IndexedDB is missing, the memory database stands in. Where it will not
 * open (blocked site data), each read finds nothing and each write is lost:
 * `PullRequestCache` never fails a read or a command, so the app works as
 * before and only paints later.
 */
import {
  memoryPullRequestCacheDatabase,
  PullRequestCache,
  type PullRequestCacheDatabase,
  type PullRequestCacheEntry,
  type PullRequestCacheKind,
} from '@solus/client-core/pull-request-cache'

const DATABASE_NAME = 'solus-pull-requests'
const DATABASE_VERSION = 1
/** `[hostId, kind, key]` → size and age. */
const META = 'meta'
/** `[hostId, kind, key]` → the stored answer. */
const PAYLOAD = 'payload'
const BY_HOST_KIND = 'byHostKind'
const BY_HOST = 'byHost'

interface MetaRecord extends PullRequestCacheEntry {
  hostId: string
  kind: PullRequestCacheKind
}

interface PayloadRecord {
  hostId: string
  kind: PullRequestCacheKind
  key: string
  payload: string
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      const meta = db.createObjectStore(META, { keyPath: ['hostId', 'kind', 'key'] })
      meta.createIndex(BY_HOST_KIND, ['hostId', 'kind'])
      meta.createIndex(BY_HOST, 'hostId')
      db.createObjectStore(PAYLOAD, { keyPath: ['hostId', 'kind', 'key'] })
    }
    request.onsuccess = () => {
      const db = request.result
      // A newer tab upgrading the schema must not wait on this one.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('The pull request cache is held by another tab.'))
  })
}

/** The IndexedDB database behind the cache. Opened on first use; a failed
 *  open is not kept, so a later call tries again. */
export function indexedDbPullRequestCache(factory: IDBFactory): PullRequestCacheDatabase {
  let opened: Promise<IDBDatabase> | null = null
  const database = () => {
    if (opened) return opened
    const attempt = openDatabase(factory)
    opened = attempt
    attempt.then(undefined, () => { if (opened === attempt) opened = null })
    return attempt
  }
  return {
    get: async (kind, hostId, key) => {
      const transaction = (await database()).transaction([META, PAYLOAD], 'readonly')
      // SAFETY: only this module writes these stores, and each holds one record shape.
      const [meta, payload] = await Promise.all([
        done(transaction.objectStore(META).get([hostId, kind, key])) as Promise<MetaRecord | undefined>,
        // SAFETY: as above.
        done(transaction.objectStore(PAYLOAD).get([hostId, kind, key])) as Promise<PayloadRecord | undefined>,
      ])
      return meta && payload ? { payload: payload.payload, updatedAt: meta.updatedAt } : null
    },
    put: async (kind, hostId, entry) => {
      const transaction = (await database()).transaction([META, PAYLOAD], 'readwrite')
      transaction.objectStore(META).put({ hostId, kind, key: entry.key, bytes: entry.bytes, updatedAt: entry.updatedAt } satisfies MetaRecord)
      transaction.objectStore(PAYLOAD).put({ hostId, kind, key: entry.key, payload: entry.payload } satisfies PayloadRecord)
      await committed(transaction)
    },
    delete: async (kind, hostId, keys) => {
      const transaction = (await database()).transaction([META, PAYLOAD], 'readwrite')
      for (const key of keys) {
        transaction.objectStore(META).delete([hostId, kind, key])
        transaction.objectStore(PAYLOAD).delete([hostId, kind, key])
      }
      await committed(transaction)
    },
    entries: async (kind, hostId) => {
      const transaction = (await database()).transaction(META, 'readonly')
      // SAFETY: only this module writes the meta store, and it holds `MetaRecord`s alone.
      const rows = await done(transaction.objectStore(META).index(BY_HOST_KIND).getAll([hostId, kind])) as MetaRecord[]
      return rows.map(({ key, bytes, updatedAt }) => ({ key, bytes, updatedAt }))
    },
    deleteHost: async (hostId) => {
      const transaction = (await database()).transaction([META, PAYLOAD], 'readwrite')
      // SAFETY: only this module writes the meta store, and it holds `MetaRecord`s alone.
      const rows = await done(transaction.objectStore(META).index(BY_HOST).getAll(hostId)) as MetaRecord[]
      for (const row of rows) {
        transaction.objectStore(META).delete([row.hostId, row.kind, row.key])
        transaction.objectStore(PAYLOAD).delete([row.hostId, row.kind, row.key])
      }
      await committed(transaction)
    },
  }
}

/** This device's pull request cache: IndexedDB where the browser has it. */
export const prDeviceCache = new PullRequestCache(
  'indexedDB' in globalThis ? indexedDbPullRequestCache(globalThis.indexedDB) : memoryPullRequestCacheDatabase(),
)
