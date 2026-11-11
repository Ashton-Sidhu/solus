import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { RestPrefetch, REST_PREFETCH_MS } from '@solus/workspace-ui/components/prs/lib/pr-rest-prefetch'

// A row the pointer or the highlight rests on is read before it is opened, so
// the click opens a panel that already has its detail. A rest costs one host
// read, so passing over rows or walking the list with the arrow keys must
// read nothing.

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe('rest prefetch on pull request rows', () => {
  test('a rest reads the row once', () => {
    const reads: number[] = []
    const prefetch = new RestPrefetch<number>((row) => reads.push(row))

    prefetch.rest(7)
    jest.advanceTimersByTime(REST_PREFETCH_MS - 1)
    expect(reads).toEqual([])
    // The pointer moving inside the same row does not start the wait again.
    prefetch.rest(7)
    jest.advanceTimersByTime(1)
    expect(reads).toEqual([7])
  })

  test('passing over rows reads only the row the pointer stops on', () => {
    const reads: number[] = []
    const prefetch = new RestPrefetch<number>((row) => reads.push(row))

    for (const row of [1, 2, 3, 4]) {
      prefetch.rest(row)
      jest.advanceTimersByTime(40)
    }
    jest.advanceTimersByTime(REST_PREFETCH_MS)
    expect(reads).toEqual([4])
  })

  test('leaving a row before the rest is long enough reads nothing', () => {
    const reads: number[] = []
    const prefetch = new RestPrefetch<number>((row) => reads.push(row))

    prefetch.rest(5)
    jest.advanceTimersByTime(100)
    prefetch.leave(5)
    // Leaving another row does not cancel the row that waits.
    prefetch.rest(6)
    prefetch.leave(5)
    jest.advanceTimersByTime(REST_PREFETCH_MS)
    expect(reads).toEqual([6])
  })
})
