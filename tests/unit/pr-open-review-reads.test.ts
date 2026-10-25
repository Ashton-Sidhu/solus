import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { pullRequestFixture } from './__fixtures__/pull-request'
import type { PullRequest, RepoRef } from '@solus/contracts/providers'
import type { IpcContext } from '@solus/contracts/types'
import type { Provider } from '@solus/server/providers/types'

/**
 * Opening a pull request is a read, and the click waits on it. It takes what
 * the host remembers. The revision guards stay fresh: a checkout of a pull
 * request that moved since the reviewer opened it is still refused.
 */

// The handlers reach the production database module, which imports node:sqlite
// (absent under Bun's test runtime).
mock.module('node:sqlite', () => ({ DatabaseSync }))

const repo: RepoRef = { host: 'github.com', owner: 'owner', repo: 'repo' }

/** What this server read earlier, and what the code host says now. */
let remembered: PullRequest
let onHost: PullRequest
const reads: string[] = []

mock.module('@solus/server/prs/pr-index', () => ({
  repoKeyOf: (target: RepoRef) => `${target.host}/${target.owner}/${target.repo}`,
  prIndex: {
    pullRequest: () => ({
      lastRead: () => remembered,
      read: async () => { reads.push('remembered'); return remembered },
      readFresh: async () => { reads.push('host'); return onHost },
    }),
    invalidate: () => {},
  },
}))
const provider = {
  review: {
    getPullRequestDiffBase: async (_repo: RepoRef, pullRequest: PullRequest) => `base-of-${pullRequest.headSha}`,
  },
} as unknown as Provider
mock.module('@solus/server/providers/registry', () => ({
  providerForRepo: () => provider,
  getProvider: () => provider,
}))

const { openPrReview, preparePrCheckout } = await import('@solus/server/transport/handlers/provider-handlers')

// A project named by its repository, so no git runs.
const ctx = { session: { projectPath: 'github.com/owner/repo', workingDirectory: 'github.com/owner/repo' } } as IpcContext

beforeEach(() => {
  remembered = pullRequestFixture(7, { headSha: 'sha-old', baseRepo: repo })
  onHost = pullRequestFixture(7, { headSha: 'sha-old', baseRepo: repo })
  reads.length = 0
})

describe('opening a pull request for review', () => {
  test('answers from what the host remembers, without asking the code host', async () => {
    const target = await openPrReview(ctx, 7)

    expect(reads).toEqual(['remembered'])
    expect(target.headSha).toBe('sha-old')
    expect(target.baseSha).toBe('base-of-sha-old')
  })

  test('a checkout of a pull request pushed since the open is still refused', async () => {
    const target = await openPrReview(ctx, 7)
    onHost = pullRequestFixture(7, { headSha: 'sha-new', baseRepo: repo })
    const checkouts = { preparePullRequest: async () => { throw new Error('must not check out') } }

    await expect(preparePrCheckout(ctx, target, checkouts as never)).rejects.toThrow('This pull request changed')
    expect(reads).toEqual(['remembered', 'host'])
  })
})
