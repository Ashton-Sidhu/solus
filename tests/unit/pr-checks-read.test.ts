import { describe, expect, mock, test } from 'bun:test'
import { localOwnerCtx } from './helpers/handler-ctx'
import { Database } from 'bun:sqlite'
import type { IpcContext } from '@solus/contracts/types'
import type { Provider, RepoRef } from '@solus/server/providers/types'
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
})
