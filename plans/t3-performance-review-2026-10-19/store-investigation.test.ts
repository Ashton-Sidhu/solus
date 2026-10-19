import { test, expect } from 'bun:test'
import { HostFacts } from '../../packages/client-core/src/host-facts'
import { HostEventSubscriber } from '../../packages/client-core/src/host-event-subscriber'
import { asHostApi } from '../../packages/client-core/src/host-api'
import { ThreadDirectory } from '../../apps/mobile/src/features/threads/thread-directory'
import { HostReads, shownValue, type LoadState } from '../../apps/mobile/src/features/prs/pull-request-reads'
import { PullRequestCache, memoryPullRequestCacheDatabase } from '../../apps/mobile/src/features/prs/pull-request-cache'
import { Listeners } from '../../apps/mobile/src/lib/listeners'
import { FakeApi } from '../../tests/unit/helpers/native-mobile-fakes'
import { hostWorld, project, pullRequest } from '../../tests/unit/helpers/native-mobile-prs-fixtures'
import { PullRequestDirectory } from '../../apps/mobile/src/features/prs/pull-request-directory'
import { linkedPrIdentity } from '../../packages/workspace-ui/src/contexts/prs/linked-pr'

// Characterization probes for this audit. These assert current behavior,
// not the desired behavior of a future implementation. No real hosts or data.
test('count equal HostFacts refresh and reconnect notifications', async () => {
  let calls = 0
  const facts = new HostFacts('fixture', {
    events: new HostEventSubscriber(),
    api: asHostApi({ serverGetCapabilities: async () => ({}), usageLimits: async () => { calls++; return [] } }),
  })
  let notifications = 0
  facts.subscribe(key => { if (key === 'usage') notifications++ })
  await facts.refresh('usage')
  const before = facts.get('usage')
  await facts.refresh('usage')
  const after = facts.get('usage')
  expect(after).toEqual(before)
  expect(after).not.toBe(before)
  expect(notifications).toBe(2)
  facts.sessionChanged('recovered')
  expect(calls).toBe(2)
  facts.sessionChanged('fresh')
  await facts.when('usage')
  expect(calls).toBe(3)
  expect(notifications).toBe(3)
  console.log(JSON.stringify({ probe: 'host-facts', equalRefreshNotifications: 1, equalRefreshWrapperRetained: after === before, recoveredExtraReads: 0, freshExtraReads: 1, freshExtraNotifications: 1 }))
  facts.dispose()
})

test('count project snapshot changes during an equal thread directory refresh', async () => {
  const api = new FakeApi().on('sessionRecordList', () => ({ records: [], indexing: false }))
    .on('listProjects', () => [project('/work/app', 'github.com/o/r')])
  const world = await hostWorld(api, { connected: true })
  const directory = new ThreadDirectory(world.registry, id => world.connections.connection(id))
  await directory.load('inst-a')
  const before = directory.projects()
  let arrayChanges = 0
  let previous = before
  const stop = directory.changes.subscribe(() => {
    const current = directory.projects()
    if (current !== previous) arrayChanges++
    previous = current
  })
  await directory.load('inst-a')
  expect(directory.projects()).toEqual(before)
  expect(directory.projects()).not.toBe(before)
  expect(directory.projects()[0]).not.toBe(before[0])
  expect(arrayChanges).toBe(2)
  console.log(JSON.stringify({ probe: 'thread-directory', equalRefreshProjectArrayChanges: arrayChanges, equalProjectWrapperRetained: false, loadingAndLoadedStatesPreserved: true }))
  stop()
  world.connections.dispose()
})

