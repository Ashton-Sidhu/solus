import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BUNDLED_MODEL_PROFILES,
  MODEL_PROFILES,
  providerModelsFor,
  replaceModelProfiles,
  type ModelProfile,
  type ModelProfiles,
  type ModelProfilesStatus,
} from '@solus/contracts/types'
import { ModelProfilesService, downloadModelProfiles } from '@solus/server/updates/model-profiles-service'
import { nextDailyRunAt, previousDailyRunAt } from '@solus/server/updates/daily-schedule'

const NEW_YORK = 'America/New_York'
const services: ModelProfilesService[] = []
const directories: string[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  // MODEL_PROFILES is process state: every test starts from the build's list.
  replaceModelProfiles(BUNDLED_MODEL_PROFILES)
})

const sonnet: ModelProfile = {
  label: 'Sonnet Next', reasoningLevels: ['low', 'medium', 'high'], defaultReasoningEffort: 'high',
  supportsFastMode: false, contextWindows: [1_000_000], defaultContextWindow: 1_000_000,
}

/** The bundled list with one model GitHub published after this build. */
function publishedList(): ModelProfiles {
  const list = structuredClone(BUNDLED_MODEL_PROFILES)
  list['claude-code'] = { 'claude-sonnet-next': structuredClone(sonnet), ...list['claude-code'] }
  return list
}

function fixture(options: { now: number; download: () => Promise<unknown>; cache?: unknown }) {
  const directory = mkdtempSync(join(tmpdir(), 'solus-model-profiles-'))
  directories.push(directory)
  const cachePath = join(directory, 'model-profiles.json')
  if (options.cache !== undefined) writeFileSync(cachePath, JSON.stringify(options.cache))
  const published: ModelProfilesStatus[] = []
  let downloads = 0
  const service = new ModelProfilesService({
    cachePath,
    now: () => options.now,
    download: () => { downloads += 1; return options.download() },
    publish: (status) => { published.push(status) },
  })
  services.push(service)
  return { service, cachePath, published, downloads: () => downloads }
}

test('the daily check runs at 15:00 New York time through daylight saving time', () => {
  // WHY: "3 PM Eastern" is a wall-clock promise. A fixed UTC hour would be an hour
  // off for half of every year.
  const summer = Date.UTC(2026, 6, 1, 12) // 08:00 EDT
  expect(new Date(nextDailyRunAt(summer, 15, NEW_YORK)).toISOString()).toBe('2026-07-01T19:00:00.000Z')
  expect(new Date(previousDailyRunAt(summer, 15, NEW_YORK)).toISOString()).toBe('2026-06-30T19:00:00.000Z')
  const winter = Date.UTC(2026, 0, 31, 21) // 16:00 EST on the last day of a month
  expect(new Date(previousDailyRunAt(winter, 15, NEW_YORK)).toISOString()).toBe('2026-01-31T20:00:00.000Z')
  expect(new Date(nextDailyRunAt(winter, 15, NEW_YORK)).toISOString()).toBe('2026-02-01T20:00:00.000Z')
})

test('a published model reaches every reader of MODEL_PROFILES without a new build', async () => {
  // WHY: this is the feature. The agent backends hold `MODEL_PROFILES['claude-code']`
  // from import time, so the list must change in place, and the host keeps the
  // download so a restart without a network still offers the model.
  const heldAtImport = MODEL_PROFILES['claude-code']!
  const { service, cachePath, published } = fixture({ now: Date.UTC(2026, 8, 28, 20), download: async () => publishedList() })
  const status = await service.check()
  expect(status).toMatchObject({ source: 'remote', error: null, checking: false })
  expect(heldAtImport['claude-sonnet-next']?.label).toBe('Sonnet Next')
  expect(providerModelsFor('claude-code').models[0]).toEqual({ id: 'claude-sonnet-next', label: 'Sonnet Next' })
  expect(published.at(-1)?.source).toBe('remote')
  expect(JSON.parse(readFileSync(cachePath, 'utf8')).profiles['claude-code']['claude-sonnet-next'].label).toBe('Sonnet Next')
})

test('a list this build cannot read is refused and the list in effect stays', async () => {
  // WHY: a newer Solus may publish a field or effort level this build does not
  // know. Offering a half-read model would fail the turn; keeping the old list does not.
  const unreadable = publishedList()
  // @ts-expect-error an effort level from a future build
  unreadable['claude-code']['claude-sonnet-next'].reasoningLevels = ['hyper']
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(async () => Response.json(unreadable), { preconnect: originalFetch.preconnect })
  const { service } = fixture({ now: Date.UTC(2026, 8, 28, 20), download: downloadModelProfiles })
  const status = await service.check().finally(() => { globalThis.fetch = originalFetch })
  expect(status.source).toBe('bundled')
  expect(status.error).toContain('does not match this version of Solus')
  expect(MODEL_PROFILES['claude-code']?.['claude-sonnet-next']).toBeUndefined()
})

test('a host starts on its cached list and asks GitHub only when 15:00 has passed since the download', () => {
  // WHY: the check is once a day. A restart must not ask again, and a host that
  // was off at 15:00 must not wait another day.
  const fetchedAt = Date.UTC(2026, 8, 28, 19, 30) // 15:30 EDT
  const fresh = fixture({ now: Date.UTC(2026, 8, 29, 14), download: async () => publishedList(), cache: { fetchedAt, profiles: publishedList() } })
  fresh.service.start()
  expect(fresh.service.status).toMatchObject({ source: 'remote', fetchedAt })
  expect(MODEL_PROFILES['claude-code']?.['claude-sonnet-next']).toBeDefined()
  expect(fresh.downloads()).toBe(0)

  const stale = fixture({ now: Date.UTC(2026, 8, 29, 19, 5), download: async () => publishedList(), cache: { fetchedAt, profiles: publishedList() } })
  stale.service.start()
  expect(stale.downloads()).toBe(1)
})

test('clearing the cache when GitHub cannot be reached goes back to the list in the build', async () => {
  // WHY: the settings control promises to drop the cached list. If the download
  // fails, keeping the cache would make the control do nothing.
  let reachable = true
  const { service, cachePath } = fixture({
    now: Date.UTC(2026, 8, 28, 20),
    download: async () => { if (!reachable) throw new Error('GitHub is unreachable'); return publishedList() },
  })
  await service.check()
  reachable = false
  const status = await service.refresh()
  expect(status).toMatchObject({ source: 'bundled', fetchedAt: null, error: 'GitHub is unreachable' })
  expect(existsSync(cachePath)).toBe(false)
  expect(MODEL_PROFILES['claude-code']?.['claude-sonnet-next']).toBeUndefined()
})
