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

export class HostReads {
  private readonly requests = new Map<string, number>()
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
   * `previous`; a successful read replaces that copy.
   */
  async read<T>(
    map: Map<string, LoadState<T>>,
    key: string,
    hostId: string,
    cacheKey: string,
    run: (connection: HostConnection, previous: T | null) => Promise<T>,
  ): Promise<void> {
    const request = ++this.nextRequest
    this.requests.set(key, request)
    let previous = shownValue(map.get(key) ?? IDLE)
    if (previous === null) {
      previous = await this.cache.read<T>(hostId, cacheKey)
      if (this.requests.get(key) !== request) return
    }
    const connection = this.connectionFor(hostId)
    if (!connection) {
      map.set(key, { kind: 'error', message: UNREACHABLE, githubAuth: false, offline: true, previous })
      this.changes.notify()
      return
    }
    const generation = connection.state.sessionGeneration
    map.set(key, { kind: 'loading', previous })
    this.changes.notify()
    let next: LoadState<T>
    try {
      next = { kind: 'loaded', value: await run(connection, previous) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      next = { kind: 'error', message, githubAuth: isGithubAuthError(message), offline: connection.state.phase !== 'connected', previous }
    }
    const isCurrent = this.requests.get(key) === request
      && this.connectionFor(hostId) === connection
      && connection.state.sessionGeneration === generation
    if (!isCurrent) return
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
    }
  }
}

export async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await promise }
  } catch {
    return { ok: false }
  }
}
