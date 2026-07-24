import { describe, expect, test } from 'bun:test'
import type { StackGraph } from '../../src/shared/stack-types'
import { groupStackedPrRows, stackChainFor } from '../../src/renderer/components/prs/lib/stack-grouping'

function graph(edges: StackGraph['edges']): StackGraph {
  return { edges, headShas: {}, detectedAt: '2026-01-01T00:00:00.000Z' }
}

describe('groupStackedPrRows', () => {
  test('children stay beside their parent so stack order is visible without changing the active sort', () => {
    const rows = groupStackedPrRows(
      [{ number: 30 }, { number: 10 }, { number: 20 }, { number: 40 }],
      graph([
        { parent: 10, child: 20, source: 'ancestry' },
        { parent: 20, child: 30, source: 'ancestry' },
      ]),
    )

    expect(rows.map(({ pr, depth, parent }) => [pr.number, depth, parent])).toEqual([
      [10, 0, null],
      [20, 1, 10],
      [30, 2, 20],
      [40, 0, null],
    ])
  })

  test('an orphan stays flat because filtered-out parents must not add phantom nesting', () => {
    const rows = groupStackedPrRows(
      [{ number: 20 }, { number: 40 }],
      graph([{ parent: 10, child: 20, source: 'declared' }]),
    )

    expect(rows.map(({ pr, depth, parent }) => [pr.number, depth, parent])).toEqual([
      [20, 0, null],
      [40, 0, null],
    ])
  })

  test('cycles and self-edges stay flat and cannot hang list projection', () => {
    const rows = groupStackedPrRows(
      [{ number: 10 }, { number: 20 }, { number: 30 }],
      graph([
        { parent: 20, child: 10, source: 'manual' },
        { parent: 10, child: 20, source: 'manual' },
        { parent: 30, child: 30, source: 'manual' },
      ]),
    )

    expect(rows.map(({ pr, depth }) => [pr.number, depth])).toEqual([
      [10, 0],
      [20, 0],
      [30, 0],
    ])
  })
})

describe('stackChainFor', () => {
  test('the detail rail includes the full unambiguous chain around the current PR', () => {
    expect(stackChainFor(graph([
      { parent: 10, child: 20, source: 'ancestry' },
      { parent: 20, child: 30, source: 'ancestry' },
    ]), 20)).toEqual([10, 20, 30])
  })
})
