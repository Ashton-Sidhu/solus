import { describe, expect, test } from 'bun:test'
import {
  memoryPullRequestCacheDatabase, prunedCacheKeys, PullRequestCache, PULL_REQUEST_CACHE_LIMITS, utf8Length,
} from '../../apps/mobile/src/features/prs/pull-request-cache'
import { PullRequestDirectory } from '../../apps/mobile/src/features/prs/pull-request-directory'
import { FakeApi, flushPromises } from './helpers/native-mobile-fakes'
import { detailApi, hostWorld, PR_REF, pullRequest } from './helpers/native-mobile-prs-fixtures'

// A pull request read once stays readable when the host cannot be reached,
// and the device copy stays bounded so a phone's storage is never filled by
// it: 30 days, 256 records, 32 MiB for each host, nothing over 4 MiB.

const DAY = 24 * 60 * 60_000
const MiB = 1024 * 1024

describe('pull request cache bounds (ported from T3 mobile-database saveCache)', () => {
  test('keeps the newest records within the record, byte, and age limits', () => {
    const now = 100 * DAY
    const entries = Array.from({ length: 260 }, (_, index) => ({ key: `k${index}`, bytes: 10, updatedAt: now - index }))
    expect(prunedCacheKeys(entries, now)).toEqual(['k256', 'k257', 'k258', 'k259'])
    const large = [{ key: 'new', bytes: 20 * MiB, updatedAt: now }, { key: 'mid', bytes: 10 * MiB, updatedAt: now - 1 }, { key: 'old', bytes: 3 * MiB, updatedAt: now - 2 }]
    expect(prunedCacheKeys(large, now)).toEqual(['old'])
    expect(prunedCacheKeys([{ key: 'aged', bytes: 1, updatedAt: now - 31 * DAY }, { key: 'fresh', bytes: 1, updatedAt: now - 29 * DAY }], now)).toEqual(['aged'])
  })

  test('counts payload bytes as UTF-8', () => {
    expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4)
  })

  test('a response over 4 MiB is not kept, and does not push others out', async () => {
    const cache = new PullRequestCache(memoryPullRequestCacheDatabase())
    await cache.write('h', 'small', { a: 1 })
    await cache.write('h', 'huge', 'x'.repeat(PULL_REQUEST_CACHE_LIMITS.maxRecordBytes))
    expect(await cache.read('h', 'huge')).toBeNull()
    expect(await cache.read('h', 'small')).toEqual({ a: 1 })
  })

  test('a record older than 30 days is not read, and a write prunes each host on its own', async () => {
    let now = 0
    const database = memoryPullRequestCacheDatabase()
    const cache = new PullRequestCache(database, () => now)
    await cache.write('h', 'old', 1)
    await cache.write('other', 'old', 1)
    now = 31 * DAY
    expect(await cache.read('h', 'old')).toBeNull()
    await cache.write('h', 'new', 2)
    expect((await database.entries('response', 'h')).map((entry) => entry.key)).toEqual(['v1:new'])
    expect(await database.entries('response', 'other')).toHaveLength(1)
  })

  test('drafts are not bounded, and forgetting a host removes everything it kept', async () => {
    let now = 0
    const cache = new PullRequestCache(memoryPullRequestCacheDatabase(), () => now)
    await cache.writeDraft('h', 'draft', { summary: 'keep' })
    now = 365 * DAY
    for (let index = 0; index < 300; index += 1) await cache.write('h', `r${index}`, index)
    expect(await cache.readDraft('h', 'draft')).toEqual({ summary: 'keep' })
    await cache.forgetHost('h')
    expect(await cache.readDraft('h', 'draft')).toBeNull()
    expect(await cache.read('h', 'r299')).toBeNull()
  })

  test('a database that fails never fails a read', async () => {
    const broken = { ...memoryPullRequestCacheDatabase(), get: async () => { throw new Error('disk') }, put: async () => { throw new Error('disk') } }
    const cache = new PullRequestCache(broken)
    await cache.write('h', 'k', 1)
    expect(await cache.read('h', 'k')).toBeNull()
  })
})

describe('offline reading', () => {
  test('a pull request read once shows its device copy when the host is not reachable', async () => {
    const cache = new PullRequestCache(memoryPullRequestCacheDatabase())
    let reachable = true
    const api = detailApi(new FakeApi(), () => {
      if (!reachable) throw new Error('socket closed')
      return pullRequest(7, { title: 'Kept' })
    })
    const online = await hostWorld(api, { connected: true })
    await new PullRequestDirectory((hostId) => online.connections.connection(hostId), () => null, cache).loadDetail(PR_REF)
    await flushPromises()

    // A new app run: nothing in memory, the host does not answer.
    reachable = false
    const offline = await hostWorld(api)
    const directory = new PullRequestDirectory((hostId) => offline.connections.connection(hostId), () => null, cache)
    const states: string[] = []
    directory.changes.subscribe(() => states.push(directory.detailOf(PR_REF).kind))
    await directory.loadDetail(PR_REF)
    const state = directory.detailOf(PR_REF)
    expect(states[0]).toBe('loading')
    expect(state.kind === 'error' && [state.offline, state.previous?.overview.pullRequest.title]).toEqual([true, 'Kept'])

    // A host this device cannot dial at all still shows the copy.
    const unknown = new PullRequestDirectory(() => null, () => null, cache)
    await unknown.loadDetail(PR_REF)
    const unreachable = unknown.detailOf(PR_REF)
    expect(unreachable.kind === 'error' && [unreachable.message, unreachable.previous?.overview.pullRequest.title]).toEqual(['This host cannot be reached now.', 'Kept'])
  })

  test('the loading state shows the device copy while the first read runs', async () => {
    const cache = new PullRequestCache(memoryPullRequestCacheDatabase())
    await cache.write('inst-a', `detail:${PR_REF.projectPath}:${PR_REF.number}`, { overview: { pullRequest: pullRequest(7, { title: 'Kept' }), commits: [], reviewers: [] }, comments: [], threads: [], files: [], checks: null, stack: null, missing: [] })
    // WHY: the device copy is read beside the host, not before it, so a slow
    // host shows the copy and a fast one is not held back by the copy.
    let answerHost: () => void = () => {}
    const hostAnswers = new Promise<void>((resolve) => { answerHost = resolve })
    const api = detailApi(new FakeApi()).on('prGetOverview', async () => {
      await hostAnswers
      return { pullRequest: pullRequest(7), commits: [], reviewers: [] }
    })
    const world = await hostWorld(api, { connected: true })
    const directory = new PullRequestDirectory((hostId) => world.connections.connection(hostId), () => null, cache)
    const read = directory.loadDetail(PR_REF)
    await flushPromises()
    const loading = directory.detailOf(PR_REF)
    expect(loading.kind).toBe('loading')
    expect(loading.kind === 'loading' && loading.previous?.overview.pullRequest.title).toBe('Kept')
    expect(api.callsOf('prGetOverview')).toHaveLength(1)
    answerHost()
    await read
    const loaded = directory.detailOf(PR_REF)
    expect(loaded.kind === 'loaded' && loaded.value.overview.pullRequest.title).toBe('PR 7')
  })
})
