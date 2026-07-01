export interface MemoryCacheOptions {
  ttlMs?: number
  maxEntries?: number
}

export interface CacheEntry<V> {
  value: V
  expiresAt: number
  isStale: boolean
}

export interface GetOrLoadOptions {
  force?: boolean
  allowStale?: boolean
}

export class MemoryCache<K, V> {
  private entries = new Map<K, { value: V; expiresAt: number }>()
  private inflight = new Map<K, Promise<V>>()

  constructor(private readonly options: MemoryCacheOptions = {}) {}

  get size(): number {
    this.pruneExpired()
    return this.entries.size
  }

  get(key: K): V | undefined {
    const entry = this.getEntry(key)
    return entry && !entry.isStale ? entry.value : undefined
  }

  getStale(key: K): V | undefined {
    return this.getEntry(key, { allowStale: true })?.value
  }

  getEntry(key: K, options: { allowStale?: boolean } = {}): CacheEntry<V> | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined

    const isStale = this.isExpired(entry)
    if (isStale && !options.allowStale) {
      this.entries.delete(key)
      return undefined
    }

    this.touch(key, entry)
    return { value: entry.value, expiresAt: entry.expiresAt, isStale }
  }

  has(key: K): boolean {
    return this.getEntry(key) !== undefined
  }

  set(key: K, value: V, options: { ttlMs?: number } = {}): V {
    this.entries.set(key, {
      value,
      expiresAt: this.expiresAt(options.ttlMs),
    })
    this.evictOverflow()
    return value
  }

  delete(key: K): boolean {
    this.inflight.delete(key)
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.inflight.clear()
  }

  keys(options: { includeStale?: boolean } = {}): K[] {
    if (!options.includeStale) this.pruneExpired()
    return Array.from(this.entries.keys())
  }

  invalidateWhere(predicate: (key: K, value: V) => boolean): number {
    let count = 0
    for (const [key, entry] of this.entries) {
      if (!predicate(key, entry.value)) continue
      this.entries.delete(key)
      this.inflight.delete(key)
      count++
    }
    return count
  }

  async getOrLoad(
    key: K,
    load: () => Promise<V>,
    options: GetOrLoadOptions = {}
  ): Promise<V> {
    if (!options.force) {
      const fresh = this.getEntry(key)
      if (fresh) return fresh.value
    }

    const active = this.inflight.get(key)
    if (active) {
      if (options.allowStale) {
        const stale = this.getEntry(key, { allowStale: true })
        if (stale) return stale.value
      }
      return active
    }

    const promise = load()
      .then((value) => this.set(key, value))
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key)
      })
    this.inflight.set(key, promise)

    if (options.allowStale) {
      const stale = this.getEntry(key, { allowStale: true })
      if (stale) return stale.value
    }

    return promise
  }

  private expiresAt(ttlMs = this.options.ttlMs): number {
    return ttlMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttlMs
  }

  private isExpired(entry: { expiresAt: number }): boolean {
    return entry.expiresAt <= Date.now()
  }

  private touch(key: K, entry: { value: V; expiresAt: number }): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private pruneExpired(): void {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) this.entries.delete(key)
    }
  }

  private evictOverflow(): void {
    const maxEntries = this.options.maxEntries
    if (maxEntries === undefined || maxEntries < 1) return
    while (this.entries.size > maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      this.entries.delete(oldest)
      this.inflight.delete(oldest)
    }
  }
}
