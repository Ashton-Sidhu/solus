import { describe, expect, test } from 'bun:test'
import type { DraftReview } from '../../src/shared/providers'
import type { IpcContext, PrReviewContext } from '../../src/shared/types'
import { createReviewDispositionPoster } from '../../src/renderer/components/review-mode/lib/review-disposition-poster'

const ctx = {} as IpcContext
const pr = {
  number: 42,
  title: 'Make review mode real',
  headSha: 'head-42',
  baseSha: 'base-42',
} as PrReviewContext

function harness() {
  const submitted: DraftReview[] = []
  const poster = createReviewDispositionPoster({
    getContext: () => ctx,
    getReview: (number) => number === pr.number ? pr : null,
    submit: async (_ctx, _number, review) => { submitted.push(review) },
  })
  return { poster, submitted }
}

describe('review disposition poster', () => {
  test('approval posts only the review disposition', async () => {
    const { poster, submitted } = harness()
    await poster.post({ prNumber: 42, outcome: 'approved', heldAt: 0 })

    expect(submitted).toEqual([{
      body: '',
      event: 'APPROVE',
      commitId: 'head-42',
      baseSha: 'base-42',
      comments: [],
    }])
  })

  test('request changes carries the inline body and deferral never touches the provider', async () => {
    const { poster, submitted } = harness()
    await poster.post({
      prNumber: 42,
      outcome: 'changes_requested',
      body: '  Please cover the failure path.  ',
      heldAt: 0,
    })
    await poster.post({ prNumber: 42, outcome: 'deferred', heldAt: 0 })

    expect(submitted).toHaveLength(1)
    expect(submitted[0].event).toBe('REQUEST_CHANGES')
    expect(submitted[0].body).toBe('Please cover the failure path.')
  })
})
