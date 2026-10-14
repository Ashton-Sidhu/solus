import { describe, expect, test } from 'bun:test'
import { pullRequestFallbackHost } from '../../apps/mobile/src/features/prs/lib/pull-request-host-fallback'
import { DEFAULT_PULL_REQUEST_LIST_CONTROLS, filterPullRequestRows, type PullRequestRow } from '../../apps/mobile/src/features/prs/lib/pull-request-list'
import { pullRequest } from './helpers/native-mobile-prs-fixtures'

// Ported from T3 Code #18698. A pull request opened on a host that is now
// offline can only show the device copy. When another connected host has a
// checkout of the same repository, the pull request is read there instead:
// the detail route moves to that host, and the list shows that host's row.

const checkouts = [
  { hostId: 'laptop', projectPath: '/work/t3', repositoryKey: 'github.com/pingdotgg/t3code' },
  { hostId: 'desktop', projectPath: '/src/other', repositoryKey: 'github.com/pingdotgg/other' },
  { hostId: 'server', projectPath: '/srv/t3-copy', repositoryKey: 'github.com/pingdotgg/t3code' },
]
const ref = { hostId: 'laptop', projectPath: '/work/t3', number: 7 }

describe('pull request host fallback', () => {
  test('moves to a connected checkout of the repository when the route host is offline', () => {
    expect(pullRequestFallbackHost(ref, 'github.com/pingdotgg/t3code', checkouts, new Set(['desktop', 'server'])))
      .toEqual({ hostId: 'server', projectPath: '/srv/t3-copy' })
  })

  test('stays while the route host is connected or no other connected host has the repository', () => {
    expect(pullRequestFallbackHost(ref, 'github.com/pingdotgg/t3code', checkouts, new Set(['laptop', 'server']))).toBeNull()
    expect(pullRequestFallbackHost(ref, 'github.com/pingdotgg/t3code', checkouts, new Set(['desktop']))).toBeNull()
  })

  test('takes the repository from the route checkout when the device has no copy of the pull request', () => {
    expect(pullRequestFallbackHost(ref, null, checkouts, new Set(['server']))).toEqual({ hostId: 'server', projectPath: '/srv/t3-copy' })
    expect(pullRequestFallbackHost({ ...ref, projectPath: '/unknown' }, null, checkouts, new Set(['server']))).toBeNull()
  })
})

describe('pull request list de-dupe with connected hosts', () => {
  const row = (hostId: string): PullRequestRow => ({ hostId, projectPath: '/work/app', folderName: 'app', checks: null, pr: pullRequest(1) })
  const pick = (connected: ReadonlySet<string>) =>
    filterPullRequestRows([row('laptop'), row('server')], DEFAULT_PULL_REQUEST_LIST_CONTROLS, () => null, connected).map((kept) => kept.hostId)

  test('shows the row of a connected host over the device copy of an offline one', () => {
    expect(pick(new Set(['server']))).toEqual(['server'])
    expect(pick(new Set(['laptop', 'server']))).toEqual(['laptop'])
    expect(pick(new Set())).toEqual(['laptop'])
  })
})
