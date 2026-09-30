import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { pullRequestFixture } from './__fixtures__/pull-request'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import { Database } from 'bun:sqlite'
import type { PullRequest as PullRequestFacts } from '@solus/contracts/providers'
import type { IpcContext } from '@solus/contracts/types'
import type { Provider, RepoRef } from '@solus/server/providers/types'
import { SolusServer } from '@solus/server/transport/server'
import type { HostEventPublisher } from '@solus/server/transport/events/host-event-publisher'
import type { AgentDispatcher } from '@solus/server/execution/agents/agent-runner'
import type { PrSync } from '@solus/server/prs/pr-sync'

// The handlers reach the production database module, which imports node:sqlite
// (absent under Bun's test runtime).
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const repo: RepoRef = { host: 'github.com', owner: 'owner', repo: 'repo' }
const HEAD_SHA = 'sha-1'

function facts(state: PullRequestFacts['state']): PullRequestFacts {
  return pullRequestFixture(7, {
    state, headSha: HEAD_SHA, headRef: 'feature', baseRepo: repo,
    url: 'https://github.com/owner/repo/pull/7',
  })
}

let mergedFacts = facts('merged')
mock.module('@solus/server/prs/pr-index', () => ({
  repoKeyOf: (target: RepoRef) => `${target.host}/${target.owner}/${target.repo}`,
  prIndex: {
    pullRequest: () => ({ readFresh: async () => mergedFacts }),
    invalidate: () => {},
  },
}))
mock.module('@solus/server/git/git-helpers', () => ({
  resolveRepoRef: async () => repo,
  resolveRepoRoot: async (cwd: string) => cwd,
  computeGitState: async () => null,
}))
const completedScopes: string[] = []
beforeEach(() => { completedScopes.length = 0 })
mock.module('@solus/server/data/tasks/sync-engine', () => ({
  // The host owner reads the whole disk (organization-scope §3): the scope is `ANY_ORGANIZATION`, not a string.
  completeTasksForMergedPullRequest: async (scope: string | { kind: string }, targetScope: string) => { completedScopes.push(`${typeof scope === 'string' ? scope : scope.kind}:${targetScope}`); return [] },
}))

let mergeAnswer = { merged: true }
const provider = {
  review: { mergePullRequest: async () => mergeAnswer },
} as unknown as Provider
mock.module('@solus/server/providers/registry', () => ({
  providerForRepo: () => provider,
  getProvider: () => provider,
}))

const { registerProviderHandlers, reviewTargetFor } = await import('@solus/server/transport/handlers/provider-handlers')

const ctx = { session: { projectPath: '/repo', workingDirectory: '/repo' } } as IpcContext

function serverWithEvents(): { server: SolusServer; broadcasts: { type: string; payload: unknown }[] } {
  const broadcasts: { type: string; payload: unknown }[] = []
  const events = {
    broadcast: (type: string, payload: unknown) => {
      broadcasts.push({ type, payload })
      return 1
    },
    publish: () => 1,
  } as unknown as HostEventPublisher
  const server = new SolusServer()
  const applied: PullRequestFacts[] = []
  const prSync = { apply: async (_host: unknown, pullRequest: PullRequestFacts) => { applied.push(pullRequest) } } as unknown as PrSync
  registerProviderHandlers(server, {
    isWorktreeInUse: () => false,
    isSessionBusy: () => false,
    dispatcher: {} as AgentDispatcher,
    events,
    prSync,
  })
  return { server, broadcasts, applied }
}

describe('merging a pull request', () => {
  test('a linked repository scope bypasses the active checkout remote', async () => {
    const target = await reviewTargetFor({
      session: { projectPath: 'github.com/another/project', workingDirectory: '/repo' },
    } as IpcContext)
    expect(target.repo).toEqual({ host: 'github.com', owner: 'another', repo: 'project' })
    expect((await reviewTargetFor(ctx)).repo).toEqual(repo)
  })

  test('hands the merged pull request to PR sync, so every surface stops drawing it open', async () => {
    mergedFacts = facts('merged')
    mergeAnswer = { merged: true }
    const { server, applied } = serverWithEvents()

    await server.handle('prMerge', [ctx, 7, 'squash', HEAD_SHA], TEST_HANDLER_CTX)

    expect(completedScopes).toEqual(['any-organization:github.com/owner/repo'])
    expect(applied).toEqual([mergedFacts])
  })

  test('says nothing when the code host refused the merge', async () => {
    mergedFacts = facts('open')
    mergeAnswer = { merged: false }
    const { server, broadcasts, applied } = serverWithEvents()

    await server.handle('prMerge', [ctx, 7, 'squash', HEAD_SHA], TEST_HANDLER_CTX)

    expect(broadcasts).toEqual([])
    expect(applied).toEqual([])
    expect(completedScopes).toEqual([])
  })
})
