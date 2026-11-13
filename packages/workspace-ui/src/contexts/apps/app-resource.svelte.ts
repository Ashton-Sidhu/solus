import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'

/** Keyed by host and app id: two hosts can hold the same id. */
export function appKey(serverId: string, appId: string): string {
  return `${serverId}\n${appId}`
}

function sameQuery<Query>(a: Query, b: Query): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * One read of an app's Manage page (versions, schedules, calls, runs, files,
 * one call, one run), for each app that a view loaded it for. `Query` is what
 * the read asks for: the filter of a list, or the id of one call; null for a
 * read with nothing to ask. A read that a newer read or a command's answer
 * overtook is dropped.
 */
export class AppResource<Value, Query = null> {
  private readonly values = new SvelteMap<string, Value>()
  private readonly errors = new SvelteMap<string, string>()
  private readonly reads = new Map<string, number>()
  private readonly queries = new Map<string, Query>()
  /** How many views show the value now, for each app. */
  private readonly watchers = new Map<string, number>()
  private readonly inFlight = new Set<string>()
  /** A change came while a read was in flight: one more read follows it. */
  private readonly readAgain = new Set<string>()

  constructor(
    private readonly read: (api: HostApi, appId: string, query: Query) => Promise<Value>,
    private readonly defaultQuery: Query,
  ) {}

  get(serverId: string, appId: string): Value | undefined {
    return this.values.get(appKey(serverId, appId))
  }

  errorFor(serverId: string, appId: string): string | null {
    return this.errors.get(appKey(serverId, appId)) ?? null
  }

  /** What the last read asked for: a view that opens again starts from it. */
  queryFor(serverId: string, appId: string): Query {
    return this.queries.get(appKey(serverId, appId)) ?? this.defaultQuery
  }

  /** Read with `query`, or with the query of the read before. */
  async load(serverId: string, appId: string, query?: Query): Promise<void> {
    const key = appKey(serverId, appId)
    const previous = this.queries.get(key)
    const next = query === undefined ? previous ?? this.defaultQuery : query
    // The value of another query is not the value of this one: the view loads again.
    if (previous !== undefined && !sameQuery(previous, next)) {
      this.values.delete(key)
      this.errors.delete(key)
    }
    this.queries.set(key, next)
    const read = (this.reads.get(key) ?? 0) + 1
    this.reads.set(key, read)
    this.inFlight.add(key)
    this.readAgain.delete(key)
    try {
      const value = await this.read(serverConnections.apiFor(serverId), appId, next)
      if (this.reads.get(key) !== read) return
      this.values.set(key, value)
      this.errors.delete(key)
    } catch (error) {
      if (this.reads.get(key) !== read) return
      this.errors.set(key, error instanceof Error && error.message ? error.message : 'The host did not answer.')
    } finally {
      if (this.reads.get(key) === read) {
        this.inFlight.delete(key)
        if (this.readAgain.delete(key)) void this.load(serverId, appId)
      }
    }
  }

  /**
   * Read for a view that shows the value, and keep it fresh while the view
   * holds the watch. Call from an effect and return the result: the view
   * releases the watch when it goes.
   */
  watch(serverId: string, appId: string, query?: Query): () => void {
    const key = appKey(serverId, appId)
    this.watchers.set(key, (this.watchers.get(key) ?? 0) + 1)
    void this.load(serverId, appId, query)
    let isReleased = false
    return () => {
      if (isReleased) return
      isReleased = true
      const count = (this.watchers.get(key) ?? 1) - 1
      if (count > 0) this.watchers.set(key, count)
      else this.watchers.delete(key)
    }
  }

  /** A command answered with the whole value: it is newer than any read in flight. */
  accept(serverId: string, appId: string, value: Value): void {
    const key = appKey(serverId, appId)
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1)
    this.inFlight.delete(key)
    this.readAgain.delete(key)
    this.values.set(key, value)
    this.errors.delete(key)
  }

  /** Read again, when a view loaded the value before. */
  reloadIfLoaded(serverId: string, appId: string): void {
    if (this.values.has(appKey(serverId, appId))) void this.load(serverId, appId)
  }

  /**
   * Read again, when a view shows the value now. The host can say that an
   * app's activity changed twice in one second: a change that comes while a
   * read is in flight makes one more read, not one for each change.
   */
  reloadIfWatched(serverId: string, appId: string): void {
    const key = appKey(serverId, appId)
    if (!this.watchers.has(key)) return
    if (this.inFlight.has(key)) this.readAgain.add(key)
    else void this.load(serverId, appId)
  }

  drop(key: string): void {
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1)
    this.inFlight.delete(key)
    this.readAgain.delete(key)
    this.queries.delete(key)
    this.values.delete(key)
    this.errors.delete(key)
  }
}
