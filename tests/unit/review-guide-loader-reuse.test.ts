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
