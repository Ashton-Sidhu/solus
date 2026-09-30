import { describe, expect, test } from 'bun:test'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import type { TaskPrSnapshot } from '@solus/contracts/task-types'
import {
  linkedPullRequestRows,
  pullRequestOpenTarget,
} from '@solus/workspace-ui/components/project-panel/lib/linked-pull-requests'

const REPOSITORY = 'github.com/acme/solus'

function snapshot(number: number, state: TaskPrSnapshot['state'], draft = false): TaskPrSnapshot {
  return {
    number, state, draft,
    url: `https://github.com/acme/solus/pull/${number}`,
    title: `Title ${number}`,
    updatedAt: '2026-09-30T00:00:00.000Z',
    baseRepo: { host: 'github.com', owner: 'acme', repo: 'solus' },
  }
}

function link(number: number, extra: Partial<SessionPullRequestLink> = {}): SessionPullRequestLink {
  return {
    sessionId: 's1',
    repository: REPOSITORY,
    number,
    url: `https://github.com/acme/solus/pull/${number}`,
    title: '',
    source: 'agent',
    linkedAt: number,
    ...extra,
  }
}

const noLive = () => null

describe('the Linked card rows', () => {
  // WHY: the card answers "what is still open from this session". A merged
  // pull request above an open one hides the work that still needs the user.
  test('open work comes first, and settled rows keep their order after it', () => {
    const rows = linkedPullRequestRows([
      link(3, { snapshot: snapshot(3, 'merged') }),
      link(2, { snapshot: snapshot(2, 'open') }),
      link(1, { snapshot: snapshot(1, 'closed') }),
    ], noLive)

    expect(rows.map((row) => [row.number, row.state, row.isSettled])).toEqual([
      [2, 'open', false],
      [3, 'merged', true],
      [1, 'closed', true],
    ])
  })

  test('a draft reads as draft, a missing one as missing, and one not yet synced has no state', () => {
    const rows = linkedPullRequestRows([
      link(1, { snapshot: snapshot(1, 'open', true) }),
      link(2, { missing: true }),
      link(3),
    ], noLive)

    expect(rows.map((row) => [row.number, row.state])).toEqual([[1, 'draft'], [3, ''], [2, 'missing']])
  })

  test('a live observation wins over the stored title and state', () => {
    const [row] = linkedPullRequestRows([link(4, { title: '#4' })], () => ({
      key: 'k', number: 4, targetScope: REPOSITORY, title: 'Live title', url: null,
      pullRequest: snapshot(4, 'merged'), missing: false,
    }))

    expect(row?.title).toBe('Live title')
    expect(row?.state).toBe('merged')
  })

  test('the tooltip says where the link came from', () => {
    const [branch, agent] = linkedPullRequestRows([
      link(1, { source: 'branch' }),
      link(2, { source: 'agent', createdBy: { kind: 'agent', agentId: 'claude-code' } as SessionPullRequestLink['createdBy'] }),
    ], noLive)

    expect(branch?.detailLabel).toContain("Found on the session's branch")
    expect(agent?.detailLabel).toContain('Linked by')
  })

  test('opening a link names its repository, so another repository\'s number is not opened', () => {
    expect(pullRequestOpenTarget(link(9)).expectedRepo).toEqual({ host: 'github.com', owner: 'acme', repo: 'solus' })
  })
})
