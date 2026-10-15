import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { pullRequestFixture } from './__fixtures__/pull-request'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import type { PrStackMergeRequest, PullRequest, RepoRef } from '@solus/contracts/providers'
import type { IpcContext } from '@solus/contracts/types'
import type { Provider } from '@solus/server/providers/types'
import { SolusServer } from '@solus/server/transport/server'
import type { HostEventPublisher } from '@solus/server/transport/events/host-event-publisher'
import type { AgentDispatcher } from '@solus/server/execution/agents/agent-runner'
import type { PrSync } from '@solus/server/prs/pr-sync'

// The handlers reach the production database module, which imports node:sqlite
// (absent under Bun's test runtime).
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const repo: RepoRef = { host: 'github.com', owner: 'owner', repo: 'repo' }

/** What the code host says about each pull request on a fresh read. */
const hostFacts = new Map<number, PullRequest>()
function facts(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  const pullRequest = pullRequestFixture(number, { headSha: `sha-${number}`, baseRepo: repo, ...overrides })
  pullRequest.capabilities.actions.push('merge-stack', 'approve-workflows')
  pullRequest.viewerPermissions.actions.push('merge-stack', 'approve-workflows')
  return pullRequest
}

mock.module('@solus/server/prs/pr-index', () => ({
  repoKeyOf: (target: RepoRef) => `${target.host}/${target.owner}/${target.repo}`,
  prIndex: {
    pullRequest: (_repo: RepoRef, _provider: Provider, number: number) => ({
      readFresh: async () => {
        const found = hostFacts.get(number)
        if (!found) throw new Error(`no facts for #${number}`)
        return found
      },
    }),
    invalidate: () => {},
  },
}))
mock.module('@solus/server/git/git-helpers', () => ({
  resolveRepoRef: async () => repo,
  resolvePrimaryRepoRef: async () => repo,
  resolveRepoRoot: async (cwd: string) => cwd,
  computeGitState: async () => null,
}))
const completed: number[] = []
mock.module('@solus/server/data/tasks/sync-engine', () => ({
  completeTasksForMergedPullRequest: async (_scope: object, _target: string, number: number) => { completed.push(number); return [] },
}))

const calls: string[] = []
/** What the code host does when it merges a stack: the layers it lands become merged. */
let landedLayers: number[] = []
const provider = {
  review: {
    mergePullRequestStack: async (_repo: RepoRef, request: PrStackMergeRequest) => {
      calls.push(`merge-stack:${request.number}`)
      for (const number of landedLayers) hostFacts.set(number, facts(number, { state: 'merged' }))
      return { status: 'merged', layers: landedLayers }
    },
    listPendingWorkflowRuns: async () => { calls.push('list-runs'); return [{ id: 1, name: 'CI', url: null }] },
    approvePendingWorkflowRuns: async () => { calls.push('approve-runs'); return 1 },
    setFilesViewed: async () => { calls.push('set-viewed') },
  },
} as unknown as Provider
mock.module('@solus/server/providers/registry', () => ({
  providerForRepo: () => provider,
  getProvider: () => provider,
}))

const { registerProviderHandlers } = await import('@solus/server/transport/handlers/provider-handlers')

const ctx = { session: { projectPath: '/repo', workingDirectory: '/repo' } } as IpcContext
const applied: number[] = []

function server(): SolusServer {
  const solus = new SolusServer()
  registerProviderHandlers(solus, {
    checkouts: {} as never,
    isWorktreeInUse: () => false,
    isSessionBusy: () => false,
    dispatcher: {} as AgentDispatcher,
    events: { broadcast: () => 1, publish: () => 1 } as unknown as HostEventPublisher,
    prSync: { apply: async (_target: object, pullRequest: PullRequest) => { applied.push(pullRequest.number) } } as unknown as PrSync,

    resources: { roleFor: async () => 'owner' },
  })
  return solus
}

beforeEach(() => {
  hostFacts.clear()
  calls.length = 0
  applied.length = 0
  completed.length = 0
})

