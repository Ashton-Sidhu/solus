import { expect, test } from 'bun:test'
import type { PullRequest } from '@solus/contracts/providers'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import { linkedPullRequestRepository, threadPullRequestPage } from '@solus/server/execution/agents/tools/thread-pull-requests'

const repo = { host: 'github.com', owner: 'acme', repo: 'app' }
const repository = 'github.com/acme/app'
function link(number: number, state?: 'open' | 'merged'): SessionPullRequestLink {
  const url = `https://github.com/acme/app/pull/${number}`
  const title = `PR ${number}`
  return {
    sessionId: 'session', repository, number, url, title, source: 'agent', linkedAt: number,
    snapshot: state ? { number, url, title, state, draft: false, updatedAt: '2026-11-23', baseRepo: repo } : undefined,
  }
}

function metadata(headRef: string, baseRef: string, stack?: PullRequest['stack']) {
  return { headRef, baseRef, stack, isFork: false }
}

test('an explicit alternate repository needs a matching accessible link and PR number', () => {
  const linked = { ...link(10), repository: 'github.com/other/app', url: 'https://github.com/Other/App/pull/10' }
  expect(linkedPullRequestRepository([linked], repo, 'other/app', 10)).toEqual({ host: 'github.com', owner: 'Other', repo: 'App' })
  expect(linkedPullRequestRepository([linked], repo, 'other/app', 11)).toBeUndefined()
  expect(linkedPullRequestRepository([{ ...linked, url: 'https://github.com/acme/app/pull/10' }], repo, 'other/app', 10)).toBeUndefined()
})

test('thread discovery returns linked native and inferred chains including layers outside the page/filter', () => {
  const links = [link(1, 'merged'), link(51, 'open'), link(52, 'open'), link(53, 'open'), ...Array.from({ length: 49 }, (_, index) => link(index + 2))]
  const known = new Map([
    [`${repository}#1`, metadata('first', 'main', { number: 9, base: 'main', position: 1, size: 2 })],
    [`${repository}#51`, metadata('second', 'first', { number: 9, base: 'main', position: 2, size: 2 })],
    [`${repository}#52`, metadata('independent', 'main')],
    [`${repository}#53`, metadata('leaf', 'independent')],
  ])
  const first = threadPullRequestPage(links, known, {})
  expect(first.pullRequests).toHaveLength(50)
  expect(first.chains).toContainEqual({ kind: 'native', numbers: [1, 51] })
  const second = threadPullRequestPage(links, known, { cursor: first.nextCursor! })
  expect(second.pullRequests.map(pr => [pr.number, pr.stack])).toEqual([
    [51, { kind: 'native', position: 2, size: 2 }],
    [52, { kind: 'derived', position: 1, size: 2 }],
    [53, { kind: 'derived', position: 2, size: 2 }],
  ])
  expect(second.chains).toContainEqual({ kind: 'derived', numbers: [52, 53] })
  const filtered = threadPullRequestPage(links, known, { states: ['merged'] })
  expect(filtered.pullRequests.map(pr => pr.number)).toEqual([1])
  expect(filtered.chains).toEqual([{ kind: 'native', numbers: [1, 51] }])
})
