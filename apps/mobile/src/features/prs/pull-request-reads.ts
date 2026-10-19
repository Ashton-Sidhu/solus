import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'
import { isGithubAuthError } from './lib/pr-presentation'
import type { PullRequestCache } from './pull-request-cache'

/**
 * The read rules every pull request store shares: a read and what it last
 * showed, the stale-read guard, and the device copy for offline use.
 */

/** A read and what it last showed. `githubAuth`: the host has no working
 *  GitHub connection, so the answer is to connect it, not to retry.
 *  `offline`: the host was not connected when the read failed; `previous` is
 *  then the device copy, when there is one. */
export type LoadState<T> =
  | { kind: 'idle' }
  | { kind: 'loading'; previous: T | null }
  | { kind: 'loaded'; value: T }
  | { kind: 'error'; message: string; githubAuth: boolean; offline: boolean; previous: T | null }

export const IDLE = { kind: 'idle' } as const

/** What a state can still show: the value, or the last one while reading again. */
export function shownValue<T>(state: LoadState<T>): T | null {
  return state.kind === 'loaded' ? state.value : state.kind === 'idle' ? null : state.previous
}

export const UNREACHABLE = 'This host cannot be reached now.'

/** The connection for a command, which needs the host now. */
export function connectedHost(connection: HostConnection | null): HostConnection {
  if (!connection || connection.state.phase !== 'connected') throw new Error('Connect to this host to make this change.')
  return connection
}

/** How a read meets another read of the same key on the wire. `share`: the
 *  reads of this key ask the same question, so a read joins one on the wire
 *  and later reads may join it. `force`: a new read even so — a person's
 *  refresh, or a read after a write that the read on the wire predates. */
export interface ReadSharing {
  share?: boolean
  force?: boolean
}

/** `retain` keeps what shows: given an answer and the value shown now, it
 *  returns the answer with each equal part as the shown object, or the shown
 *  value itself when all of it is equal. A reader that selects only the value
 *  then sees no change; the read state still goes from loading to loaded. */
export interface ReadOptions<T> extends ReadSharing {
  retain?: (next: T, shown: T) => T
}

/** A shared read on the wire, and the connection it reads through. */
interface SharedRead {
  request: number
  connection: HostConnection
  generation: number
  done: Promise<void>
}

export class HostReads {
  private readonly requests = new Map<string, number>()
  private readonly shared = new Map<string, SharedRead>()
  private nextRequest = 0

  constructor(
    private readonly changes: Listeners,
    private readonly connectionFor: (hostId: string) => HostConnection | null,
    private readonly cache: PullRequestCache,
  ) {}

  /**
   * Reads `key` into `map`. A read that a newer read of the same key, or a
   * new server session, makes stale is dropped rather than shown. While the
   * state has nothing to show, the device copy under `cacheKey` is shown as
   * `previous`; a successful read replaces that copy. The device copy is read
   * at the same time as the host, never before it.
   *
   * `run` may `show` a part of its answer while it still reads: the state
   * stays `loading` with that part as `previous`, so a screen paints what has
   * arrived and does not wait for the slowest call. Only the final answer is
   * kept on the device.
   *
   * With `options.share`, a read joins a shared read of the same key that is
   * still current, unless `options.force`: screens that ask together cost
   * one read. With `options.retain`, a part or an answer equal to what shows
   * keeps the shown object, and a part equal to what shows is not shown again.
   */
  read<T>(
    map: Map<string, LoadState<T>>,
    key: string,
    hostId: string,
    cacheKey: string,
    run: (connection: HostConnection, previous: T | null, show: (partial: T) => void) => Promise<T>,
    options: ReadOptions<T> = {},
  ): Promise<void> {
    const onWire = this.shared.get(key)
    if (options.share && !options.force && onWire && this.isCurrent(key, hostId, onWire)) return onWire.done
    const done = this.start(map, key, hostId, cacheKey, run, options.retain)
    // `start` has named its request and connection before its first wait.
    const connection = this.connectionFor(hostId)
    const request = this.requests.get(key)
    if (options.share && connection && request !== undefined) {
      const entry = { request, connection, generation: connection.state.sessionGeneration, done }
      this.shared.set(key, entry)
      void done.finally(() => { if (this.shared.get(key) === entry) this.shared.delete(key) })
    }
    return done
  }

  /** Whether a shared read is still the newest read of its key, on the current server session. */
  private isCurrent(key: string, hostId: string, read: SharedRead): boolean {
    return this.requests.get(key) === read.request
      && this.connectionFor(hostId) === read.connection
      && read.connection.state.sessionGeneration === read.generation
  }

  private async start<T>(
    map: Map<string, LoadState<T>>,
    key: string,
    hostId: string,
    cacheKey: string,
    run: (connection: HostConnection, previous: T | null, show: (partial: T) => void) => Promise<T>,
    retain: ((next: T, shown: T) => T) | undefined,
  ): Promise<void> {
    const request = ++this.nextRequest
    this.requests.set(key, request)
    let previous = shownValue(map.get(key) ?? IDLE)
    const connection = this.connectionFor(hostId)
    if (!connection) {
      previous ??= await this.cache.read<T>(hostId, cacheKey)
      if (this.requests.get(key) !== request) return
      map.set(key, { kind: 'error', message: UNREACHABLE, githubAuth: false, offline: true, previous })
      this.changes.notify()
      return
    }
    const generation = connection.state.sessionGeneration
    const isCurrent = () => this.requests.get(key) === request
      && this.connectionFor(hostId) === connection
      && connection.state.sessionGeneration === generation
    let running = true
    /** The answer, with what equals the value shown now kept as that value. */
    const kept = (answer: T): T => {
      const shown = shownValue(map.get(key) ?? IDLE)
      return retain && shown !== null ? retain(answer, shown) : answer
    }
    const show = (partial: T) => {
      if (!running || !isCurrent()) return
      const next = kept(partial)
      const state = map.get(key)
      // The state already shows this value while it reads.
      if (state?.kind === 'loading' && state.previous === next) return
      previous = next
      map.set(key, { kind: 'loading', previous: next })
      this.changes.notify()
    }
    map.set(key, { kind: 'loading', previous })
    this.changes.notify()
    if (previous === null) {
      // The device copy shows while the host reads, unless the host answered first.
      void this.cache.read<T>(hostId, cacheKey).then((copy) => {
        if (copy !== null && previous === null) show(copy)
      })
    }
    let next: LoadState<T>
    try {
      next = { kind: 'loaded', value: kept(await run(connection, previous, show)) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      next = { kind: 'error', message, githubAuth: isGithubAuthError(message), offline: connection.state.phase !== 'connected', previous }
    }
    running = false
    if (!isCurrent()) return
    map.set(key, next)
    this.changes.notify()
    if (next.kind === 'loaded') void this.cache.write(hostId, cacheKey, next.value)
  }

  /** Drops every key of a host from `map`; keys start with the host id. */
  forgetHost<T>(map: Map<string, LoadState<T>>, hostId: string): void {
    for (const key of Array.from(map.keys())) {
      if (!key.startsWith(`${hostId}\u0000`)) continue
      map.delete(key)
      this.requests.delete(key)
      this.shared.delete(key)
    }
  }
}

export type Settled<T> = { ok: true; value: T } | { ok: false }

export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise }
  } catch {
    return { ok: false }
  }
}
