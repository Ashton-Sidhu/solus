import { describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { PullRequest as PullRequestFacts } from '@solus/contracts/providers'
import type { IpcContext } from '@solus/contracts/types'
import type { Provider, RepoRef } from '@solus/server/providers/types'
import { SolusServer } from '@solus/server/server/server'
import type { HostEventPublisher } from '@solus/server/events/host-event-publisher'
import type { AgentDispatcher } from '@solus/server/agents/agent-runner'

// The handlers reach the production database module, which imports node:sqlite
// (absent under Bun's test runtime).
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const repo: RepoRef = { host: 'github.com', owner: 'owner', repo: 'repo' }
const HEAD_SHA = 'sha-1'

function facts(state: PullRequestFacts['state']): PullRequestFacts {
  // SAFETY: the merge handler reads only these fields; the rest of the record
  // never leaves the mocked provider.
  return {
    number: 7,
    state,
    headSha: HEAD_SHA,
    headRef: 'feature',
    viewerPermissions: { actions: ['merge'] },
    capabilities: { mergeMethods: ['squash'] },
  } as unknown as PullRequestFacts
}

let mergedFacts = facts('merged')
mock.module('@solus/server/prs/pr-index', () => ({
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
mock.module('@solus/server/tasks/sync-engine', () => ({
  completeTasksForMergedPullRequest: async () => [],
}))

let mergeAnswer = { merged: true }
const provider = {
  review: { mergePullRequest: async () => mergeAnswer },
} as unknown as Provider
mock.module('@solus/server/providers/registry', () => ({
  providerForRepo: () => provider,
  getProvider: () => provider,
}))

const { registerProviderHandlers } = await import('@solus/server/server/handlers/provider-handlers')

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
  registerProviderHandlers(server, {
    isWorktreeInUse: () => false,
    dispatcher: {} as AgentDispatcher,
    events,
  })
  return { server, broadcasts }
}

describe('merging a pull request', () => {
  test('announces the lifecycle change, so every surface stops drawing it open', async () => {
    mergedFacts = facts('merged')
    mergeAnswer = { merged: true }
    const { server, broadcasts } = serverWithEvents()

    await server.handle('prMerge', [ctx, 7, 'squash', HEAD_SHA])

    expect(broadcasts).toEqual([
      { type: 'pr.lifecycleChanged', payload: { projectRoot: '/repo', detail: mergedFacts } },
    ])
  })

  test('says nothing when the code host refused the merge', async () => {
    mergedFacts = facts('open')
    mergeAnswer = { merged: false }
    const { server, broadcasts } = serverWithEvents()

    await server.handle('prMerge', [ctx, 7, 'squash', HEAD_SHA])

    expect(broadcasts).toEqual([])
  })
})
