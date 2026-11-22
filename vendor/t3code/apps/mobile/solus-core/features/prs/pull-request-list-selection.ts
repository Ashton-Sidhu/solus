import { sameItems } from '@solus/client-core/keep-equal'
import { pullRequestRows, type PullRequestRow } from './lib/pull-request-list'
import type { HostPullRequests, PullRequestDirectory } from './pull-request-directory'
import { shownValue, type LoadState } from './pull-request-reads'

/** One host of the Pull Requests tab and the state of its read. */
export interface HostListRead {
  hostId: string
  state: LoadState<HostPullRequests>
}

/**
 * What one list on screen reads from the directory, as snapshots for
 * `useSyncExternalStore`. `hosts` is new only when the read state of one of
 * its hosts changes, for the notices and the first-read spinner. `rows` is new
 * only when a listing it shows changes, and keeps each row whose pull request
 * did not change: an equal refresh, a filter set again, or a change on a host
 * the list does not show renders no row again.
 */
export class PullRequestListSelection {
  private heldHosts: readonly HostListRead[] = []
  private heldRows: readonly PullRequestRow[] = []
  /** The shown listing of each host, in order, that `heldRows` was built from. */
  private rowsFrom: readonly { hostId: string; listing: HostPullRequests | null }[] = []

  constructor(private readonly directory: Pick<PullRequestDirectory, 'hostOf'>) {}

  hosts(hostIds: readonly string[]): readonly HostListRead[] {
    const held = this.heldHosts
    const isSame = held.length === hostIds.length
      && hostIds.every((hostId, index) => held[index]!.hostId === hostId && held[index]!.state === this.directory.hostOf(hostId))
    if (!isSame) this.heldHosts = hostIds.map((hostId) => ({ hostId, state: this.directory.hostOf(hostId) }))
    return this.heldHosts
  }

  rows(hostIds: readonly string[]): readonly PullRequestRow[] {
    const listings = this.hosts(hostIds).map(({ hostId, state }) => ({ hostId, listing: shownValue(state) }))
    const from = this.rowsFrom
    // A state change that kept every listing (loading, then loaded) reads no row.
    const isSame = listings.length === from.length
      && listings.every((entry, index) => entry.hostId === from[index]!.hostId && entry.listing === from[index]!.listing)
    if (isSame) return this.heldRows
    this.rowsFrom = listings
    const rows = pullRequestRows(listings, this.heldRows)
    if (!sameItems(rows, this.heldRows)) this.heldRows = rows
    return this.heldRows
  }
}
