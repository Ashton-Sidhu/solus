import { expect, test } from 'bun:test'
import type { HostApi } from '@solus/client-core/host-api'
import type { ReviewState } from '@solus/contracts/review'
import type { IpcContext } from '@solus/contracts/types'

test('a reopened review restores its summary and line comment, then clears the submitted snapshot', async () => {
  const previousState = globalThis.$state
  const previousDerived = globalThis.$derived
  globalThis.$state = Object.assign(<T>(value: T) => value, { snapshot: structuredClone })
  globalThis.$derived = <T>(value: T) => value
  try {
    const { ReviewDrafts } = await import('@solus/workspace-ui/components/review/lib/review-drafts.svelte')
    let stored: ReviewState | null = null
    const api = {
      readReviewState: async () => structuredClone(stored),
      writeReviewState: async (_ctx: IpcContext, state: ReviewState) => {
        stored = structuredClone(state)
        return true
      },
    } satisfies Pick<HostApi, 'readReviewState' | 'writeReviewState'>
    const options = {
      getApi: () => api as HostApi,
      getCtx: () => ({}) as IpcContext,
      key: 'solus__pr-7',
    }

    const first = new ReviewDrafts(options)
    await first.load()
    const id = first.save({ filePath: 'file.ts', startLine: 3, endLine: 4, side: 'new', selectedCode: '', comment: 'Check this' })
    first.summary = 'Review summary'
    const restored = new ReviewDrafts(options)
    await restored.load()
    expect(restored.drafts).toMatchObject([{ id, startLine: 3, line: 4, body: 'Check this' }])
    expect(restored.summary).toBe('Review summary')

    const next = restored.save({ filePath: 'other.ts', startLine: 8, endLine: 8, side: 'old', selectedCode: '', comment: 'Keep this' })
    expect(next).not.toBe(id)
    const clearSubmitted = restored.captureSubmission()
    restored.summary = 'More feedback'
    restored.save({ id: next ?? '', filePath: 'other.ts', startLine: 8, endLine: 8, side: 'old', selectedCode: '', comment: 'Edited during submission' })
    await clearSubmitted()
    expect(restored.drafts).toMatchObject([{ id: next, body: 'Edited during submission' }])
    expect(restored.summary).toBe('More feedback')
    await restored.captureSubmission()()
    const afterSubmit = new ReviewDrafts(options)
    await afterSubmit.load()
    expect(afterSubmit.drafts).toEqual([])
    expect(afterSubmit.summary).toBe('')
  } finally {
    globalThis.$state = previousState
    globalThis.$derived = previousDerived
  }
})

test('host review drafts follow the latest write and stay with their requester and comparison', async () => {
  const { actorFor } = await import('@solus/server/admission/actor')
  const { readPrReviewState, writePrReviewState } = await import('@solus/server/review/review-state')
  const member = (userId: string, organizationId: string) => actorFor({
    kind: 'org-member', userId, organizationId, organizationRole: 'member', teamIds: [],
    hostKind: 'managed', displayName: userId, deviceId: 'device', deviceLabel: 'Device', expiresAt: Infinity,
  })
  const actor = member('viewer-a', 'team-a')
  const scope = { host: 'github.com', owner: 'acme', repo: 'app', number: 7, baseSha: 'base', headSha: 'head' }
  const key = 'pr-7'
  const state: ReviewState = { version: 1, key, drafts: [], summary: 'First edit' }
  const firstWrite = writePrReviewState(actor, scope, state)
  const secondWrite = writePrReviewState(actor, scope, { ...state, summary: 'Latest edit' })
  expect(await readPrReviewState(actor, scope, key)).toEqual({ ...state, summary: 'Latest edit' })
  expect(await Promise.all([firstWrite, secondWrite])).toEqual([true, true])
  expect((await readPrReviewState(actor, { ...scope, headSha: 'next' }, key)).summary).toBe('')
  expect((await readPrReviewState(actor, { ...scope, baseSha: 'next-base' }, key)).summary).toBe('')
  expect((await readPrReviewState(actor, { ...scope, repo: 'another' }, key)).summary).toBe('')
  expect((await readPrReviewState(member('viewer-b', 'team-a'), scope, key)).summary).toBe('')
  expect((await readPrReviewState(member('viewer-a', 'team-b'), scope, key)).summary).toBe('')
})
