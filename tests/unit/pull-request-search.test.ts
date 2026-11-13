import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PrFilter, PrListPage, PullRequest } from '@solus/contracts/providers'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
type PullRequestSearchModule = typeof import(
  '@solus/workspace-ui/components/session/unified-picker/lib/pull-request-search.svelte'
)
let PullRequestSearch: PullRequestSearchModule['PullRequestSearch']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ PullRequestSearch } = await import(
    '@solus/workspace-ui/components/session/unified-picker/lib/pull-request-search.svelte'
  ))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function pullRequest(number: number, title: string): PullRequest {
  return { number, title } as PullRequest
}

const page = (items: PullRequest[]): PrListPage => ({ items, page: 1, hasMore: false })
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/** Projects that record each question and answer from a function. */
function projects(answer: (projectRoot: string, filter: PrFilter) => Promise<PrListPage>) {
  const asked: Array<{ projectRoot: string; filter: PrFilter }> = []
  const project = (projectRoot: string) => ({
    serverId: 'laptop',
    projectRoot,
    label: projectRoot.slice(1),
    query: (filter: PrFilter) => {
      asked.push({ projectRoot, filter })
      return answer(projectRoot, filter)
    },
  })
  return { asked, project }
}

describe('the search reads pull requests', () => {
  test('an empty box reads the open list; a query asks the code host for every state', async () => {
    // WHY: the reader who opens the search wants what is open now. The reader
    // who types a title may want a pull request that is merged.
    const hosts = projects(async (projectRoot) => page([pullRequest(1, `in ${projectRoot}`)]))
    const search = new PullRequestSearch(0)
    search.search('', [hosts.project('/solus'), hosts.project('/site')])
    await settle()
    expect(hosts.asked).toEqual([{ projectRoot: '/solus', filter: { state: 'open' } }, { projectRoot: '/site', filter: { state: 'open' } }])
    expect(search.results.map((found) => [found.projectLabel, found.pullRequest.number])).toEqual([['solus', 1], ['site', 1]])
    search.search('retry', [hosts.project('/solus'), hosts.project('/site')])
    await settle()
    expect(hosts.asked.at(-1)?.filter).toEqual({ state: 'all', query: 'retry' })
  })

  test('only a full answer for the query in the box marks its rows as found by the host', async () => {
    // WHY: a row the host found is kept though its title lacks the words. The
    // open list is not such an answer, and neither is an answer for older words.
    const hosts = projects(async () => page([pullRequest(7, 'Refactor routing')]))
    const search = new PullRequestSearch(0)
    search.search('', [hosts.project('/solus')])
    await settle()
    expect(search.answers('')).toBe(false)
    search.search('websocket', [hosts.project('/solus')])
    expect(search.answers('websocket')).toBe(false)
    await settle()
    expect(search.answers('websocket')).toBe(true)
    expect(search.answers('websocket retry')).toBe(false)
  })

  test('a one-letter query does not ask the code host, and the same question is asked once', async () => {
    // WHY: one letter matches nearly every pull request the host holds, and
    // its search is rate limited. The open list is matched on this client.
    const hosts = projects(async () => page([]))
    const search = new PullRequestSearch(0)
    search.search('', [hosts.project('/solus')])
    await settle()
    search.search('w', [hosts.project('/solus')])
    search.search('', [hosts.project('/solus')])
    await settle()
    expect(hosts.asked).toHaveLength(1)
  })

  test('a reply for words the reader has left is dropped', async () => {
    let release: (answer: PrListPage) => void = () => {}
    const hosts = projects((_projectRoot, filter) => filter.query === 'slow'
      ? new Promise((resolve) => { release = resolve })
      : Promise.resolve(page([pullRequest(2, 'fast answer')])))
    const search = new PullRequestSearch(0)
    search.search('slow', [hosts.project('/solus')])
    await settle()
    search.search('fast', [hosts.project('/solus')])
    await settle()
    release(page([pullRequest(1, 'slow answer')]))
    await settle()
    expect(search.results.map((found) => found.pullRequest.title)).toEqual(['fast answer'])
    expect(search.answers('fast')).toBe(true)
  })

  test('a project that fails says so, and the other projects still answer', async () => {
    // WHY: an empty list must not claim there is nothing when a host did not answer.
    const hosts = projects(async (projectRoot) => {
      if (projectRoot === '/solus') throw new Error('GitHub is not connected')
      return page([pullRequest(4, 'Site')])
    })
    const search = new PullRequestSearch(0)
    search.search('', [hosts.project('/solus'), hosts.project('/site')])
    await settle()
    expect(search.results.map((found) => found.pullRequest.number)).toEqual([4])
    expect(search.error).toBe('GitHub is not connected')
    expect(search.loading).toBe(false)
  })

  test('with no project to read, the list is empty and nothing is asked', async () => {
    const search = new PullRequestSearch(0)
    search.search('anything', [])
    expect(search.loading).toBe(false)
    expect(search.results).toEqual([])
  })
})
