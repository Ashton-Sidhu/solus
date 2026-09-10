import { afterEach, describe, expect, test } from 'bun:test'
import type { ReviewContext, ReviewGuide } from '@solus/contracts/review'
import type { DiffScope } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const BRANCH_BASE = 'base-sha'

function guide(): ReviewGuide {
  return {
    version: 1,
    key: 'feat__reviews',
    headSha: 'head-sha',
    baseSha: BRANCH_BASE,
    title: 'Reviews',
    summary: 'What changed',
    sections: [
      {
        id: 'one',
        title: 'One',
        order: 1,
        significance: 'core',
        explanation: 'why',
        ledgerRefs: [],
        files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
      },
    ],
  }
}

const reviewContext: ReviewContext = {
  key: 'feat__reviews',
  branch: 'feat/reviews',
  targetBranch: 'main',
  baseSha: BRANCH_BASE,
  headSha: 'head-sha',
  repoRoot: '/repo',
}

interface Calls {
  getReviewContext: number
  diff: number
}

function fakeApi(calls: Calls) {
  return {
    readGuide: async () => guide(),
    readLedger: async () => null,
    getReviewContext: async () => {
      calls.getReviewContext += 1
      return reviewContext
    },
    diff: async () => {
      calls.diff += 1
      return { patch: 'patch-from-its-own-request' }
    },
  }
}

async function makeLoader(
  calls: Calls,
  extra: {
    getResolvedReviewContext?: () => ReviewContext | null
    getHostPatch?: (scope: Extract<DiffScope, { kind: 'pr' }>) => string | null
  },
) {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { GuideLoader } = await import('@solus/workspace-ui/components/review/lib/guide-loader.svelte')
  // SAFETY: reading a cached guide only reaches the four methods the fake has.
  const api = fakeApi(calls) as unknown as HostApi
  return new GuideLoader({
    getApi: () => api,
    getServerId: () => 'host-a',
    getCtx: () => ({ session: {} }) as never,
    getKey: () => 'feat__reviews',
    getScope: () => 'branch',
    getAgent: () => ({ agent: 'claude', model: null, reasoningEffort: null }),
    ...extra,
  })
}

describe('GuideLoader reuse', () => {
  test('starts idle when a pane opens during background generation', async () => {
    // WHY: the PR pane skips its cache load while generation runs. Its ready
    // handler must not mistake a new loader for an active request and wait forever.
    const loader = await makeLoader({ getReviewContext: 0, diff: 0 }, {})

    expect(loader.loading).toBe(false)
    await loader.load(false, false)
    expect(loader.guide?.title).toBe('Reviews')
    expect(loader.loading).toBe(false)
  })

  test('clears loading after a failed read so the guide can be retried', async () => {
    let fail = true
    const loader = await makeLoader({ getReviewContext: 0, diff: 0 }, {
      getResolvedReviewContext: () => {
        if (fail) throw new Error('Host disconnected')
        return reviewContext
      },
    })

    await expect(loader.load(false, false)).rejects.toThrow('Host disconnected')
    expect(loader.loading).toBe(false)
    fail = false
    await loader.load(false, false)
    expect(loader.loading).toBe(false)
    expect(loader.patch).toBe('patch-from-its-own-request')
  })

  test('reads the host review context instead of asking again', async () => {
    // WHY: the review surface has already resolved the branch's base — that is
    // what its diff is computed against. Asking a second time makes the guide
    // wait on a round trip whose answer is on screen.
    const calls: Calls = { getReviewContext: 0, diff: 0 }
    const loader = await makeLoader(calls, {
      getResolvedReviewContext: () => reviewContext,
      getHostPatch: () => null,
    })

    await loader.load(false, false)

    expect(calls.getReviewContext).toBe(0)
    expect(loader.diffScope).toEqual({ kind: 'pr', baseSha: BRANCH_BASE })
  })

  test('quotes the host patch rather than requesting the same diff twice', async () => {
    // WHY: the diff panel beside the guide is the engine that owns the patch.
    // When the guide compares the same two commits, a second request fetches
    // bytes the pane is already loading — the duplicate the user waits through.
    const calls: Calls = { getReviewContext: 0, diff: 0 }
    let hostPatch = ''
    const loader = await makeLoader(calls, {
      getResolvedReviewContext: () => reviewContext,
      getHostPatch: (scope) => (scope.baseSha === BRANCH_BASE ? hostPatch : null),
    })

    await loader.load(false, false)

    expect(calls.diff).toBe(0)
    // Empty while the panel's own load is in flight, then filled by it — the
    // guide follows that one load rather than holding a second copy.
    expect(loader.patch).toBe('')
    hostPatch = 'patch-from-the-panel'
    expect(loader.patch).toBe('patch-from-the-panel')
  })

  test('loads both itself when the host is showing something else', async () => {
    // WHY: a session guide, or a PR pane with no local review context, compares
    // a different pair of commits. Reuse must be a match, never an assumption.
    const calls: Calls = { getReviewContext: 0, diff: 0 }
    const loader = await makeLoader(calls, {})

    await loader.load(false, false)

    expect(calls.getReviewContext).toBe(1)
    expect(calls.diff).toBe(1)
    expect(loader.patch).toBe('patch-from-its-own-request')
  })
})

