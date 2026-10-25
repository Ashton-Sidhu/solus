import { afterAll, beforeAll, expect, jest, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { PullRequest, RepoRef } from '@solus/contracts/providers'
import type { Provider } from '@solus/server/providers/types'
import { pullRequestFixture } from './__fixtures__/pull-request'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

/**
 * PR sync's clock (docs/plans/pr-sync.md §3.2). It runs only while something
 * is wanted, and wakes when a repository is due. Its own file, because the
 * other PR sync tests share a database full of interest.
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

let dataDir: string
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-pr-sync-clock-'))
  process.env.SOLUS_DATA_DIR = dataDir
})

afterAll(async () => {
  jest.useRealTimers()
  ;(await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

actAsHostForTests()

/** Let the tick a timer started run to its end. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

test('with nothing wanted no clock runs; a link or a client wakes it, and its interest arms it', async () => {
  // WHY: the clock ran every 5 seconds forever, and each run read the
  // database, also on a host where nothing had a pull request.
  const { PrSync } = await import('@solus/server/prs/pr-sync')
  const taskStore = await import('@solus/server/data/tasks/task-store')
  const repo: RepoRef = { host: 'github.com', owner: 'owner', repo: 'clock' }
  const numberReads: number[][] = []
  const provider = { review: {
    getPullRequests: async (_repo: RepoRef, numbers: number[]) => {
      numberReads.push(numbers)
      return new Map<number, PullRequest>(numbers.map((number) => [number, pullRequestFixture(number, { baseRepo: repo })]))
    },
  } } as unknown as Provider
  let interestReads = 0
  const sync = new PrSync({
    publish: () => {},
    // No link names a code host, so live work wants nothing.
    codeHost: async () => null,
    liveCheckouts: async () => {
      interestReads += 1
      return []
    },
  })
  jest.useFakeTimers()
  try {
    sync.start()
    jest.advanceTimersByTime(5_000)
    await settle()
    expect(interestReads).toBe(1)

    jest.advanceTimersByTime(60 * 60_000)
    await settle()
    expect(interestReads).toBe(1)

    // A new task can be the first interest: it is read at once.
    await taskStore.createTask('local', { title: 'New work', status: 'todo' })
    await settle()
    expect(interestReads).toBe(2)

    // A client's interest is read now, and then on the repository's cadence.
    sync.setInterest('client', { repo, provider }, [{ kind: 'pull-request', number: 4 }])
    await settle()
    expect(numberReads).toEqual([[4]])
    jest.advanceTimersByTime(60_000)
    await settle()
    expect(numberReads).toEqual([[4], [4]])

    // When it goes away, the clock stops at its next run.
    sync.dropConnection('client')
    jest.advanceTimersByTime(60_000)
    await settle()
    const reads = interestReads
    jest.advanceTimersByTime(60 * 60_000)
    await settle()
    expect(interestReads).toBe(reads)
    expect(numberReads).toHaveLength(2)
  } finally {
    sync.stop()
    jest.useRealTimers()
  }
})
