import { describe, expect, test } from 'bun:test'
import type { TurnSnapshot } from '@solus/contracts/git-types'
import { turnSnapshotFor } from '@solus/workspace-ui/components/conversation/lib/turn-snapshot'
import type { Turn } from '@solus/workspace-ui/components/conversation/lib/turns'

function turn(startedAt: number, lead: 'user' | 'system' = 'user', live = false): Turn {
  return {
    id: `turn-${startedAt}`,
    lead: { kind: lead, message: { id: `m-${startedAt}`, role: lead, content: '', timestamp: startedAt } } as Turn['lead'],
    body: [],
    visibleWhenCollapsed: [],
    tail: [],
    images: [],
    tools: [],
    live,
    end: null,
    startedAt,
  }
}

function snapshot(index: number, timestamp: number): TurnSnapshot {
  return {
    index,
    fromTreeSha: 'a',
    toTreeSha: 'b',
    sha: 'c',
    timestamp,
    partial: false,
    userMessagePreview: '',
    filesChanged: 1,
    additions: 1,
    deletions: 0,
  }
}

describe('turnSnapshotFor', () => {
  test('a settled turn keeps its own snapshot after the next prompt lands', () => {
    const turns = [turn(100), turn(300), turn(500, 'user', true)]
    const snapshots = [snapshot(0, 200), snapshot(1, 400)]

    expect(turnSnapshotFor(turns, 0, snapshots)?.index).toBe(0)
    expect(turnSnapshotFor(turns, 1, snapshots)?.index).toBe(1)
  })

  test('a live turn shows no card until its own snapshot exists', () => {
    const turns = [turn(100), turn(300, 'user', true)]
    expect(turnSnapshotFor(turns, 1, [snapshot(0, 200)])).toBeUndefined()
  })

  test('a turn that wrote no snapshot does not borrow a neighbour', () => {
    const turns = [turn(100), turn(300), turn(500)]
    const snapshots = [snapshot(0, 200), snapshot(1, 600)]

    expect(turnSnapshotFor(turns, 1, snapshots)).toBeUndefined()
    expect(turnSnapshotFor(turns, 2, snapshots)?.index).toBe(1)
  })

  test('a divider between two prompts does not take the earlier turn snapshot', () => {
    const turns = [turn(100), turn(150, 'system'), turn(300)]
    const snapshots = [snapshot(0, 200)]

    expect(turnSnapshotFor(turns, 0, snapshots)?.index).toBe(0)
    expect(turnSnapshotFor(turns, 1, snapshots)).toBeUndefined()
  })

  test('a retried turn shows its last snapshot', () => {
    const turns = [turn(100)]
    expect(turnSnapshotFor(turns, 0, [snapshot(0, 200), snapshot(1, 250)])?.index).toBe(1)
  })

  test('with the setting off, only the latest turn shows its card', () => {
    const turns = [turn(100), turn(300)]
    const snapshots = [snapshot(0, 200), snapshot(1, 400)]

    expect(turnSnapshotFor(turns, 0, snapshots, true)).toBeUndefined()
    expect(turnSnapshotFor(turns, 1, snapshots, true)?.index).toBe(1)
  })

  test('with the setting off, the card steps aside when the next prompt lands', () => {
    const turns = [turn(100), turn(300, 'user', true)]
    const snapshots = [snapshot(0, 200)]

    expect(turnSnapshotFor(turns, 0, snapshots, true)).toBeUndefined()
    expect(turnSnapshotFor(turns, 1, snapshots, true)).toBeUndefined()
  })
})
