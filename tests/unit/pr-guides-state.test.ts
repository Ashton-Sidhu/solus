import { afterEach, describe, expect, test } from 'bun:test'
import type { HostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { IpcContext } from '@solus/contracts/types'
import type { ReviewGuideStatusEvent, ReviewTarget } from '@solus/contracts/review'
import { pullRequestFixture } from './__fixtures__/pull-request'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})
const HOST = 'host-a'
const ctx = { session: { projectPath: '/repo', workingDirectory: '/repo' } } as IpcContext

async function setup() {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
  const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
  const { PrGuidesStore } = await import('@solus/workspace-ui/contexts/prs/pr-guides.store.svelte')
  const { ReviewGuideStore, prGuideIdentity } = await import('@solus/workspace-ui/components/review/review-guide.store.svelte')
  const events = new HostEventSubscriber()
  const shared = new ReviewGuideStore(() => events, () => () => {})
  const prs = new PrsStore()
  const eventFor = (target: ReviewTarget, status: ReviewGuideStatusEvent['status'], updatedAt: number): ReviewGuideStatusEvent => ({
    repoRoot: '/repo', key: target.kind === 'pr' ? prGuideIdentity('/repo', target).key : '',
    target, scope: 'pr', headSha: 'head-a', baseSha: 'base-a', status, updatedAt,
    generationId: `run-${target.kind === 'pr' ? target.number : 0}`,
  })
  const api = {
    requestReviewGuide: async (_ctx: IpcContext, request: { target?: ReviewTarget }) => {
      if (!request.target) throw new Error('A PR target is required')
      return eventFor(request.target, 'queued', 1)
    },
  } as HostApi
  const project = prs.get(api, HOST, ctx)
  const first = project.absorb(pullRequestFixture(7, { headSha: 'head-a', baseSha: 'base-a' }))
  const second = project.absorb(pullRequestFixture(8, { headSha: 'head-a', baseSha: 'base-a' }))
  const targetFor = (number: number): Extract<ReviewTarget, { kind: 'pr' }> => ({ kind: 'pr', ...first.baseRepo, number, headSha: 'head-a', baseSha: 'base-a' })
  return { shared, guides: new PrGuidesStore(prs, shared), api, events, first, second, targetFor, eventFor }
}

describe('PR guide list adapter', () => {
  test('the PR list reads the same generation that a review card started', async () => {
    const { shared, guides, targetFor, eventFor } = await setup()
    const target = targetFor(7)
    shared.set(HOST, eventFor(target, 'generating', 1))
    expect(guides.statusFor(HOST, ctx, 7)).toBe('generating')
    shared.set(HOST, { ...eventFor(target, 'ready', 2), generatedAt: '2026-09-09T12:00:00Z' })
    expect(guides.statusFor(HOST, ctx, 7)).toBe('ready')
    expect(guides.metadataFor(HOST, ctx, 7)?.current).toBe(true)
    expect([...guides.status.values()]).toEqual(['ready'])
  })

  test('target branch changes do not override the host comparison-base verdict', async () => {
    const { shared, guides, first, targetFor, eventFor } = await setup()
    const target = targetFor(7)
    shared.set(HOST, { ...eventFor(target, 'ready', 2), generatedAt: '2026-09-09T12:00:00Z' })
    first.baseSha = 'new-target-tip'
    expect(guides.statusFor(HOST, ctx, 7)).toBe('ready')
    shared.set(HOST, eventFor(target, 'outdated', 3))
    expect(guides.statusFor(HOST, ctx, 7)).toBe('outdated')
  })

  test('saved guide metadata survives a replacement job and failure', async () => {
    const { shared, guides, targetFor, eventFor } = await setup()
    const target = targetFor(7)
    shared.set(HOST, { ...eventFor(target, 'ready', 2), generatedAt: '2026-09-09T12:00:00Z' })
    for (const [index, status] of (['queued', 'generating', 'failed'] as const).entries()) {
      shared.set(HOST, eventFor(target, status, index + 3))
      expect(guides.metadataFor(HOST, ctx, 7)?.generatedAt).toBe('2026-09-09T12:00:00Z')
    }
  })

  test('a PR push changes a ready indicator to outdated without losing the guide', async () => {
    const { shared, guides, first, targetFor, eventFor } = await setup()
    shared.set(HOST, { ...eventFor(targetFor(7), 'ready', 2), generatedAt: '2026-09-09T12:00:00Z' })
    first.headSha = 'head-b'
    expect(guides.statusFor(HOST, ctx, 7)).toBe('outdated')
    expect(guides.metadataFor(HOST, ctx, 7)?.current).toBe(false)
  })

  test('independent generation requests keep their own completion callbacks', async () => {
    const { guides, api, events, targetFor, eventFor } = await setup()
    const outcomes: string[] = []
    await guides.request(api, HOST, ctx, [7], { onSettled: ({ failed }) => outcomes.push(`first:${failed}`) })
    await guides.request(api, HOST, ctx, [8], { onSettled: ({ failed }) => outcomes.push(`second:${failed}`) })
    events.receive({ type: 'review.guideStatusChanged', payload: eventFor(targetFor(8), 'cancelled', 2), occurredAt: 2 })
    expect(outcomes).toEqual(['second:1'])
    events.receive({ type: 'review.guideStatusChanged', payload: eventFor(targetFor(7), 'ready', 3), occurredAt: 3 })
    expect(outcomes).toEqual(['second:1', 'first:0'])
  })
})
