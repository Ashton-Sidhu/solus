import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path: string) => readFileSync(resolve(import.meta.dir, '../../', path), 'utf8')

/**
 * The review page reads a pull request's checks out of the checks store, which
 * is filled by the host's poll broadcast — and that broadcast only lands on a
 * project this client has already asked about. Nothing on the review page
 * asked, so a review opened from a deep link, a chip, or a project other than
 * the one the list last loaded sat with no checks in its rail and a merge
 * status that could not see a failing run.
 */
describe('the PR review page asks for its own checks', () => {
  const feed = read('packages/workspace-ui/src/components/pr-review/ActivityFeed.svelte')

  it('loads checks for the pull request it is showing, on every open', () => {
    const initialLoad = feed.slice(
      feed.indexOf('function load(force'),
      feed.indexOf('function loadReviewerCandidates'),
    )
    // Naming the number matters: the host's poll set is the open list it read
    // once, and a pull request opened since is not in it until someone asks.
    expect(initialLoad).toContain('pullRequests.checks\n      .load(getApi(), serverId, feedCtx(), [n])')
  })

  it('reads the summary from the same scope it loaded into', () => {
    expect(feed).toContain('pullRequests.checks.summaryFor(serverId, feedCtx(), pr.number)')
  })
})
