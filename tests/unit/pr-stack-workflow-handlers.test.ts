import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { pullRequestFixture } from './__fixtures__/pull-request'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import type { PrStackMergeRequest, PullRequest, RepoRef } from '@solus/contracts/providers'
import type { ResourceRole } from '@solus/contracts/permissions'
import type { Provider } from '@solus/server/providers/types'
import { SolusServer } from '@solus/server/transport/server'
import type { HostEventPublisher } from '@solus/server/transport/events/host-event-publisher'
import type { AgentDispatcher } from '@solus/server/execution/agents/agent-runner'
import type { PrSync } from '@solus/server/prs/pr-sync'

// The handlers reach the production database module, which imports node:sqlite
// (absent under Bun's test runtime).
mock.module('node:sqlite', () => ({ DatabaseSync }))

const repo: RepoRef = { host: 'github.com', owner: 'owner', repo: 'repo' }

/** What the code host says about each pull request on a fresh read. */
const hostFacts = new Map<number, PullRequest>()
function facts(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  const pullRequest = pullRequestFixture(number, { headSha: `sha-${number}`, baseRepo: repo, ...overrides })
  pullRequest.capabilities.actions.push('merge-stack', 'enable-stack-auto-merge', 'disable-stack-auto-merge', 'approve-workflows')
  pullRequest.viewerPermissions.actions.push('merge-stack', 'enable-stack-auto-merge', 'disable-stack-auto-merge', 'approve-workflows')
  return pullRequest
}

mock.module('@solus/server/prs/pr-index', () => ({
  repoKeyOf: (target: RepoRef) => `${target.host}/${target.owner}/${target.repo}`,
  prIndex: {
    pullRequest: (_repo: RepoRef, _provider: Provider, number: number) => {
      const read = async (): Promise<PullRequest> => {
        const found = hostFacts.get(number)
        if (!found) throw new Error(`no facts for #${number}`)
        return found
      }
      return { read, readFresh: read }
    },
    invalidate: () => {},
  },
}))
const gitHelpers = await import('@solus/server/git/git-helpers')
mock.module('@solus/server/git/git-helpers', () => ({
  ...gitHelpers,
  resolveRepoRef: async () => repo,
  resolvePrimaryRepoRef: async () => repo,
  resolveRepoRoot: async (cwd: string) => cwd,
  computeGitState: async () => null,
}))
const completed: number[] = []
mock.module('@solus/server/data/tasks/done-on-merge', () => ({
  completeTasksForMergedPullRequest: async (_scope: object, _target: string, number: number) => { completed.push(number); return [] },
}))

