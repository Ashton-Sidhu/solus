import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { SearchSessionsRequest } from '@solus/contracts/rpc'
import type { SessionMeta, SessionSearchResult } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
type ConversationSearchModule = typeof import(
  '@solus/workspace-ui/components/session/unified-picker/lib/conversation-search.svelte'
)
let ConversationSearch: ConversationSearchModule['ConversationSearch']
let RESULTS_PER_HOST: ConversationSearchModule['RESULTS_PER_HOST']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ ConversationSearch, RESULTS_PER_HOST } = await import(
    '@solus/workspace-ui/components/session/unified-picker/lib/conversation-search.svelte'
  ))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function hit(sessionId: string, ts: number): SessionSearchResult {
  return { session: { sessionId } as SessionMeta, snippet: sessionId, ts, messageId: 1, rank: -1 }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('ConversationSearch', () => {
  test('asks every connected host, stamps each hit with its host, and orders by hit date', async () => {
    const requests: Array<{ serverId: string; request: SearchSessionsRequest }> = []
    const hosts = {
      connectedServerIds: () => ['local', 'laptop'],
      apiFor: (serverId: string) => ({
        searchSessions: async (request: SearchSessionsRequest) => {
          requests.push({ serverId, request })
          return serverId === 'local' ? [hit('old', 1), hit('newest', 9)] : [hit('mid', 5)]
        },
      }),
    }
    const search = new ConversationSearch(hosts, 0)
    search.search('rate limit', '/repo')
    expect(search.loading).toBe(true)
    await settle()

    expect(requests.map((entry) => entry.serverId)).toEqual(['local', 'laptop'])
    // The last word is a prefix: the user is still typing it.
    expect(requests[0].request).toMatchObject({
      query: 'rate limit',
      projectRoot: '/repo',
      prefixLastToken: true,
    })
    expect(search.results.map((result) => result.session.sessionId)).toEqual(['newest', 'mid', 'old'])
    expect(search.results.map((result) => result.session.serverId)).toEqual(['local', 'laptop', 'local'])
    expect(search.loading).toBe(false)
    search.search('different query', '/repo')
    expect(search.results).toEqual([])
    expect(search.capped).toBe(false)
    search.reset()
  })

  test('a reply to a query the user has left is dropped', async () => {
    // WHY: hosts answer at different speeds. Hits for "alpha" landing after
    // the box says "beta" would list sessions that mention words no longer
    // in the query.
    let release: (() => void) | null = null
    const hosts = {
      connectedServerIds: () => ['local'],
      apiFor: () => ({
        searchSessions: async (request: SearchSessionsRequest) => {
          if (request.query === 'alpha') {
            await new Promise<void>((resolve) => (release = resolve))
            return [hit('alpha-hit', 1)]
          }
          return [hit('beta-hit', 1)]
        },
      }),
    }
    const search = new ConversationSearch(hosts, 0)
    search.search('alpha', null)
    await settle()
    search.search('beta', null)
    await settle()
    release!()
    await settle()
    expect(search.results.map((result) => result.session.sessionId)).toEqual(['beta-hit'])
  })

  test('a host that fails contributes nothing and does not hide the others', async () => {
    const hosts = {
      connectedServerIds: () => ['broken', 'local'],
      apiFor: (serverId: string) => ({
        searchSessions: async () => {
          if (serverId === 'broken') throw new Error('offline')
          return [hit('found', 1)]
        },
      }),
    }
    const search = new ConversationSearch(hosts, 0)
    search.search('anything', null)
    await settle()
    expect(search.results.map((result) => result.session.sessionId)).toEqual(['found'])
    expect(search.loading).toBe(false)
  })

  test('a host that fills its cap marks the list as capped, and clearing the query clears that too', async () => {
    // WHY: the picker counts what it lists. When a host stopped at its cap the
    // count is a floor, and the list has to say so rather than pass twenty rows
    // off as twenty hits.
    const full = Array.from({ length: RESULTS_PER_HOST }, (_, index) => hit(`s-${index}`, index))
    const hosts = {
      connectedServerIds: () => ['full', 'sparse'],
      apiFor: (serverId: string) => ({
        searchSessions: async () => (serverId === 'full' ? full : [hit('one', 1)]),
      }),
    }
    const search = new ConversationSearch(hosts, 0)
    search.search('word', null)
    await settle()
    expect(search.capped).toBe(true)
    search.search('', null)
    expect(search.capped).toBe(false)
  })

  test('clearing the query clears the hits at once, without asking a host', async () => {
    let asked = 0
    const hosts = {
      connectedServerIds: () => ['local'],
      apiFor: () => ({
        searchSessions: async () => {
          asked += 1
          return [hit('found', 1)]
        },
      }),
    }
    const search = new ConversationSearch(hosts, 0)
    search.search('word', null)
    await settle()
    expect(search.results).toHaveLength(1)
    search.search('  ', null)
    expect(search.results).toEqual([])
    expect(search.loading).toBe(false)
    await settle()
    expect(asked).toBe(1)
  })
})