test('count PR state changes separately from displayed value changes', async () => {
  const world = await hostWorld(new FakeApi(), { connected: true })
  const changes = new Listeners()
  const reads = new HostReads(changes, id => world.connections.connection(id), new PullRequestCache(memoryPullRequestCacheDatabase()))
  interface Answer { title: string; labels: string[] }
  const map = new Map<string, LoadState<Answer>>()
  const run = async (): Promise<Answer> => ({ title: 'Fixture PR', labels: ['test'] })
  await reads.read(map, 'inst-a\0detail', 'inst-a', 'detail', run)
  let stateChanges = 0
  let valueChanges = 0
  let previous = shownValue(map.get('inst-a\0detail')!)
  const stop = changes.subscribe(() => {
    stateChanges++
    const next = shownValue(map.get('inst-a\0detail')!)
    if (next !== previous) valueChanges++
    previous = next
  })
  await reads.read(map, 'inst-a\0detail', 'inst-a', 'detail', run)
  expect(stateChanges).toBe(2)
  expect(valueChanges).toBe(1)
  console.log(JSON.stringify({ probe: 'pr-reads', equalRefetchStateChanges: stateChanges, equalRefetchDisplayedValueChanges: valueChanges }))
  stop()
  world.connections.dispose()
})

test('measure linked PR identity cost and verify live fields remain visible', () => {
  const links = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, url: `https://github.com/example/repo/pull/${i + 1}`, title: `PR ${i + 1}` }))
  let checksum = 0
  for (let i = 0; i < 10000; i++) checksum += linkedPrIdentity(links[i % links.length], '/fixture')!.number
  const samples: number[] = []
  for (let round = 0; round < 9; round++) {
    const start = performance.now()
    for (let i = 0; i < 10000; i++) checksum += linkedPrIdentity(links[i % links.length], '/fixture')!.number
    samples.push((performance.now() - start) / 100)
  }
  links[0].url = 'https://github.com/example/other/pull/999'
  links[0].title = 'Changed title'
  expect(linkedPrIdentity(links[0], '/fixture')).toMatchObject({ number: 999, targetScope: 'github.com/example/other', title: 'Changed title' })
  const fallback = { number: 1 }
  expect(linkedPrIdentity(fallback, '/first')?.targetScope).toBe('/first')
  expect(linkedPrIdentity(fallback, '/second')?.targetScope).toBe('/second')
  samples.sort((a, b) => a - b)
  console.log(JSON.stringify({ probe: 'linked-pr', linksPerPass: 100, medianMillisecondsPerPass: samples[4], minimumMillisecondsPerPass: samples[0], maximumMillisecondsPerPass: samples[8], checksum, benchmark: 'synthetic Bun on host; not a renderer profile' }))
})

test('measure equal PR list refresh through the real directory', async () => {
  const api = new FakeApi()
    .on('listProjects', () => [project('/work/app', 'github.com/o/r')])
    .on('prListProjects', () => [{ projectRoot: '/work/app', page: { items: [pullRequest(7)], page: 1, hasMore: false } }])
    .on('providerViewer', () => ({ login: 'fixture-viewer' }))
  const world = await hostWorld(api, { connected: true })
  const directory = new PullRequestDirectory(id => world.connections.connection(id), () => null)
  await directory.loadHost('inst-a')
  const before = shownValue(directory.hostOf('inst-a'))!
  const firstProject = before.projects[0]!
  if (firstProject.kind !== 'page') throw new Error('Expected fixture page')
  const oldPr = firstProject.prs[0]
  let notifications = 0
  const stop = directory.changes.subscribe(() => { notifications++ })
  await directory.loadHost('inst-a')
  const after = shownValue(directory.hostOf('inst-a'))!
  expect(after).toEqual(before)
  const finalProject = after.projects[0]!
  if (finalProject.kind !== 'page') throw new Error('Expected fixture page')
  expect(finalProject.prs[0]).not.toBe(oldPr)
  expect(notifications).toBe(3)
  console.log(JSON.stringify({ probe: 'pr-directory', equalListRefreshNotifications: notifications, equalListValueRetained: after === before, equalPrObjectRetained: finalProject.prs[0] === oldPr }))
  stop()
  world.connections.dispose()
})