const stackRequest: PrStackMergeRequest = {
  number: 66,
  stackNumber: 4,
  method: 'squash',
  expectedHeads: [{ number: 65, headSha: 'sha-65' }, { number: 66, headSha: 'sha-66' }],
}

describe('merging a stack through the host', () => {
  test('every merged layer reaches PR sync and finishes its tasks', async () => {
    hostFacts.set(65, facts(65))
    hostFacts.set(66, facts(66))
    landedLayers = [65, 66]

    const result = await server().handle('prMergeStack', [ctx, stackRequest], TEST_HANDLER_CTX)

    expect(result.status).toBe('merged')
    // The answer is each layer as the host reads it after the merge.
    expect(result.pullRequests.map((pullRequest) => [pullRequest.number, pullRequest.state])).toEqual([[65, 'merged'], [66, 'merged']])
    expect(applied).toEqual([65, 66])
    expect(completed).toEqual([65, 66])
  })

  test('a viewer without the permission never reaches the code host', async () => {
    const readOnly = facts(66)
    readOnly.viewerPermissions.actions = readOnly.viewerPermissions.actions.filter((action) => action !== 'merge-stack')
    hostFacts.set(66, readOnly)

    await expect(server().handle('prMergeStack', [ctx, stackRequest], TEST_HANDLER_CTX))
      .rejects.toThrow('You do not have permission to merge this stack.')
    expect(calls).toEqual([])
  })

  test('a host without stacks says so instead of failing at the code host', async () => {
    // WHY: a code host that has no stacks reports it through its capabilities;
    // the request must stop here with a plain answer.
    const noStacks = facts(66)
    noStacks.capabilities.actions = noStacks.capabilities.actions.filter((action) => action !== 'merge-stack')
    hostFacts.set(66, noStacks)

    await expect(server().handle('prMergeStack', [ctx, stackRequest], TEST_HANDLER_CTX))
      .rejects.toThrow('This code host cannot merge a stack.')
    expect(calls).toEqual([])
  })
})

describe('approving the workflow runs of a fork', () => {
  const fork = { owner: 'newcomer', repo: 'repo', isFork: true }

  test('lists runs only for an open fork pull request', async () => {
    hostFacts.set(12, facts(12, { headRepo: fork }))
    hostFacts.set(13, facts(13))
    const solus = server()

    expect(await solus.handle('prPendingWorkflowRuns', [ctx, 12], TEST_HANDLER_CTX))
      .toEqual({ headSha: 'sha-12', runs: [{ id: 1, name: 'CI', url: null }] })
    expect(await solus.handle('prPendingWorkflowRuns', [ctx, 13], TEST_HANDLER_CTX))
      .toEqual({ headSha: 'sha-13', runs: [] })
    expect(calls).toEqual(['list-runs'])
  })

  test('refuses when the head moved after the viewer looked', async () => {
    // WHY: an approval runs the fork's code with the repository's secrets. A
    // push after the viewer read the change must not ride on their approval.
    hostFacts.set(12, facts(12, { headRepo: fork, headSha: 'pushed-later' }))

    await expect(server().handle('prApproveWorkflowRuns', [ctx, 12, 'sha-12'], TEST_HANDLER_CTX))
      .rejects.toThrow('This pull request changed. Refresh it before you approve its workflow runs.')
    expect(calls).toEqual([])
  })

  test('approves for the head the viewer saw', async () => {
    hostFacts.set(12, facts(12, { headRepo: fork }))

    expect(await server().handle('prApproveWorkflowRuns', [ctx, 12, 'sha-12'], TEST_HANDLER_CTX)).toEqual({ approved: 1 })
    expect(calls).toEqual(['approve-runs'])
  })
})

describe('marking files viewed', () => {
  test('refuses a change with no path, and sends nothing for no change', async () => {
    const solus = server()
    await expect(solus.handle('prSetFilesViewed', [ctx, 7, [{ path: '', viewed: true }]], TEST_HANDLER_CTX))
      .rejects.toThrow('A file path is required.')
    await solus.handle('prSetFilesViewed', [ctx, 7, []], TEST_HANDLER_CTX)
    expect(calls).toEqual([])
  })
})
