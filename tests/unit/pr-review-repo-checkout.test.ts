import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { GitCheckout, PrRepoCheckoutResult } from '@solus/contracts/types'
import type { PrReviewTarget } from '@solus/contracts/providers'
import type { PrReviewDeps } from '@solus/workspace-ui/components/pr-review/lib/pr-review.store.svelte'
import { TransportDisconnectedError } from '@solus/client-core/ws-transport'

// PrReviewState is a runes class; outside the Svelte compiler `$state` is an
// identity function (same shim as the other pr-review store tests).
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

function target(): PrReviewTarget {
  return {
    host: 'github.com',
    owner: 'acme',
    repo: 'app',
    number: 7,
    title: 'Keep host selection stable',
    baseRef: 'main',
    headRef: 'feature',
    baseSha: 'base-sha',
    headSha: 'head-sha',
    headRepo: { owner: 'acme', repo: 'app', isFork: false },
  }
}

function makeDeps(checkoutInRepo: PrReviewDeps['checkoutInRepo']): PrReviewDeps {
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
    loadDiff: unused,
    prepareCheckout: unused,
    checkoutInRepo,
    loadInterdiff: unused,
    diffStats: unused,
    replyThread: unused,
    resolveThread: unused,
  }
}

const gitContext: GitCheckout = { branch: 'feature', targetBranch: 'main', repoRoot: '/repo' }

describe('PrReviewState.checkoutInRepo', () => {
  test('reports success and the resulting git context', async () => {
    const { PrReviewState } = await import('@solus/workspace-ui/components/pr-review/lib/pr-review.store.svelte')
    const state = new PrReviewState(7, makeDeps(async () => ({ success: true, gitContext })))
    state.setTarget(target())

    const result = await state.checkoutInRepo()

    expect(result).toEqual({ success: true, gitContext })
    expect(state.repoCheckoutStatus).toBe('ready')
    expect(state.repoCheckoutError).toBeNull()
  })

  test('surfaces a structured block reason without throwing', async () => {
    const { PrReviewState } = await import('@solus/workspace-ui/components/pr-review/lib/pr-review.store.svelte')
    const blocked: PrRepoCheckoutResult = {
      success: false,
      reason: 'branch-in-use',
      worktreePath: '/repo/.solus-worktrees/feature',
      error: 'This branch is already checked out at /repo/.solus-worktrees/feature.',
    }
    const state = new PrReviewState(7, makeDeps(async () => blocked))
    state.setTarget(target())

    const result = await state.checkoutInRepo()

    // WHY: the confirm dialog reads the reason to show the specific message
    // (branch in use, dirty, stale head, …) rather than a generic failure —
    // a thrown error would lose that distinction.
    expect(result).toEqual(blocked)
    expect(state.repoCheckoutStatus).toBe('failed')
    expect(state.repoCheckoutReason).toBe('branch-in-use')
    expect(state.repoCheckoutWorktreePath).toBe('/repo/.solus-worktrees/feature')
    expect(state.repoCheckoutError).toBe(blocked.error)
  })

  test('marks a disconnected host distinctly from a server-reported failure', async () => {
    const { PrReviewState } = await import('@solus/workspace-ui/components/pr-review/lib/pr-review.store.svelte')
    const state = new PrReviewState(7, makeDeps(async () => {
      throw new TransportDisconnectedError()
    }))
    state.setTarget(target())

    await expect(state.checkoutInRepo()).rejects.toThrow(TransportDisconnectedError)

    expect(state.repoCheckoutStatus).toBe('failed')
    expect(state.repoCheckoutReason).toBe('disconnected')
  })

  test('does not start a second checkout while one is already in flight', async () => {
    const { PrReviewState } = await import('@solus/workspace-ui/components/pr-review/lib/pr-review.store.svelte')
    let calls = 0
    let resolve!: (result: PrRepoCheckoutResult) => void
    const pending = new Promise<PrRepoCheckoutResult>((r) => { resolve = r })
    const state = new PrReviewState(7, makeDeps(async () => {
      calls++
      return pending
    }))
    state.setTarget(target())

    const first = state.checkoutInRepo()
    const second = state.checkoutInRepo()
    resolve({ success: true, gitContext })
    await Promise.all([first, second])

    expect(calls).toBe(1)
  })
})
