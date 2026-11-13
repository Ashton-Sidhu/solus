import { expect, test } from 'bun:test'
import type { PullRequest } from '@solus/contracts/providers'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import {
  cardPullRequests,
  checksReads,
  prReference,
} from '@solus/workspace-ui/components/project-panel/lib/card-pull-requests'
import { pullRequestFixture } from './__fixtures__/pull-request'

const projectCtx = { session: { sessionId: 's', projectPath: '/code/repo', workingDirectory: '/code/repo' } } as IpcContext

function link(repository: string, number: number): SessionPullRequestLink {
  return {
    sessionId: 's',
    repository,
    number,
    url: `https://${repository}/pull/${number}`,
    title: `PR ${number}`,
    source: 'agent',
    linkedAt: 0,
  }
}

/** The store as the card reads it: pull requests filed by the scope that read them. */
function store(records: Record<string, PullRequest[]>) {
  return (ctx: IpcContext, number: number) =>
    records[projectScopeOf(ctx.session) ?? '']?.find((pr) => pr.number === number) ?? null
}

const site = { host: 'github.com', owner: 'acme', repo: 'site' }

test('a session link in another repository is on the card, read through that repository and named by it', () => {
  const branchPr = pullRequestFixture(412)
  const cards = cardPullRequests({
    branchPr,
    links: [link('github.com/acme/repo', 398), link('github.com/acme/site', 52)],
    projectRepository: 'github.com/acme/repo',
    primaryRemoteUrl: null,
    projectCtx,
    prIn: store({
      '/code/repo': [pullRequestFixture(398)],
      'github.com/acme/site': [pullRequestFixture(52, { baseRepo: site })],
    }),
  })

  expect(cards.map((card) => card.key)).toEqual([
    'github.com/acme/repo#412',
    'github.com/acme/repo#398',
    'github.com/acme/site#52',
  ])
  const other = cards[2]!
  expect(projectScopeOf(other.ctx.session)).toBe('github.com/acme/site')
  expect(other.ctx.session.gitContext).toBeNull()
  expect(other.otherRepository).toBe('acme/site')
  expect(prReference(other.pr.number, other.otherRepository)).toBe('site#52')
  // This checkout's own pull requests keep the checkout, where agent handoffs run.
  expect(cards[1]!.ctx).toBe(projectCtx)
  expect(cards[1]!.otherRepository).toBeNull()
})

test('the same number in two repositories is two pull requests', () => {
  const cards = cardPullRequests({
    branchPr: pullRequestFixture(52),
    links: [link('github.com/acme/repo', 52), link('github.com/acme/site', 52)],
    projectRepository: 'github.com/acme/repo',
    primaryRemoteUrl: null,
    projectCtx,
    prIn: store({ 'github.com/acme/site': [pullRequestFixture(52, { baseRepo: site })] }),
  })

  expect(cards.map((card) => card.key)).toEqual(['github.com/acme/repo#52', 'github.com/acme/site#52'])
})

test('before the project reads a pull request, the checkout remote decides which links are its own', () => {
  const cards = cardPullRequests({
    branchPr: null,
    links: [link('github.com/acme/repo', 398)],
    projectRepository: null,
    primaryRemoteUrl: 'git@github.com:Acme/Repo.git',
    projectCtx,
    prIn: store({ '/code/repo': [pullRequestFixture(398)] }),
  })

  expect(cards).toHaveLength(1)
  expect(cards[0]!.ctx).toBe(projectCtx)
  expect(cards[0]!.otherRepository).toBeNull()
})

test('a linked pull request that is no longer open leaves the card', () => {
  const cards = cardPullRequests({
    branchPr: null,
    links: [link('github.com/acme/site', 7), link('github.com/acme/site', 8)],
    projectRepository: 'github.com/acme/repo',
    primaryRemoteUrl: null,
    projectCtx,
    prIn: store({
      'github.com/acme/site': [
        pullRequestFixture(7, { baseRepo: site, state: 'merged' }),
        pullRequestFixture(8, { baseRepo: site, state: 'closed' }),
      ],
    }),
  })

  expect(cards).toEqual([])
})

test('checks are read once for each repository the card shows', () => {
  const cards = cardPullRequests({
    branchPr: pullRequestFixture(412),
    links: [link('github.com/acme/repo', 398), link('github.com/acme/site', 52), link('github.com/acme/site', 53)],
    projectRepository: 'github.com/acme/repo',
    primaryRemoteUrl: null,
    projectCtx,
    prIn: store({
      '/code/repo': [pullRequestFixture(398)],
      'github.com/acme/site': [pullRequestFixture(52, { baseRepo: site }), pullRequestFixture(53, { baseRepo: site })],
    }),
  })

  expect(checksReads(cards).map(({ ctx, numbers }) => [projectScopeOf(ctx.session), numbers])).toEqual([
    ['/code/repo', [412, 398]],
    ['github.com/acme/site', [52, 53]],
  ])
})
