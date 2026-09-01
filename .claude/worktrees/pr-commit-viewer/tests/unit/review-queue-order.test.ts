import { describe, expect, test } from 'bun:test'
import { orderReviewQueue, type ReviewQueueItem } from '../../src/renderer/components/review-mode/lib/review-queue-order'
import type { ReviewEffort } from '../../src/shared/effort-types'
import type { StackGraph } from '../../src/shared/stack-types'

function effort(minutes: number): ReviewEffort {
  return { minutes, band: 'standard', signals: [`${minutes} minute estimate`] }
}

function graph(edges: Array<[number, number]>): StackGraph {
  return {
    edges: edges.map(([parent, child]) => ({ parent, child, source: 'ancestry' })),
    headShas: {},
    detectedAt: '2026-07-15T00:00:00.000Z',
  }
}

function numbers(items: ReviewQueueItem[]): number[] {
  return items.map((item) => item.number)
}

describe('orderReviewQueue', () => {
  test('puts shorter reviews first so the default queue front-loads throughput', () => {
    const ordered = orderReviewQueue([
      { number: 101, effort: effort(8) },
      { number: 102, effort: effort(2) },
      { number: 103, effort: effort(5) },
    ], null)

    expect(numbers(ordered)).toEqual([102, 103, 101])
  })

  test('keeps a stack adjacent and parent-first even when its child has less effort', () => {
    const ordered = orderReviewQueue([
      { number: 202, effort: effort(1) },
      { number: 303, effort: effort(3) },
      { number: 201, effort: effort(10) },
    ], graph([[201, 202]]))

    expect(numbers(ordered)).toEqual([201, 202, 303])
  })

  test('sorts unknown effort last while preserving their input order', () => {
    const ordered = orderReviewQueue([
      { number: 101 },
      { number: 102, effort: effort(4) },
      { number: 103 },
      { number: 104, effort: effort(1) },
    ], null)

    expect(numbers(ordered)).toEqual([104, 102, 101, 103])
  })

  test('uses original input order as the deterministic equal-effort tie-break', () => {
    const input = [
      { number: 105, effort: effort(3) },
      { number: 101, effort: effort(3) },
      { number: 103, effort: effort(3) },
    ]

    expect(numbers(orderReviewQueue(input, null))).toEqual([105, 101, 103])
    expect(numbers(orderReviewQueue(input, null))).toEqual([105, 101, 103])
  })
})
