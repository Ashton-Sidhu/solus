import type { PullRequest } from '@solus/contracts/providers'
import type { PrSort } from '@solus/contracts/pr-views'

/** The one pull request order on every client, by time as T3 Code sorts.
 *  Ties are stable by URL. */
export function comparePrs(a: PullRequest, b: PullRequest, sort: PrSort): number {
  switch (sort) {
    case 'created':
      return b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt) || a.url.localeCompare(b.url)
    case 'oldest':
      return a.updatedAt.localeCompare(b.updatedAt) || a.url.localeCompare(b.url)
    case 'updated':
      return b.updatedAt.localeCompare(a.updatedAt) || a.url.localeCompare(b.url)
  }
}
