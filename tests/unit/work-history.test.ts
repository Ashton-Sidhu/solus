import { describe, expect, test } from 'bun:test'
import type { WorkRevisionSummary } from '@solus/contracts/types'
import {
  diagramRevisionDiff,
  historyPoints,
  historyRows,
  markdownBlockDiff,
  markdownBlocks,
  pointBefore,
} from '@solus/workspace-ui/components/work/lib/work-history'

/**
 * The History dialog (docs/plans/work-review-and-live-editing.md, phase 1):
 * every version is listed once, a row compares against the version before it,
 * and the comparison says what was added, removed, and changed.
 */

function revision(revisionId: number, reason: WorkRevisionSummary['reason'], contentHash: string): WorkRevisionSummary {
  return { workId: 'w', revisionId, reason, sourceContentVersion: revisionId, author: null, contentHash, capturedAt: new Date(revisionId * 1000).toISOString() }
}

describe('history rows', () => {
  test('a checkpoint that repeats the version before it is not a version of its own', () => {
    const rows = historyRows([revision(1, 'baseline', 'a'), revision(2, 'checkpoint', 'a'), revision(3, 'agent', 'b')])
    expect(rows.map((row) => row.revisionId)).toEqual([3, 1])
  })

  test('the current body leads only when no checkpoint holds it', () => {
    const rows = historyRows([revision(1, 'baseline', 'a'), revision(2, 'agent', 'b')])
    expect(historyPoints(rows, 'b')).toEqual([2, 1])
    expect(historyPoints(rows, 'c')).toEqual(['current', 2, 1])
  })

  test('a row compares with the version before it; the oldest with nothing', () => {
    const points = ['current', 2, 1] as const
    expect(pointBefore(points, 'current')).toBe(2)
    expect(pointBefore(points, 2)).toBe(1)
    expect(pointBefore(points, 1)).toBeNull()
  })
})

describe('rendered document comparison', () => {
  test('a fenced block with blank lines stays one block', () => {
    expect(markdownBlocks('# Title\n\n```ts\na\n\nb\n```\n\nEnd')).toEqual(['# Title', '```ts\na\n\nb\n```', 'End'])
  })

  test('an edited paragraph shows its old form removed and its new form added, in reading order', () => {
    const diff = markdownBlockDiff('# Plan\n\nFirst.\n\nSecond.', '# Plan\n\nFirst, edited.\n\nSecond.\n\nThird.')
    expect(diff).toEqual([
      { change: 'same', markdown: '# Plan' },
      { change: 'removed', markdown: 'First.' },
      { change: 'added', markdown: 'First, edited.' },
      { change: 'same', markdown: 'Second.' },
      { change: 'added', markdown: 'Third.' },
    ])
  })
})

describe('diagram comparison', () => {
  test('nodes and edges are added, removed, or changed by id', () => {
    const before = JSON.stringify({ nodes: [{ id: 'a', label: 'API' }, { id: 'b', label: 'DB' }], edges: [{ id: 'e1', source: 'a', target: 'b' }] })
    const after = JSON.stringify({ nodes: [{ id: 'a', label: 'Gateway' }, { id: 'c', label: 'Cache' }], edges: [{ id: 'e2', source: 'a', target: 'c' }] })
    const diff = diagramRevisionDiff(before, after)
    expect([...diff.added].sort()).toEqual(['c', 'e2'])
    expect([...diff.removed].sort()).toEqual(['b', 'e1'])
    expect([...diff.changed]).toEqual(['a'])
    expect(diff.changes.find((change) => change.id === 'e2')?.label).toBe('Gateway → Cache')
  })

  test('an unreadable body compares as empty', () => {
    const diff = diagramRevisionDiff('not json', JSON.stringify({ nodes: [{ id: 'a', label: 'A' }], edges: [] }))
    expect([...diff.added]).toEqual(['a'])
  })
})
