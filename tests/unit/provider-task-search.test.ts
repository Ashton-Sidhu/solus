import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from 'bun:test'
import {
  ProviderTaskSearch,
  searchableProjectRoot,
  tasksOnlyFound,
} from '@solus/workspace-ui/lib/provider-task-search.svelte'

interface Found { id: string }

/** Lets the pending promise callbacks run. */
const settle = async () => { for (let turn = 0; turn < 4; turn++) await Promise.resolve() }

// The search holds plain values here: the rules under test are about which
// query is asked and which answer is kept, not about reactivity.
const runes = globalThis as unknown as { $state?: unknown }
const previousState = runes.$state
beforeAll(() => { runes.$state = Object.assign(<T>(value: T) => value, { raw: <T>(value: T) => value }) })
afterAll(() => { runes.$state = previousState })

describe('a task picker search on the provider', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.useRealTimers() })

  test('asks one time after the person stops typing', async () => {
    // WHY: each search is a provider call with a rate limit. A call for each
    // key press spends the limit on queries nobody wanted.
    const asked: string[] = []
    const search = new ProviderTaskSearch<Found>(() => async (query) => { asked.push(query); return [{ id: query }] })
    search.request('au')
    search.request('auth')
    expect(search.searching).toBe(true)
    jest.advanceTimersByTime(1_000)
    await settle()
    expect(asked).toEqual(['auth'])
    expect(search.results).toEqual([{ id: 'auth' }])
    expect(search.searching).toBe(false)
  })

  test('an older answer never replaces the answer of the newer query', async () => {
    // WHY: provider answers arrive out of order. The list must show the tasks
    // for the text in the box.
    const answers = new Map<string, (found: Found[]) => void>()
    const search = new ProviderTaskSearch<Found>(() => (query) => new Promise((resolve) => { answers.set(query, resolve) }))
    search.request('old query')
    jest.advanceTimersByTime(1_000)
    search.request('new query')
    jest.advanceTimersByTime(1_000)
    answers.get('new query')?.([{ id: 'new' }])
    answers.get('old query')?.([{ id: 'old' }])
    await settle()
    expect(search.results).toEqual([{ id: 'new' }])
  })

  test('a short or empty query clears the results and asks nothing', async () => {
    let calls = 0
    const search = new ProviderTaskSearch<Found>(() => async () => { calls++; return [{ id: 'found' }] })
    search.request('auth')
    jest.advanceTimersByTime(1_000)
    await settle()
    search.request('a')
    jest.advanceTimersByTime(1_000)
    await settle()
    expect(calls).toBe(1)
    expect(search.results).toEqual([])
    expect(search.searching).toBe(false)
  })

  test('a failed search says why and shows no stale task', async () => {
    const search = new ProviderTaskSearch<Found>(() => async () => { throw new Error('GitHub is not connected') })
    search.request('auth')
    jest.advanceTimersByTime(1_000)
    await settle()
    expect(search.error).toBe('GitHub is not connected')
    expect(search.results).toEqual([])
    expect(search.searching).toBe(false)
  })

  test('asks nothing where there is no project to search', () => {
    const search = new ProviderTaskSearch<Found>(() => null)
    search.request('auth')
    expect(search.searching).toBe(false)
  })
})

describe('what a task picker adds from a provider search', () => {
  test('a task the picker lists already shows one time', () => {
    expect(tasksOnlyFound([{ id: 'github:1' }, { id: 'github:2' }], [{ id: 'github:1' }])).toEqual([{ id: 'github:2' }])
  })

  test('a session with no folder has no project to search', () => {
    expect(searchableProjectRoot('~')).toBeNull()
    expect(searchableProjectRoot(null)).toBeNull()
    expect(searchableProjectRoot('/workspace/app')).toBe('/workspace/app')
  })
})
