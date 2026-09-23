import { describe, expect, test } from 'bun:test'
import type { PullRequest } from '@solus/contracts/providers'
import { pullRequestFixture } from './__fixtures__/pull-request'
import {
  OPEN_PR_STATUS_KEYS,
  prFetchScope,
  prRow,
  prStatusGlyph,
  prStatusOf,
  shortBranch,
  type PrRowContext,
} from '@solus/workspace-ui/components/prs/lib/prs-list-view'
import {
  checksChip,
  chipSkin,
} from '@solus/workspace-ui/components/ui/list-page/list-page'
import {
  PR_ADDITIONS_TONE,
  PR_CHECKS_TONE,
  PR_DELETIONS_TONE,
  PR_STATUS_TONE,
  PR_VERDICT_TONE,
} from '@solus/workspace-ui/components/prs/lib/pr-row-styles'

const NOW = Date.parse('2026-08-04T13:00:00Z')
const AUTHOR_AVATAR = 'https://avatars.githubusercontent.com/u/1?v=4'

const pullRequest = pullRequestFixture(42, {
  title: 'Show GitHub avatars',
  headSha: 'abc123',
  authorAvatarUrl: AUTHOR_AVATAR,
  createdAt: '2026-08-04T11:00:00Z',
  updatedAt: '2026-08-04T12:00:00Z',
  additions: 5,
  deletions: 1,
})

const context: PrRowContext = {
  checks: () => undefined,
  isMine: () => true,
}

