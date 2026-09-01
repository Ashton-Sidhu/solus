import { describe, expect, test } from 'bun:test'
import type { PullRequestSummary } from '../../src/shared/providers'
import {
  OPEN_PR_STATUS_KEYS,
  prFetchScope,
  prInboxGroups,
  prRow,
  prStatusOf,
  shortBranch,
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

describe('PR status filter', () => {
  const merged: PullRequestSummary = { ...pullRequest, number: 7, state: 'merged' }
  const inbox = (statuses: string[]) =>
    prInboxGroups(
      [pullRequest, merged],
      context,
      NOW,
      { review() {}, open() {}, openExternal() {} },
      new Set(statuses),
    )

  test('leaves landed work out of the inbox until its status is picked', () => {
    // WHY: the inbox is the queue of things to decide. A merged PR is settled,
    // so it must not push live work down the list — but it stays one click
    // away, because "what did I land" is a real question this page answers.
    expect(inbox(OPEN_PR_STATUS_KEYS).some((group) => group.key === 'done')).toBe(false)
    expect(inbox([...OPEN_PR_STATUS_KEYS, 'merged']).find((g) => g.key === 'done')?.rows).toHaveLength(1)
  })

  test('asking for a landed pull request widens the fetch, not just the view', () => {
    // WHY: the host pages open and closed separately, so a status the page
    // never loaded cannot be revealed by filtering — picking it has to change
    // what is fetched or the list silently comes back empty.
    expect(prFetchScope(OPEN_PR_STATUS_KEYS)).toBe('open')
    expect(prFetchScope(['merged', 'closed'])).toBe('closed')
    expect(prFetchScope(['open', 'merged'])).toBe('all')
  })

  test('a draft is its own status, so hiding drafts keeps real open PRs', () => {
    // WHY: drafts are the noisiest thing on the page and the least actionable;
    // they earn a switch of their own rather than riding on "open".
    const draft: PullRequestSummary = { ...pullRequest, number: 9, draft: true }
    expect(prStatusOf(draft)).toBe('draft')
    expect(prStatusOf(pullRequest)).toBe('open')
    expect(prStatusOf(merged)).toBe('merged')
  })
})

describe('PR row slots', () => {
  const checksContext = (state: 'passing' | 'failing' | 'pending', headSha = 'abc123'): PrRowContext => ({
    checks: () => ({ state, headSha, required: [], optional: [], inFlight: state === 'pending' }),
    isMine: () => true,
  })

  test('the branch is a hover reveal, not a chip that costs every row width', () => {
    // WHY: agent-authored branches are long and near-identical. Spending that
    // width on every row at rest is width taken from the title, which is the
    // thing being scanned — so slot 4 must carry it and the chips must not.
    const row = prRow({ ...pullRequest, headRef: 'solus/look-at-git-commits-f-7jgnb' }, context, NOW)
    expect(row.chips).toHaveLength(0)
    expect(row.reveal?.title).toBe('solus/look-at-git-commits-f-7jgnb')
  })

  test('a long branch keeps its tail, because that is what tells two apart', () => {
    // WHY: generated refs share a prefix and differ in the suffix. Ellipsising
    // the end would make every row read the same.
    expect(shortBranch('solus/short-fix')).toBe('solus/short-fix')
    const short = shortBranch('solus/look-at-git-commits-in-userssidhusolus-f-7jgnb')
    expect(short.startsWith('solus/look-')).toBe(true)
    expect(short.endsWith('-f-7jgnb')).toBe(true)
  })

  test('nothing to say about checks still holds the slot', () => {
    // WHY: pending resolves on its own and a stale summary is not this PR's
    // result — but the slot has to keep its width, or the row shifts under the
    // pointer the moment the result lands.
    expect(prRow(pullRequest, checksContext('pending'), NOW).checks).toEqual({ state: 'none', label: '' })
    expect(prRow(pullRequest, checksContext('passing', 'stale-sha'), NOW).checks).toEqual({
      state: 'none',
      label: '',
    })
  })

  test('passing gets a glyph and failing gets words', () => {
    // WHY: a "checks passing" pill on every row is the expected case spending
    // the width of the exception. Only failure is worth reading as text.
    expect(prRow(pullRequest, checksContext('passing'), NOW).checks).toMatchObject({ state: 'passing' })
    expect(prRow(pullRequest, checksContext('failing'), NOW).checks).toMatchObject({
      state: 'failing',
      label: 'checks failing',
    })
  })

  test('churn stays numbers, so the row can colour the sign', () => {
    // WHY: colour carries the sign in slot 6; a pre-joined "+5 −1" string would
    // force the row back to one muted colour for both directions.
    expect(prRow(pullRequest, context, NOW).churn).toEqual({ additions: 5, deletions: 1 })
  })

  test('a stacked PR names its parent inside the same reveal', () => {
    // WHY: the relationship is worth one line of the row it belongs to, not an
    // indent that reorders the list you are scanning.
    expect(prRow(pullRequest, context, NOW, 41).reveal?.lead).toBe('stacked on #41')
    expect(prRow({ ...pullRequest, headRef: undefined }, context, NOW).reveal).toBeUndefined()
  })
})

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
        new Set(OPEN_PR_STATUS_KEYS),
      )[0]?.rows[0]?.actor,
    ).toMatchObject({ id: 'octocat', avatarUrl: AUTHOR_AVATAR })
  })
})
