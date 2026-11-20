import { describe, expect, test } from 'bun:test'
import type { PullRequest } from '@solus/contracts/providers'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import type { TaskPrSnapshot } from '@solus/contracts/task-types'
import { pullRequestCard, pullRequestGroupSummary } from '@solus/client-core/pull-request-card'
import { pullRequestCardMeta } from '../../packages/workspace-ui/src/components/conversation/lib/pull-request-card'

const baseRepo = { host: 'github.com', owner: 'modem-dev', repo: 'hunk' }

function snapshot(state: TaskPrSnapshot['state'], updatedAt = '2026-11-13T10:00:00Z', draft = false): TaskPrSnapshot {
  return { number: 1285, url: '', title: '', state, draft, updatedAt, baseRepo }
}

function link(extra: Partial<SessionPullRequestLink> = {}): SessionPullRequestLink {
  return {
    sessionId: 's',
    repository: 'github.com/modem-dev/hunk',
    number: 1285,
    url: 'https://github.com/modem-dev/hunk/pull/1285',
    title: 'From the link',
    source: 'agent',
    linkedAt: 1,
    ...extra,
  }
}

function read(extra: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1285,
    title: 'feat(review): run a review session headless',
    state: 'open',
    draft: false,
    author: 'benvinegar',
    createdAt: '2026-11-13T09:56:00Z',
    updatedAt: '2026-11-13T10:00:00Z',
    additions: 2682,
    deletions: 1509,
    changedFiles: 31,
    ...extra,
  } as PullRequest
}

describe('a pull request card', () => {
  test('a full read gives the author, the age, and the size', () => {
    // WHY: the card answers "what is this and how big" without opening the pull request.
    expect(pullRequestCard(link({ snapshot: snapshot('open') }), read())).toEqual({
      state: 'open',
      stateLabel: 'Open',
      reference: 'modem-dev/hunk #1285',
      title: 'feat(review): run a review session headless',
      author: 'benvinegar',
      openedAt: Date.parse('2026-11-13T09:56:00Z'),
      fileCount: 31,
      filesLabel: '31 files',
      additionsLabel: '+2,682',
      deletionsLabel: '−1,509',
      watch: 'available',
    })
  })

  test('without a full read the card shows only what the link knows', () => {
    // WHY: a client that has not read the pull request must not claim a size or an author.
    const card = pullRequestCard(link({ snapshot: snapshot('open', undefined, true) }), null)
    expect(card).toMatchObject({ state: 'draft', title: 'From the link', author: null, filesLabel: null, additionsLabel: null, openedAt: null })
    expect(pullRequestCard(link(), null)).toMatchObject({ state: null, stateLabel: null, title: 'From the link', watch: 'available' })
  })

  test('a newer snapshot wins over a stale read for the state', () => {
    // WHY: PR sync saw the merge after the client read the pull request; the badge must not say Open.
    const card = pullRequestCard(link({ snapshot: snapshot('merged', '2026-11-13T11:00:00Z') }), read())
    expect(card.state).toBe('merged')
    expect(card.watch).toBe('unavailable')
  })

  test('the watch is offered only while a watch can start', () => {
    // WHY: the host refuses a watch on a merged, closed, or missing pull request,
    // so the card does not offer one; a running watch shows as watching.
    expect(pullRequestCard(link({ snapshot: snapshot('closed') }), null).watch).toBe('unavailable')
    expect(pullRequestCard(link({ missing: true }), read()).watch).toBe('unavailable')
    expect(pullRequestCard(link({ snapshot: snapshot('open'), watch: { startedAt: 5 } }), read()).watch).toBe('watching')
  })

  test('a file count the host has not computed is left out, and one file is singular', () => {
    expect(pullRequestCard(link(), read({ changedFiles: null })).filesLabel).toBeNull()
    expect(pullRequestCard(link(), read({ changedFiles: 1 })).filesLabel).toBe('1 file')
  })
})

describe('the card line under the title', () => {
  test('names the pull request, then the author and age once a full read gave them', () => {
    const now = Date.parse('2026-11-13T10:00:00Z')
    expect(pullRequestCardMeta(pullRequestCard(link(), read()), now)).toBe('modem-dev/hunk #1285 · benvinegar · 4m ago')
    // WHY: before a read, the line must not show an empty author or a made-up age.
    expect(pullRequestCardMeta(pullRequestCard(link(), null), now)).toBe('modem-dev/hunk #1285')
  })
})

describe('the line of a group card', () => {
  test('counts the pull requests and their states in the order of a pull request life', () => {
    // WHY: the folded line is all a reader sees of the group, so it must say
    // what needs a look (open work) before what is finished.
    const cards = [
      pullRequestCard(link({ number: 1, snapshot: snapshot('merged') }), null),
      pullRequestCard(link({ number: 2 }), read()),
      pullRequestCard(link({ number: 3, snapshot: snapshot('open', undefined, true) }), null),
    ]
    expect(pullRequestGroupSummary(cards)).toMatchObject({ title: '3 pull requests', status: '1 open · 1 draft · 1 merged' })
  })

  test('totals the files only when the host counted every pull request', () => {
    // WHY: a total that leaves one pull request out is a smaller number that looks right.
    expect(pullRequestGroupSummary([pullRequestCard(link(), read()), pullRequestCard(link(), read({ changedFiles: 1 }))]).filesLabel).toBe('32 files')
    expect(pullRequestGroupSummary([pullRequestCard(link(), read()), pullRequestCard(link(), null)]).filesLabel).toBeNull()
  })

  test('states nothing it does not know yet', () => {
    expect(pullRequestGroupSummary([pullRequestCard(link(), null), pullRequestCard(link(), null)]).status).toBe('')
  })
})
