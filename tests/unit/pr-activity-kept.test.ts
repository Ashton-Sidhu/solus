import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import type { PrCommit, PrConversationItem, PrReviewer, PullRequest } from '@solus/contracts/providers'
import type { ChangedFileStat, IpcContext } from '@solus/contracts/types'
import { asHostApi } from '@solus/client-core/host-api'

// A pull request somebody opened is kept on this device, so the next load of
// the app paints its Activity tab before the host answers (desktop and web
// keep it in IndexedDB; under test the cache is in memory). The copy never
// replaces what this load of the app has read, and a list row a person only
// scrolled past is not kept.

interface RuneGlobals {
  $state?: unknown
  $derived?: unknown
}
const previousState = (globalThis as unknown as RuneGlobals).$state
const previousDerived = (globalThis as unknown as RuneGlobals).$derived

beforeEach(() => {
  ;(globalThis as unknown as RuneGlobals).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  ;(globalThis as unknown as RuneGlobals).$derived = Object.assign(
    <T>(value: T) => value,
    { by: <T>(fn: () => T) => fn() },
  )
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
  if (previousState === undefined) delete (globalThis as unknown as RuneGlobals).$state
  else (globalThis as unknown as RuneGlobals).$state = previousState
  if (previousDerived === undefined) delete (globalThis as unknown as RuneGlobals).$derived
  else (globalThis as unknown as RuneGlobals).$derived = previousDerived
})

const ctx = {
  session: { projectPath: '/repos/kept', workingDirectory: '/repos/kept' },
  window: {},
  settings: {},
  statusBar: {},
} as IpcContext

const NO_CHECKS = {
  prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'kept' }, checks: [] }),
  prGuideMetadata: async () => null,
}

/** A host whose reads never answer: what paints comes from the device alone. */
const SILENT_HOST = asHostApi({
  prGetOverview: () => new Promise(() => {}),
  prListComments: () => new Promise(() => {}),
  ...NO_CHECKS,
})

function pullRequest(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    url: `https://github.com/acme/kept/pull/${number}`,
    title: `PR #${number}`,
    headSha: `sha-${number}`,
    baseSha: `base-${number}`,
    baseRepo: { host: 'github.com', owner: 'acme', repo: 'kept' },
    headRepo: { owner: 'acme', repo: 'kept', isFork: false },
    author: 'octocat',
    authorAvatarUrl: '',
    state: 'open',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    draft: false,
    labels: [],
    additions: 1,
    deletions: 0,
    body: 'Why this change matters',
    baseRef: 'main',
    headRef: `feature/${number}`,
    changedFiles: 1,
    mergeable: true,
    mergeStateStatus: 'clean',
    capabilities: {
      diff: true, diffFileContents: true, inlineComments: true, threadReplies: true, threadResolution: true,
      reviewVerdicts: ['comment'], actions: ['merge'], mergeMethods: ['squash'],
      reviewerRequests: true, reviewerCandidates: true, labelManagement: true,
    },
    viewerPermissions: {
      actions: ['merge'], reviewVerdicts: ['comment'], comment: true,
      resolveThreads: true, requestReviewers: true, manageLabels: true,
    },
    ...overrides,
  }
}

const commit: PrCommit = { sha: 'a'.repeat(40), message: 'First', author: 'octocat', committedAt: '2026-11-01T10:00:00Z' }
const reviewer = { login: 'reviewer', avatarUrl: '', state: 'APPROVED' } as PrReviewer
const comment = { kind: 'comment', id: 'c1', body: 'Looks good', author: 'reviewer', createdAt: '2026-11-01T11:00:00Z' } as PrConversationItem
const file = { path: 'src/a.ts', additions: 1, deletions: 0 } as ChangedFileStat

/** A new `PrsStore` is what a reload of the app starts from. */
async function afterReload(api: ReturnType<typeof asHostApi>, number: number) {
  const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
  return new PrsStore().get(api, 'host-kept', ctx).get(number)
}

/** Open a pull request the way the Activity tab does, then let the write land. */
async function openAndKeep(number: number, detail = pullRequest(number)) {
  const api = asHostApi({
    prGetOverview: async () => ({ pullRequest: detail, commits: [commit], reviewers: [reviewer] }),
    prListComments: async () => [comment],
    prChangedFiles: async () => [file],
    ...NO_CHECKS,
  })
  const opened = await afterReload(api, number)
  await opened.loadOverview()
  await opened.loadComments()
  await opened.loadChangedFiles()
  jest.advanceTimersByTime(1_000)
  jest.useRealTimers()
  await Bun.sleep(5)
  jest.useFakeTimers()
}

describe('an opened pull request is kept on this device', () => {
  test('after a reload its activity paints before the host answers', async () => {
    await openAndKeep(101)

    const reloaded = await afterReload(SILENT_HOST, 101)
    const restored = await reloaded.restoreActivity()

    expect(restored.commits).toEqual([commit])
    expect(restored.comments).toEqual([comment])
    expect(restored.reviewers).toEqual([reviewer])
    expect(restored.changedFiles).toEqual([file])
    expect(reloaded.cachedActivity().comments).toEqual([comment])
    // The body is not in a list row: only the kept detail has it.
    expect(reloaded.isDescribed).toBe(true)
    expect(reloaded.body).toBe('Why this change matters')
  })

  test('a kept copy never replaces what this load of the app already read', async () => {
    await openAndKeep(102)
    const newer = { ...comment, id: 'c2', body: 'One more thing' }
    const api = asHostApi({ prListComments: async () => [newer], ...NO_CHECKS })

    const reloaded = await afterReload(api, 102)
    await reloaded.loadComments()
    const restored = await reloaded.restoreActivity()

    expect(restored.comments).toBeUndefined()
    expect(reloaded.comments).toEqual([newer])
    // The parts this load has not read still paint from the device.
    expect(restored.commits).toEqual([commit])
  })

  test('a kept detail older than the row the list now holds is not shown', async () => {
    await openAndKeep(103)
    const reloaded = await afterReload(SILENT_HOST, 103)
    reloaded.apply(pullRequest(103, { title: 'Renamed since', updatedAt: '2026-11-05T00:00:00Z', body: '' }))

    const restored = await reloaded.restoreActivity()

    expect(restored.detail).toBeUndefined()
    expect(reloaded.title).toBe('Renamed since')
  })

  test('a pull request whose detail was never read is not kept', async () => {
    // A list row reads its changed files for the change breakdown without
    // anyone opening it; that row is not worth a place on the device.
    const api = asHostApi({ prChangedFiles: async () => [file], ...NO_CHECKS })
    const row = await afterReload(api, 104)
    await row.loadChangedFiles()
    jest.advanceTimersByTime(1_000)
    jest.useRealTimers()
    await Bun.sleep(5)
    jest.useFakeTimers()

    const reloaded = await afterReload(SILENT_HOST, 104)
    expect(await reloaded.restoreActivity()).toEqual({})
  })
})
