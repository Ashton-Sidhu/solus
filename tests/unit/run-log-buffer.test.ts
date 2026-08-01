import { describe, expect, test } from 'bun:test'
import type { RunLogLine } from '../../src/shared/types'
import { mergeRunLogBackfill } from '../../src/renderer/contexts/run/lib/run-log-buffer'

const line = (seq: number, ts = seq): RunLogLine => ({ seq, ts, level: 'info', text: `line ${seq}` })

describe('run log backfill merging', () => {
  test('fills history ahead of deltas that arrived during the RPC', () => {
    expect(mergeRunLogBackfill([line(0), line(1), line(2)], [line(2), line(3)]).map((item) => item.seq))
      .toEqual([0, 1, 2, 3])
  })

  test('does not revive a previous run after a live sequence restart', () => {
    const oldSnapshot = [line(0, 100), line(1, 110)]
    const restartedLive = [line(0, 200), line(1, 210)]
    expect(mergeRunLogBackfill(oldSnapshot, restartedLive)).toEqual(restartedLive)
  })

  test('retains only the newest configured window', () => {
    expect(mergeRunLogBackfill([line(0), line(1), line(2)], [], 2).map((item) => item.seq))
      .toEqual([1, 2])
  })
})
