import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { HostApi } from '@solus/client-core/host-api'
import type { PrReviewTarget } from '@solus/contracts/providers'
import type { ReviewGuide, ReviewGuideStatusEvent } from '@solus/contracts/review'
import type { IpcContext } from '@solus/contracts/types'

// The controller's loading path does not mount the toast UI.
mock.module('@solus/workspace-ui/lib/toasts', () => ({
  toasts: { error: () => {}, info: () => {}, success: () => {}, warning: () => {} },
}))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
const restorers: Array<() => void> = []
afterEach(() => {
  for (const restore of restorers.splice(0)) restore()
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

async function fixture() {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { PrGuideController } = await import('@solus/workspace-ui/components/pr-review/lib/pr-guide-controller.svelte')
  const { reviewGuideStore } = await import('@solus/workspace-ui/components/review/review-guide.store.svelte')
  const pr: PrReviewTarget = {
    host: 'github.com', owner: 'team', repo: 'repo', number: 7, title: 'PR',
    baseRef: 'main', headRef: 'feature', baseSha: 'base-a', headSha: 'head-a',
    headRepo: { owner: 'team', repo: 'repo', isFork: false },
  }
  let guide: ReviewGuide = {
    version: 1, key: 'pr-guide', title: 'Previous guide', summary: 'Summary',
    baseSha: 'base-a', headSha: 'head-a', generatedAt: '2026-09-09T10:00:00Z',
    sections: [{ id: 'one', title: 'Change', order: 1, significance: 'core', explanation: 'Why', ledgerRefs: [], files: [{ path: 'a.ts', additions: 1, deletions: 0 }] }],
  }
  let reads = 0
  const api = {
    readGuide: async () => { reads++; return guide },
    prGetDiff: async () => ({ patch: 'PR patch', truncated: false, nextCursor: null }),
  } as HostApi
  const controller = new PrGuideController({
    getApi: () => api, getServerId: () => 'controller-test',
    getCtx: () => ({ session: { projectPath: '/repo', workingDirectory: '/repo' } }) as IpcContext,
    getPr: () => pr,
    getAgent: () => ({ agent: 'claude', model: null, reasoningEffort: null }),
  })
  let event: ReviewGuideStatusEvent = {
    repoRoot: '/repo', key: controller.identity!.key, target: controller.target!, scope: 'pr',
    headSha: 'head-a', baseSha: 'base-a', status: 'ready', updatedAt: 1, generatedAt: guide.generatedAt,
  }
  const statusSpy = spyOn(reviewGuideStore, 'statusFor').mockImplementation(() => event)
  const loadSpy = spyOn(reviewGuideStore, 'load').mockResolvedValue()
  restorers.push(() => statusSpy.mockRestore(), () => loadSpy.mockRestore())
  return {
    controller, pr, loadSpy, reads: () => reads,
    event: () => event,
    replace: () => {
      guide = { ...guide, title: 'Replacement guide', generatedAt: '2026-09-09T11:00:00Z' }
      event = { ...event, updatedAt: 2, generatedAt: guide.generatedAt }
    },
    pushed: () => { event = { ...event, target: controller.target!, headSha: pr.headSha, status: 'outdated', updatedAt: 3 } },
  }
}

describe('PR guide pane lifecycle', () => {
  test('a completed rewrite replaces an open guide at the same head exactly once', async () => {
    const state = await fixture()
    await state.controller.load(false)
    expect(state.controller.loader.guide?.title).toBe('Previous guide')
    state.replace()
    await state.controller.syncSaved(state.event())
    expect(state.controller.loader.guide?.title).toBe('Replacement guide')
    const reads = state.reads()
    await state.controller.syncSaved(state.event())
    expect(state.reads()).toBe(reads)
  })

  test('a known PR push stays outdated while the status refresh is pending', async () => {
    const state = await fixture()
    await state.controller.load(false)
    expect(state.controller.loader.stale).toBe(false)
    state.pr.headSha = 'head-b'
    expect(state.controller.loader.stale).toBe(true)
    const probe = Promise.withResolvers<void>()
    state.loadSpy.mockImplementation(() => probe.promise)
    const loading = state.controller.load(false)
    expect(state.controller.loader.stale).toBe(true)
    state.pushed()
    probe.resolve()
    await loading
    expect(state.controller.loader.stale).toBe(true)
  })
})
