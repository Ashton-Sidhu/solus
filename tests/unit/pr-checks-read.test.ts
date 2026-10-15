import { describe, expect, mock, test } from 'bun:test'
import { localOwnerCtx } from './helpers/handler-ctx'
import { Database } from 'bun:sqlite'
import type { IpcContext } from '@solus/contracts/types'
import type { Provider } from '@solus/server/providers/types'
import type { RepoRef } from '@solus/contracts/providers'
import type { NumberedPrChecksSummary, PrChecksSnapshot } from '@solus/contracts/checks-rpc-types'
import { SolusServer } from '@solus/server/transport/server'

// The handler's default provider resolver reaches the production database
// module, which imports node:sqlite (absent under Bun's test runtime).
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { registerChecksHandlers } = await import('@solus/server/transport/handlers/checks-handlers')

/**
 * Check runs as a read. An open review pane's checks are kept fresh by PR
 * sync; this is the list's read of the rows it shows.
 */
describe('PR checks read', () => {
  test('a cold checks read only tracks pull requests named by the client', async () => {
    // WHY: repositories can have hundreds of open pull requests. An empty
    // request must not turn one visible page into dozens of GraphQL batches.
    const server = new SolusServer()
    const checkedNumbers: number[][] = []
    const provider = {
      review: {
        listChecks: async (_repo: RepoRef, numbers: number[]) => {
          checkedNumbers.push(numbers)
          return []
        },
      },
    } as unknown as Provider
    registerChecksHandlers(server, {
      resolveReviewTarget: async () => ({
        repo: { host: 'github.com', owner: 'owner', repo: 'scoped-cold-read' },
        provider,
      }),
    })

    await server.handle('prChecks', [{} as IpcContext, []], localOwnerCtx('local'))
    await server.handle('prChecks', [{} as IpcContext, [7, 9]], localOwnerCtx('local'))
    // A fresh answer that covers what is asked is shared, not read again.
    await server.handle('prChecks', [{} as IpcContext, [7]], localOwnerCtx('local'))

    expect(checkedNumbers).toEqual([[7, 9]])
  })

  test('an answer holds only the pull requests asked for, and a fresh one is not read again', async () => {
    // WHY: a phone opens one pull request and must not receive, or wait for,
    // the check runs of every pull request the host read before.
    const server = new SolusServer()
    const checkedNumbers: number[][] = []
    const summaryOf = (number: number): NumberedPrChecksSummary => ({
      number,
      summary: { state: 'passing', required: [], optional: [], headSha: `sha-${number}`, inFlight: false },
    })
    const provider = {
      review: {
        listChecks: async (_repo: RepoRef, numbers: number[]) => {
          checkedNumbers.push(numbers)
          return numbers.map(summaryOf)
        },
      },
    } as unknown as Provider
    registerChecksHandlers(server, {
      resolveReviewTarget: async () => ({
        repo: { host: 'github.com', owner: 'owner', repo: 'scoped-answer' },
        provider,
      }),
    })

    await server.handle('prChecks', [{} as IpcContext, [1, 2, 3]], localOwnerCtx('local'))
    const one = await server.handle('prChecks', [{} as IpcContext, [2]], localOwnerCtx('local')) as PrChecksSnapshot
    const more = await server.handle('prChecks', [{} as IpcContext, [3, 4]], localOwnerCtx('local')) as PrChecksSnapshot

    expect(one.checks.map((entry) => entry.number)).toEqual([2])
    expect(more.checks.map((entry) => entry.number)).toEqual([3, 4])
    // Only the number no read has named yet goes to the code host.
    expect(checkedNumbers).toEqual([[1, 2, 3], [4]])
  })

  test('reads of the same numbers at the same time share one call', async () => {
    const server = new SolusServer()
    const checkedNumbers: number[][] = []
    const provider = {
      review: {
        listChecks: async (_repo: RepoRef, numbers: number[]) => {
          checkedNumbers.push(numbers)
          return []
        },
      },
    } as unknown as Provider
    registerChecksHandlers(server, {
      resolveReviewTarget: async () => ({
        repo: { host: 'github.com', owner: 'owner', repo: 'shared-read' },
        provider,
      }),
    })

    await Promise.all([
      server.handle('prChecks', [{} as IpcContext, [5]], localOwnerCtx('local')),
      server.handle('prChecks', [{} as IpcContext, [5]], localOwnerCtx('local')),
    ])

    expect(checkedNumbers).toEqual([[5]])
  })

  test('a failed read says so and is tried again', async () => {
    const server = new SolusServer()
    let calls = 0
    const provider = {
      review: {
        listChecks: async () => {
          calls += 1
          if (calls === 1) throw new Error('GitHub is down')
          return []
        },
      },
    } as unknown as Provider
    registerChecksHandlers(server, {
      resolveReviewTarget: async () => ({
        repo: { host: 'github.com', owner: 'owner', repo: 'failed-read' },
        provider,
      }),
    })

    const failed = await server.handle('prChecks', [{} as IpcContext, [6]], localOwnerCtx('local')) as PrChecksSnapshot
    const retried = await server.handle('prChecks', [{} as IpcContext, [6]], localOwnerCtx('local')) as PrChecksSnapshot

    expect(failed.loadFailed).toBe(true)
    expect(retried.loadFailed).toBe(false)
    expect(calls).toBe(2)
  })

  test('the server holds the checks of a bounded number of repositories, and forgets the least recently read', async () => {
    // WHY: the cache lives as long as the server. A host whose clients read
    // many repositories over weeks must not keep every one of them.
    const server = new SolusServer()
    const reads: string[] = []
    let repo = ''
    const provider = {
      review: {
        listChecks: async (target: RepoRef, numbers: number[]) => {
          reads.push(target.repo)
          return numbers.map((number) => ({ number, summary: { state: 'passing', required: [], optional: [], headSha: 'sha', inFlight: false } }))
        },
      },
    } as unknown as Provider
    registerChecksHandlers(server, {
      resolveReviewTarget: async () => ({ repo: { host: 'github.com', owner: 'owner', repo }, provider }),
    })
    const read = async (name: string) => {
      repo = name
      await server.handle('prChecks', [{} as IpcContext, [1]], localOwnerCtx('local'))
    }

    await read('bounded-first')
    await read('bounded-kept')
    for (let index = 0; index < 63; index++) await read(`bounded-${index}`)
    // The kept repository was read again, so it is not the oldest.
    await read('bounded-kept')
    await read('bounded-last')
    reads.length = 0
    await read('bounded-kept')
    await read('bounded-first')

    // Both answers are younger than the stale time; only the forgotten one is read again.
    expect(reads).toEqual(['bounded-first'])
  })
})
