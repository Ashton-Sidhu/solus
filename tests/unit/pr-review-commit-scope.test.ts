import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { PrCommit, PrDiffRequest, PrDiffSlice, PrReviewTarget } from '../../src/shared/providers'
import type { PrReviewDeps } from '../../src/renderer/components/pr-review/lib/pr-review.store.svelte'

// PrReviewState is a runes class; outside the Svelte compiler `$state` and
// `$derived` are identity functions (same shim as the PrsStore tests).
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
})

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as RuneGlobals).$state
  else (globalThis as unknown as RuneGlobals).$state = previousState
  if (previousDerived === undefined) delete (globalThis as unknown as RuneGlobals).$derived
  else (globalThis as unknown as RuneGlobals).$derived = previousDerived
})

function target(headSha: string): PrReviewTarget {
  return {
    host: 'github.com',
    owner: 'acme',
    repo: 'app',
    number: 7,
    title: 'Keep host selection stable',
    baseRef: 'main',
    headRef: 'feature',
    baseSha: 'base-sha',
    headSha,
    headRepo: { owner: 'acme', repo: 'app', isFork: false },
  }
}

const commit: PrCommit = {
  sha: 'c'.repeat(40),
  message: 'fix: keep host selection stable',
  author: 'sidhu',
  committedAt: '2026-01-01T00:00:00Z',
}

function makeDeps(loadDiff: (request: PrDiffRequest) => Promise<PrDiffSlice>): PrReviewDeps {
  const unused = () => {
    throw new Error('not relevant')
  }
  return {
    getApi: unused,
    fallbackCtx: () => ({}) as ReturnType<PrReviewDeps['fallbackCtx']>,
    ctxForDirectory: unused,
    stackedPrsEnabled: () => false,
    resolveDiffBase: unused,
    loadStacks: unused,
    loadThreads: unused,
    loadDiff: (_ctx, request) => loadDiff(request),
    prepareCheckout: unused,
    loadInterdiff: unused,
    diffStats: unused,
    replyThread: unused,
    resolveThread: unused,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve))

describe('PR review commit scope', () => {
  test('scoping to a commit loads that commit without clobbering the full diff', async () => {
    // WHY: leaving the commit must return to an intact review — reloading the
    // whole PR diff on every commit visit would make the feature feel broken.
    const requests: PrDiffRequest[] = []
    const { PrReviewState } = await import('../../src/renderer/components/pr-review/lib/pr-review.store.svelte')
    const state = new PrReviewState(7, makeDeps(async (request) => {
      requests.push(request)
      return { patch: request.commitSha ? 'commit-patch' : 'full-patch', truncated: false, nextCursor: null }
    }))
    state.setTarget(target('head-sha'))

    state.loadDiff()
    await settle()
    expect(state.diffPatch).toBe('full-patch')

    state.viewCommit(commit)
    await settle()
    expect(requests.at(-1)?.commitSha).toBe(commit.sha)
    expect(state.commitDiffPatch).toBe('commit-patch')
    expect(state.diffPatch).toBe('full-patch')

    // The way back: clearing the scope keeps both patches, and re-opening the
    // same commit serves the cached patch without another provider read.
    const readsBefore = requests.length
    state.clearCommitScope()
    expect(state.commitScope).toBeNull()
    state.viewCommit(commit)
    expect(requests.length).toBe(readsBefore)
    expect(state.commitDiffPatch).toBe('commit-patch')
  })

  test('a moved head clears the commit scope instead of stranding the reader', async () => {
    // WHY: after a force push the scoped commit may no longer exist on the PR;
    // the diff surface must fall back to the full diff, which always exists.
    const { PrReviewState } = await import('../../src/renderer/components/pr-review/lib/pr-review.store.svelte')
    const state = new PrReviewState(7, makeDeps(async () => ({ patch: 'commit-patch', truncated: false, nextCursor: null })))
    state.setTarget(target('head-sha'))
    state.viewCommit(commit)
    await settle()
    expect(state.commitDiffPatch).toBe('commit-patch')

    state.setTarget(target('moved-head-sha'))
    expect(state.commitScope).toBeNull()
    expect(state.commitDiffPatch).toBeNull()
  })
})
