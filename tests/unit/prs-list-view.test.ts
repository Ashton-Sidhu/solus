import { describe, expect, test } from 'bun:test'
import type { PullRequestSummary } from '../../src/shared/providers'
import {
  prInboxGroups,
  prRow,
  type PrRowContext,
} from '../../src/renderer/components/prs/lib/prs-list-view'

const NOW = Date.parse('2026-08-04T13:00:00Z')
const AUTHOR_AVATAR = 'https://avatars.githubusercontent.com/u/1?v=4'

const pullRequest: PullRequestSummary = {
  number: 42,
  title: 'Show GitHub avatars',
  headSha: 'abc123',
  author: 'octocat',
  authorAvatarUrl: AUTHOR_AVATAR,
  state: 'open',
  createdAt: '2026-08-04T11:00:00Z',
  updatedAt: '2026-08-04T12:00:00Z',
  draft: false,
  labels: [],
  additions: 5,
  deletions: 1,
}

const context: PrRowContext = {
  checks: () => undefined,
  isMine: () => true,
}

describe('PR list author avatars', () => {
  test('uses the GitHub author avatar in global and inbox rows', () => {
    // WHY: both PR page views represent the same author, so neither should
    // regress to generated initials when GitHub already supplied their image.
    expect(prRow(pullRequest, context, NOW).people[0]).toMatchObject({
      id: 'octocat',
      avatarUrl: AUTHOR_AVATAR,
    })

    const blockedContext: PrRowContext = {
      checks: () => ({
        state: 'failing',
        headSha: pullRequest.headSha,
        required: [],
        optional: [],
        inFlight: false,
      }),
      isMine: () => true,
    }
    expect(
      prInboxGroups(
        [pullRequest],
        blockedContext,
        NOW,
        { review() {}, open() {}, openExternal() {} },
      )[0]?.rows[0]?.actor,
    ).toMatchObject({ id: 'octocat', avatarUrl: AUTHOR_AVATAR })
  })
})
