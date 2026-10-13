// Adapted from T3 Code apps/mobile/src/persistence/mobile-database.ts (MIT, see UPSTREAM.md).

/**
 * The pull request cache: the device copy of pull request data that was read
 * once, so that it is still readable when the host cannot be reached. The
 * stores write each answer here and show it again when a read fails.
 *
 * Two kinds of record are kept for each host:
 * - `response`: a copy of a host answer. It is bounded (30 days, 256 records,
 *   32 MiB), and an answer larger than 4 MiB is not kept, so that one large
 *   diff cannot push out every other record.
 * - `draft`: a review draft the person wrote. It is not bounded: only a
 *   submit or a discard removes it.
 *
 * The database is behind `PullRequestCacheDatabase`, so the native app gives
 * the `expo-sqlite` adapter (`platform/pull-request-cache-sqlite.ts`) and the
 * tests give the memory one below.
 */

export type PullRequestCacheKind = 'response' | 'draft'

/** One stored record, without its payload: what the bounds read. */
export interface PullRequestCacheEntry {
  key: string
  bytes: number
  updatedAt: number
}

export interface PullRequestCacheDatabase {
  get(kind: PullRequestCacheKind, hostId: string, key: string): Promise<{ payload: string; updatedAt: number } | null>
  put(kind: PullRequestCacheKind, hostId: string, entry: PullRequestCacheEntry & { payload: string }): Promise<void>
  delete(kind: PullRequestCacheKind, hostId: string, keys: readonly string[]): Promise<void>
  /** Every record of one kind for one host, in no fixed order. */
  entries(kind: PullRequestCacheKind, hostId: string): Promise<PullRequestCacheEntry[]>
  /** Every record of every kind for one host. */
  deleteHost(hostId: string): Promise<void>
}

export const PULL_REQUEST_CACHE_LIMITS = {
  maxAgeMs: 30 * 24 * 60 * 60_000,
  maxRecords: 256,
  maxBytes: 32 * 1024 * 1024,
  maxRecordBytes: 4 * 1024 * 1024,
} as const

/** The UTF-8 size of a string, as SQLite stores the payload. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      // A surrogate pair is one code point of four bytes.
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/**
 * The response records to remove: newest first, a record stays while it is
 * younger than the age limit, within the record limit, and within the byte
 * limit counted from the newest record.
 */
export function prunedCacheKeys(entries: readonly PullRequestCacheEntry[], now: number, limits = PULL_REQUEST_CACHE_LIMITS): string[] {
  const newestFirst = [...entries].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
  const removed: string[] = []
  let total = 0
  newestFirst.forEach((entry, index) => {
    total += entry.bytes
    if (index >= limits.maxRecords || total > limits.maxBytes || entry.updatedAt < now - limits.maxAgeMs) removed.push(entry.key)
  })
  return removed
}

/** Changing the stored shape changes this, so an old record is not read as a new one. */
const FORMAT = 'v1'

export class PullRequestCache {
  constructor(
    private readonly database: PullRequestCacheDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  /** A kept answer, or null when there is none, it is too old, or it cannot be read. */
  async read<T>(hostId: string, key: string): Promise<T | null> {
    return this.get<T>('response', hostId, key, true)
  }

  /** Keeps an answer, then removes what is over the bounds. A failure only
   *  loses the copy: the cache never fails a read or a command. */
  async write<T>(hostId: string, key: string, value: T): Promise<void> {
    try {
      const payload = JSON.stringify(value)
      const bytes = utf8Length(payload)
      if (bytes > PULL_REQUEST_CACHE_LIMITS.maxRecordBytes) return
      await this.database.put('response', hostId, { key: `${FORMAT}:${key}`, payload, bytes, updatedAt: this.now() })
      const removed = prunedCacheKeys(await this.database.entries('response', hostId), this.now())
      if (removed.length > 0) await this.database.delete('response', hostId, removed)
    } catch {
      // A copy that is not kept is only a copy that is not kept.
    }
  }

  async readDraft<T>(hostId: string, key: string): Promise<T | null> {
    return this.get<T>('draft', hostId, key, false)
  }

  /** A draft is kept whole or removed; `null` removes it. */
  async writeDraft<T>(hostId: string, key: string, value: T | null): Promise<void> {
    const stored = `${FORMAT}:${key}`
    if (value === null) {
      await this.database.delete('draft', hostId, [stored])
      return
    }
    const payload = JSON.stringify(value)
    await this.database.put('draft', hostId, { key: stored, payload, bytes: utf8Length(payload), updatedAt: this.now() })
  }

  /** Everything this device kept for a host leaves with it. */
  async forgetHost(hostId: string): Promise<void> {
    await this.database.deleteHost(hostId).catch(() => undefined)
  }

  private async get<T>(kind: PullRequestCacheKind, hostId: string, key: string, bounded: boolean): Promise<T | null> {
    try {
      const record = await this.database.get(kind, hostId, `${FORMAT}:${key}`)
      if (!record) return null
      if (bounded && record.updatedAt < this.now() - PULL_REQUEST_CACHE_LIMITS.maxAgeMs) return null
      // SAFETY: this device wrote the payload from a `T` under the same format
      // version and key, so the parsed value has that shape.
      return JSON.parse(record.payload) as T
    } catch {
      return null
    }
  }
}

/** The database in memory: for tests, and for a build with no SQLite adapter. */
export function memoryPullRequestCacheDatabase(): PullRequestCacheDatabase {
  const records = new Map<string, PullRequestCacheEntry & { payload: string; kind: PullRequestCacheKind; hostId: string }>()
  const id = (kind: PullRequestCacheKind, hostId: string, key: string) => `${kind}\u0000${hostId}\u0000${key}`
  return {
    get: async (kind, hostId, key) => {
      const record = records.get(id(kind, hostId, key))
      return record ? { payload: record.payload, updatedAt: record.updatedAt } : null
    },
    put: async (kind, hostId, entry) => { records.set(id(kind, hostId, entry.key), { ...entry, kind, hostId }) },
    delete: async (kind, hostId, keys) => { for (const key of keys) records.delete(id(kind, hostId, key)) },
    entries: async (kind, hostId) => Array.from(records.values())
      .filter((record) => record.kind === kind && record.hostId === hostId)
      .map(({ key, bytes, updatedAt }) => ({ key, bytes, updatedAt })),
    deleteHost: async (hostId) => {
      for (const [key, record] of records) if (record.hostId === hostId) records.delete(key)
    },
  }
}