describe('PR guide snapshots', () => {
  async function makePrLoader(
    api: Partial<HostApi>,
    extra: Partial<import('@solus/workspace-ui/components/review/lib/guide-loader.svelte').GuideLoaderOptions> = {},
  ) {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { GuideLoader } = await import('@solus/workspace-ui/components/review/lib/guide-loader.svelte')
    const target = { kind: 'pr' as const, host: 'github.com', owner: 'team', repo: 'project', number: 7, headSha: 'head-sha', baseSha: BRANCH_BASE }
    return new GuideLoader({
      // SAFETY: Each test supplies only the endpoints its loader path uses.
      getApi: () => api as HostApi,
      getServerId: () => 'host-a',
      getCtx: () => ({ session: { workingDirectory: '/unrelated' } }) as never,
      getKey: () => 'pr-guide',
      getTarget: () => target,
      getScope: () => 'branch',
      getAgent: () => ({ agent: 'claude', model: null, reasoningEffort: null }),
      ...extra,
    })
  }

  test('reads the PR target and its recorded diff without using the active checkout', async () => {
    const reads: Array<Parameters<HostApi['readGuide']>> = []
    const patches: Array<Parameters<HostApi['prGetDiff']>[1]> = []
    const loader = await makePrLoader({
      readGuide: async (...args) => { reads.push(args); return guide() },
      prGetDiff: async (_ctx, request) => {
        patches.push(request)
        return { patch: 'PR patch', truncated: false, nextCursor: null }
      },
    })
    await loader.load(false, false)
    expect(reads[0][2]).toMatchObject({ kind: 'pr', number: 7, repo: 'project' })
    expect(patches).toEqual([{
      repo: { host: 'github.com', owner: 'team', repo: 'project' },
      number: 7, baseSha: BRANCH_BASE, headSha: 'head-sha', cursor: undefined,
    }])
    expect(loader.patch).toBe('PR patch')
    expect(loader.stale).toBe(false)
  })

  test('marks an already open guide outdated when either PR revision changes', async () => {
    let revision = { headSha: 'head-sha', baseSha: BRANCH_BASE }
    const loader = await makePrLoader({
      readGuide: async () => guide(),
      prGetDiff: async () => ({ patch: '', truncated: false, nextCursor: null }),
    }, { getCurrentRevision: () => revision })
    await loader.load(false, false)
    expect(loader.stale).toBe(false)
    revision = { ...revision, baseSha: 'new-base' }
    expect(loader.stale).toBe(true)
    revision = { headSha: 'new-head', baseSha: BRANCH_BASE }
    expect(loader.stale).toBe(true)
  })

  test('a failed replacement preserves the old content, diff and outdated warning', async () => {
    let fail = false
    const loader = await makePrLoader({
      readGuide: async () => ({ ...guide(), title: fail ? 'Replacement' : 'Previous' }),
      prGetDiff: async () => {
        if (fail) throw new Error('Host disconnected')
        return { patch: 'Previous patch', truncated: false, nextCursor: null }
      },
    }, { getCurrentRevision: () => ({ headSha: 'new-head', baseSha: BRANCH_BASE }) })
    await loader.load(false, false)
    fail = true
    await expect(loader.load(false, false)).rejects.toThrow('Host disconnected')
    expect(loader.guide?.title).toBe('Previous')
    expect(loader.patch).toBe('Previous patch')
    expect(loader.stale).toBe(true)
    expect(loader.error).toBe('Host disconnected')
    expect(loader.loading).toBe(false)
  })

  test('a delayed read for the previous PR cannot replace the current guide', async () => {
    let number = 7
    const oldRead = Promise.withResolvers<ReviewGuide | null>()
    const loader = await makePrLoader({
      readGuide: async (_ctx, _key, target) => target?.kind === 'pr' && target.number === 7
        ? oldRead.promise : { ...guide(), title: 'PR eight' },
      prGetDiff: async () => ({ patch: 'Current patch', truncated: false, nextCursor: null }),
    }, { getTarget: () => ({ kind: 'pr', host: 'github.com', owner: 'team', repo: 'project', number, baseSha: BRANCH_BASE, headSha: 'head-sha' }) })
    const oldLoading = loader.load(false, false)
    number = 8
    await loader.load(false, false)
    oldRead.resolve({ ...guide(), title: 'PR seven' })
    await oldLoading
    expect(loader.guide?.title).toBe('PR eight')
    expect(loader.patch).toBe('Current patch')
    expect(loader.loading).toBe(false)
  })

  test('reports unknown freshness when current PR revisions are unavailable', async () => {
    const loader = await makePrLoader({
      readGuide: async () => guide(),
      prGetDiff: async () => ({ patch: '', truncated: false, nextCursor: null }),
    }, { getCurrentRevision: () => null })
    await loader.load(false, false)
    expect(loader.freshnessUnknown).toBe(true)
  })
})
