import { expect, test } from 'bun:test'
import {
  PullRequestListMetadata,
  prMetadataKey
} from '../../apps/mobile/src/features/prs/pull-request-list-metadata'
import type { PullRequestRow } from '../../apps/mobile/src/features/prs/lib/pull-request-list'
import type { ReviewGuideStatusEvent } from '@solus/contracts/review'
import { pullRequestFixture } from './__fixtures__/pull-request'
import { deferred, hostWorld } from './helpers/native-mobile-prs-fixtures'
import { FakeApi } from './helpers/native-mobile-fakes'
const row = (number: number): PullRequestRow => ({
  hostId: 'inst-a',
  projectPath: '/work/repo',
  folderName: 'repo',
  pr: pullRequestFixture(number),
  checks: null
})

test('saved review records use bounded project batches and survive replacement row objects', async () => {
  const api = new FakeApi()
    .on('prGuideStatuses', (_ctx, requests: unknown[]) => requests.map(() => null))
    .on('prLensRevisions', (_ctx, targets: unknown[]) => targets.map(() => 1))
  const world = await hostWorld(api, { connected: true })
  const metadata = new PullRequestListMetadata(
    (id) => world.connections.connection(id),
    () => 'org-a'
  )
  const rows = Array.from({ length: 101 }, (_, index) => row(index + 1))
  await metadata.load(rows)
  expect(api.callsOf('prLensRevisions').map((args) => (args[1] as unknown[]).length)).toEqual([
    100, 1
  ])
  expect(metadata.current().values.get(prMetadataKey(row(1)))).toEqual({ guide: false, lens: true })
  const pushed = row(1)
  pushed.pr.headSha = 'new-head'
  expect(metadata.current().values.has(prMetadataKey(pushed))).toBe(false)
  expect(api.callsOf('prGuideStatuses')[0]![0]).toMatchObject({
    session: { organizationId: 'org-a', projectPath: '/work/repo' }
  })
})

test('account reset rejects an old metadata read, and read failure clears pending for Retry', async () => {
  const late = deferred<(ReviewGuideStatusEvent | null)[]>()
  let fail = false
  const api = new FakeApi()
    .on('prGuideStatuses', async () => {
      if (fail) throw new Error('offline')
      return late.promise
    })
    .on('prLensRevisions', () => [1])
  const world = await hostWorld(api, { connected: true })
  const metadata = new PullRequestListMetadata(
    (id) => world.connections.connection(id),
    () => null
  )
  const reading = metadata.load([row(1)])
  metadata.reset()
  late.resolve([null])
  await reading
  expect(metadata.current().values.size).toBe(0)
  fail = true
  await metadata.load([row(1)])
  expect(metadata.current()).toMatchObject({ pending: false, error: 'offline' })
  fail = false
  await metadata.load([row(1)])
  expect(metadata.current().error).toBeNull()
})

test('a failed review-record refresh keeps known matches available with an error', async () => {
  let fail = false
  const api = new FakeApi()
    .on('prGuideStatuses', () => {
      if (fail) throw new Error('disconnected')
      return [null]
    })
    .on('prLensRevisions', () => [1])
  const world = await hostWorld(api, { connected: true })
  const metadata = new PullRequestListMetadata(
    (id) => world.connections.connection(id),
    () => null
  )
  await metadata.load([row(1)])
  fail = true
  await metadata.load([row(1)])
  expect(metadata.current().values.get(prMetadataKey(row(1)))?.lens).toBe(true)
  expect(metadata.current().error).toBe('disconnected')
})