const calls: string[] = []
/** What the code host does when it merges a stack: the layers it lands become merged. */
let landedLayers: number[] = []
const provider = {
  review: {
    mergePullRequestStack: async (_repo: RepoRef, request: PrStackMergeRequest & { auto?: boolean }) => {
      if (request.auto) {
        calls.push(`arm-stack:${request.number}`)
        return { status: 'auto-merge-enabled', layers: [65, 66], armed: { autoMergeEnabled: true } }
      }
      calls.push(`merge-stack:${request.number}`)
      for (const number of landedLayers) hostFacts.set(number, facts(number, { state: 'merged' }))
      return { status: 'merged', layers: landedLayers }
    },
    disablePullRequestAutoMerge: async (_repo: RepoRef, number: number, stackNumber?: number) => {
      calls.push(`cancel-stack:${stackNumber}:${number}`)
      return facts(number, { autoMergeEnabled: false })
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

const applied: number[] = []

function server(role: ResourceRole = 'owner'): SolusServer {
  const solus = new SolusServer()
  registerProviderHandlers(solus, {
    checkouts: {} as never,
    isWorktreeInUse: () => false,
    isSessionBusy: () => false,
    dispatcher: {} as AgentDispatcher,
    events: { broadcast: () => 1, publish: () => 1 } as unknown as HostEventPublisher,
    prSync: { apply: async (_target: object, pullRequest: PullRequest) => { applied.push(pullRequest.number) } } as unknown as PrSync,

    resources: { standingFor: async () => ({ role }) },
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
  repo,
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

    const result = await server().handle('prMergeStack', [stackRequest], TEST_HANDLER_CTX)

    expect(result.status).toBe('merged')
    // The answer is each layer as the host reads it after the merge.
    expect(result.pullRequests.map((pullRequest) => [pullRequest.number, pullRequest.state])).toEqual([[65, 'merged'], [66, 'merged']])
    expect(applied).toEqual([65, 66])
    expect(completed).toEqual([65, 66])
  })

  test('arm and cancel publish the target without completing the task', async () => {
    hostFacts.set(66, facts(66))
    const solus = server()
    const result = await solus.handle('prEnableStackAutoMerge', [stackRequest], TEST_HANDLER_CTX)
    expect(result.status).toBe('auto-merge-enabled')
    expect(result.pullRequests.map(({ number, autoMergeEnabled }) => [number, autoMergeEnabled])).toEqual([[66, true]])
    hostFacts.set(66, facts(66, { autoMergeEnabled: true }))
    const cancelled = await solus.handle('prDisableStackAutoMerge', [stackRequest, 4], TEST_HANDLER_CTX)
    expect(cancelled.autoMergeEnabled).toBe(false)
    expect(calls).toEqual(['arm-stack:66', 'cancel-stack:4:66'])
    expect(applied).toEqual([66, 66])
    expect(completed).toEqual([])
  })

  test('cannot schedule a lower layer linked to a session the caller cannot edit', async () => {
    const { linkSessionPullRequest, unlinkSessionPullRequest } = await import('@solus/server/data/sessions/session-pull-requests')
    hostFacts.set(66, facts(66))
    await linkSessionPullRequest('lower-layer', {
      url: 'https://github.com/owner/repo/pull/65', source: 'manual', by: { kind: 'system' },
    })
    try {
      await expect(server('viewer').handle('prEnableStackAutoMerge', [stackRequest], TEST_HANDLER_CTX))
        .rejects.toThrow('This pull request is part of a session you cannot change.')
      expect(calls).toEqual([])
    } finally {
      await unlinkSessionPullRequest('lower-layer', 'github.com/owner/repo', 65)
    }
  })

  test('a viewer with only immediate stack merge cannot arm or cancel', async () => {
    const pr = facts(66, { autoMergeEnabled: true })
    pr.viewerPermissions.actions = ['merge-stack']
    hostFacts.set(66, pr)
    const solus = server()
    await expect(solus.handle('prEnableStackAutoMerge', [stackRequest], TEST_HANDLER_CTX)).rejects.toThrow('permission')
    await expect(solus.handle('prDisableStackAutoMerge', [stackRequest, 4], TEST_HANDLER_CTX)).rejects.toThrow('permission')
    expect(calls).toEqual([])
  })

  test('a viewer without the permission never reaches the code host', async () => {
    const readOnly = facts(66)
    readOnly.viewerPermissions.actions = readOnly.viewerPermissions.actions.filter((action) => action !== 'merge-stack')
    hostFacts.set(66, readOnly)

    await expect(server().handle('prMergeStack', [stackRequest], TEST_HANDLER_CTX))
      .rejects.toThrow('You do not have permission to merge this stack.')
    expect(calls).toEqual([])
  })

  test('a host without stacks says so instead of failing at the code host', async () => {
    // WHY: a code host that has no stacks reports it through its capabilities;
    // the request must stop here with a plain answer.
    const noStacks = facts(66)
    noStacks.capabilities.actions = noStacks.capabilities.actions.filter((action) => action !== 'merge-stack')
    hostFacts.set(66, noStacks)

    await expect(server().handle('prMergeStack', [stackRequest], TEST_HANDLER_CTX))
      .rejects.toThrow('This code host cannot merge a stack.')
    expect(calls).toEqual([])
  })
})

describe('approving workflow runs', () => {
  const fork = { owner: 'newcomer', repo: 'repo', isFork: true }

  test('lists runs only for open pull requests on hosts that support approval', async () => {
    hostFacts.set(12, facts(12, { headRepo: fork }))
    hostFacts.set(13, facts(13))
    hostFacts.set(14, facts(14, { state: 'closed' }))
    const solus = server()

    expect(await solus.handle('prPendingWorkflowRuns', [{ repo: repo, number: 12 }], TEST_HANDLER_CTX))
      .toEqual({ headSha: 'sha-12', runs: [{ id: 1, name: 'CI', url: null }] })
    expect(await solus.handle('prPendingWorkflowRuns', [{ repo: repo, number: 13 }], TEST_HANDLER_CTX))
      .toEqual({ headSha: 'sha-13', runs: [{ id: 1, name: 'CI', url: null }] })
    expect(await solus.handle('prPendingWorkflowRuns', [{ repo, number: 14 }], TEST_HANDLER_CTX))
      .toEqual({ headSha: 'sha-14', runs: [] })
    expect(calls).toEqual(['list-runs', 'list-runs'])
  })

  test('refuses when the head moved after the viewer looked', async () => {
    // A push after the viewer read the change must not use their approval.
    hostFacts.set(12, facts(12, { headRepo: fork, headSha: 'pushed-later' }))

    await expect(server().handle('prApproveWorkflowRuns', [{ repo: repo, number: 12 }, 'sha-12'], TEST_HANDLER_CTX))
      .rejects.toThrow('This pull request changed. Refresh it before you approve its workflow runs.')
    expect(calls).toEqual([])
  })

  test('refuses a viewer without repository approval permission', async () => {
    const current = facts(12)
    current.viewerPermissions.actions = current.viewerPermissions.actions.filter((action) => action !== 'approve-workflows')
    hostFacts.set(12, current)

    await expect(server().handle('prApproveWorkflowRuns', [{ repo, number: 12 }, 'sha-12'], TEST_HANDLER_CTX))
      .rejects.toThrow('You do not have permission to approve workflow runs in this repository.')
    expect(calls).toEqual([])
  })

  test.each([fork, { owner: repo.owner, repo: repo.repo, isFork: false }])('approves for the head the viewer saw (%j)', async (headRepo) => {
    hostFacts.set(12, facts(12, { headRepo }))

    expect(await server().handle('prApproveWorkflowRuns', [{ repo: repo, number: 12 }, 'sha-12'], TEST_HANDLER_CTX)).toEqual({ approved: 1 })
    expect(calls).toEqual(['approve-runs'])
  })
})

describe('marking files viewed', () => {
  test('refuses a change with no path, and sends nothing for no change', async () => {
    const solus = server()
    await expect(solus.handle('prSetFilesViewed', [{ repo: repo, number: 7 }, [{ path: '', viewed: true }]], TEST_HANDLER_CTX))
      .rejects.toThrow('A file path is required.')
    await solus.handle('prSetFilesViewed', [{ repo: repo, number: 7 }, []], TEST_HANDLER_CTX)
    expect(calls).toEqual([])
  })
})