describe('PR status filter', () => {
  const merged: PullRequest = { ...pullRequest, number: 7, state: 'merged' }

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
    const draft: PullRequest = { ...pullRequest, number: 9, draft: true }
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

  test('saved guides remain visible as accessible icons in the PR list', () => {
    for (const status of ['ready', 'outdated', 'failed', 'cancelled', 'queued'] as const) {
      const row = prRow(pullRequest, { ...context, guideStatus: () => status }, NOW);
      expect(row.chips.some((chip) => chip.iconOnly && chip.icon && chip.label.includes('guide'))).toBe(true);
    }
  });

  test('guide badge color conveys lifecycle instead of the application accent', () => {
    const expected = { ready: 'success', outdated: 'warning', generating: 'info', failed: 'failure', queued: 'neutral', cancelled: 'neutral' } as const;
    for (const status of Object.keys(expected) as Array<keyof typeof expected>) {
      const chip = prRow(pullRequest, { ...context, guideStatus: () => status }, NOW).chips.find((chip) => chip.iconOnly);
      expect(chip?.tint).toBe(expected[status]);
    }
    expect(chipSkin('info').color).not.toContain('--primary');
  });

  test('shows background guide generation on the pull request row', () => {
    // WHY: guide generation can start from the Git section or an open review.
    // The PR page must still show that shared work instead of looking idle.
    const row = prRow(
      pullRequest,
      { ...context, guideStatus: () => 'generating' },
      NOW,
    )
    expect(row.chips).toContainEqual(expect.objectContaining({ label: 'Generating review guide', iconOnly: true, spinning: true }))
  })

  test('every row leads with its lifecycle, because sorted rows have no group to say it', () => {
    // WHY: the grouped list names the state in its header, but a row under a
    // sort travels without one — and a reader should not have to open a PR to
    // learn whether it is still open, a draft, or already landed.
    expect(prRow(pullRequest, context, NOW).status).toBe('open')
    expect(prRow({ ...pullRequest, draft: true }, context, NOW).status).toBe('draft')
    expect(prRow({ ...pullRequest, state: 'merged' }, context, NOW).status).toBe('merged')
    expect(prRow({ ...pullRequest, state: 'closed' }, context, NOW).status).toBe('closed')
    // The state is the glyph, not a chip: the row must not say it twice.
    expect(prRow(pullRequest, context, NOW).chips).toHaveLength(0)
  })

  test('each state has its own glyph and tone, so states tell apart before they are read', () => {
    // WHY: four states drawn as the same shape in four tints would only tell
    // apart by colour, which a list is not read by. Each is its own shape, the
    // same one the PR detail header uses, so a row and its review agree.
    const glyphs = (['open', 'draft', 'merged', 'closed'] as const).map(prStatusGlyph)
    expect(new Set(glyphs.map((glyph) => glyph.icon)).size).toBe(4)
    expect(new Set(glyphs.map((glyph) => glyph.toneClass)).size).toBe(4)
  })

  test('says nothing about size when the listing carried no line counts', () => {
    // WHY: 0 / 0 is what a listing without line counts reports, not an empty
    // change; printing "+0 −0" on every row states a size nobody measured.
    expect(prRow({ ...pullRequest, additions: 0, deletions: 0 }, context, NOW).churn).toBeUndefined()
    expect(prRow({ ...pullRequest, additions: 3, deletions: 0 }, context, NOW).churn).toEqual({ additions: 3, deletions: 0 })
  })

  test('marks a verdict only when a reviewer gave one', () => {
    // WHY: "review required" is how every open PR starts; marking it would put
    // the same word on most rows and hide the rows that actually changed.
    const verdictOf = (reviewStatus: PullRequest['reviewStatus']) =>
      prRow({ ...pullRequest, reviewStatus }, context, NOW).verdict
    expect(verdictOf('approved')).toBe('approved')
    expect(verdictOf('changes-requested')).toBe('changes-requested')
    expect(verdictOf('review-required')).toBeNull()
    expect(verdictOf(undefined)).toBeNull()
  })

  test('every row tone names its dark-mode colour too', () => {
    // WHY: the tones are full-strength hues, not mixes of the theme's text
    // colour, so a tone without its own dark value would glare or vanish on a
    // dark background.
    const tones = [
      ...Object.values(PR_STATUS_TONE),
      ...Object.values(PR_VERDICT_TONE),
      ...Object.entries(PR_CHECKS_TONE).filter(([state]) => state !== 'none').map(([, tone]) => tone),
      PR_ADDITIONS_TONE,
      PR_DELETIONS_TONE,
    ]
    for (const tone of tones) expect(tone).toMatch(/(^| )dark:text-/)
  })

  test('says where the row lives and who labelled it what', () => {
    // WHY: the list spans repositories, and a label is how a team tags size
    // or trust — both are read off the row, not found by opening it. Labels
    // are capped so one over-tagged PR cannot push the check glyph off the line.
    const row = prRow(
      {
        ...pullRequest,
        labels: [
          { name: 'size:S', color: '0e8a16' },
          { name: 'vouch:trusted', color: '1d76db' },
          { name: 'area:web', color: 'fbca04' },
          { name: 'needs-docs', color: 'd93f0b' },
        ],
      },
      context,
      NOW,
    )
    expect(row.repo).toBe('acme/repo')
    expect(row.labels.map((label) => label.name)).toEqual(['size:S', 'vouch:trusted', 'area:web'])
    expect(row.moreLabels).toBe(1)
    expect(row.updated).toBe('1h ago')
  })

  test('a merge conflict is a chip, but only once the host has finished computing it', () => {
    // WHY: a conflict blocks the merge and no group carries it, so the row must.
    // `mergeable: null` means GitHub is still working, and claiming a conflict
    // it has not found would send someone to rebase a clean branch.
    const conflicted = prRow({ ...pullRequest, mergeable: false }, context, NOW)
    expect(conflicted.chips).toContainEqual(expect.objectContaining({ label: 'Conflicts', tint: 'warning' }))
    expect(prRow({ ...pullRequest, mergeStateStatus: 'dirty' }, context, NOW).chips).toContainEqual(
      expect.objectContaining({ label: 'Conflicts', tint: 'warning' }),
    )
    expect(prRow({ ...pullRequest, mergeable: null }, context, NOW).chips.map((chip) => chip.label)).not.toContain(
      'Conflicts',
    )
    // A merged PR's stale mergeability is history, not a fact to act on.
    expect(
      prRow({ ...pullRequest, state: 'merged', mergeable: false }, context, NOW).chips.map((chip) => chip.label),
    ).not.toContain('Conflicts')
  })

  test('a long branch keeps its tail, because that is what tells two apart', () => {
    // WHY: generated refs share a prefix and differ in the suffix. Ellipsising
    // the end would make every row read the same.
    expect(shortBranch('solus/short-fix')).toBe('solus/short-fix')
    const short = shortBranch('solus/look-at-git-commits-in-userssidhusolus-f-7jgnb')
    expect(short.startsWith('solus/look-')).toBe(true)
    expect(short.endsWith('-f-7jgnb')).toBe(true)
  })

  test('a stale summary says nothing but still holds the slot', () => {
    // WHY: a summary for a previous head is not this PR's result — but the slot
    // has to keep its width, or the row shifts under the pointer the moment the
    // fresh result lands.
    expect(prRow(pullRequest, checksContext('passing', 'stale-sha'), NOW).checks).toEqual({
      state: 'none',
      label: '',
    })
    expect(prRow(pullRequest, context, NOW).checks).toEqual({ state: 'none', label: '' })
  })

  test('every known check state is stated in words', () => {
    // WHY: whether the checks pass is the first thing a reader wants from a
    // row, and a bare glyph was easy to miss. Running is worth saying too — it
    // tells the reader the silence is temporary rather than "no checks".
    expect(prRow(pullRequest, checksContext('passing'), NOW).checks).toEqual({
      state: 'passing',
      label: 'Checks passing',
    })
    expect(prRow(pullRequest, checksContext('pending'), NOW).checks).toEqual({
      state: 'pending',
      label: 'Checks running',
    })
    expect(prRow(pullRequest, checksContext('failing'), NOW).checks).toMatchObject({
      state: 'failing',
      label: 'Checks failing',
    })
  })

  test('passing and failing checks keep vivid semantic colours', () => {
    // WHY: mixing the small CI glyphs into the foreground makes green and red
    // look dark and ambiguous, especially in the compact list surfaces.
    const passing = checksChip({ state: 'passing', label: 'Checks passing' })
    const failing = checksChip({ state: 'failing', label: 'Checks failing' })

    expect(passing?.emphasis).toBe('strong')
    expect(failing?.emphasis).toBe('strong')
    expect(chipSkin(passing?.tint, passing?.emphasis).color).toBe('var(--success)')
    expect(chipSkin(failing?.tint, failing?.emphasis).color).toBe('var(--failure)')
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
  test('uses the GitHub author avatar on the row', () => {
    // WHY: the list represents the author GitHub already supplied an image
    // for, so it must not regress to generated initials.
    expect(prRow(pullRequest, context, NOW).people[0]).toMatchObject({
      id: 'octocat',
      avatarUrl: AUTHOR_AVATAR,
    })
  })

  test('across every project the row names its project, with the repository behind it', () => {
    // WHY: the every-project list mixes repositories; the project's own name is
    // how the reader knows where a row lives.
    const row = prRow(pullRequest, context, NOW, null, 'key', 'Solus')
    expect(row.project).toBe('Solus')
    expect(row.repo).toBe('acme/repo')
    expect(prRow(pullRequest, context, NOW).project).toBeNull()
  })

  test('draws requested reviewers with their GitHub avatar too', () => {
    // WHY: the list fetch already carries each requested reviewer's image, so
    // painting the author from GitHub and the reviewers beside them as hashed
    // initials made one row show two kinds of person.
    const reviewerAvatar = 'https://avatars.githubusercontent.com/u/2?v=4'
    const row = prRow(
      { ...pullRequest, requestedReviewers: [{ login: 'hubot', avatarUrl: reviewerAvatar }, { login: 'ghost' }] },
      context,
      NOW,
    )
    expect(row.people.slice(1)).toEqual([
      expect.objectContaining({ id: 'hubot', avatarUrl: reviewerAvatar }),
      expect.objectContaining({ id: 'ghost', avatarUrl: undefined }),
    ])
  })

  test('keeps mounted rows usable while a hot reload replaces string reviewers', () => {
    // WHY: a renderer hot reload can update this mapper before the mounted PR
    // store refetches its former string-only payload. That transition must not
    // crash the whole PR list.
    const stalePullRequest = pullRequestFixture(43)
    Reflect.set(stalePullRequest, 'requestedReviewers', ['hubot'])

    expect(prRow(stalePullRequest, context, NOW).people[1]).toMatchObject({
      id: 'hubot',
      initials: 'HU',
    })
  })
})
