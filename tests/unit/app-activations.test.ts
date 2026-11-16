import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appDescriptorSchema } from '@solus/contracts/apps'
import type { Attribution } from '@solus/contracts/user'
import type { AppRecord } from '@solus/server/data/apps/app-store'
import { revisionStats } from '@solus/server/apps/app-repository'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// The history of what ran (docs/plans/apps.md §9.2, decision 8): each time a
// version becomes active, the version row keeps when, by whom, and over which
// version. Without it a rollback is only a state, and the Versions section
// cannot say "Rolled back to v1 from v2".

const dataDir = mkdtempSync(join(tmpdir(), 'solus-app-activations-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
let store: typeof import('@solus/server/data/apps/app-store')

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/apps/app-store')
})

afterAll(async () => {
  await resetTestDatabase()
  process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const APP: AppRecord = {
  id: 'app-activations', organizationId: 'local', ownerKey: 'owner', slug: 'activations', name: 'Activations', description: '', customName: null, customDescription: null, colorHue: null, activeVersion: null,
  stopped: false, agentAccess: true, repository: '/nowhere', latestRevision: null, project: null, createdBy: { kind: 'system' }, webhookIds: {}, createdAt: 0, updatedAt: 0,
}
const AGENT: Attribution = { kind: 'system' }
const OWNER: Attribution = { kind: 'user', user: { id: { kind: 'local', localId: 'owner' }, displayName: 'Ada' } }

async function addVersion(number: number) {
  await store.insertVersion({
    appId: APP.id, number, sourceCommit: String(number).repeat(40), buildCommit: 'b'.repeat(40), descriptor: appDescriptorSchema.parse({ solusApp: 3, name: 'Activations' }),
    hasBackend: false, hasUi: true, state: 'building', error: null, buildLog: null, buildMs: null, message: `v${number}`, createdBy: AGENT, createdAt: number, activations: [],
  })
}

async function activate(number: number, by: Attribution) {
  const app = await store.loadApp('local', APP.id)
  await store.activateVersion(app!, number, by)
}

test('a deploy and a rollback each leave an activation that names who did it and the version it replaced', async () => {
  await store.insertApp(APP)
  await addVersion(1)
  await addVersion(2)
  await activate(1, AGENT)
  await activate(2, AGENT)
  await activate(1, OWNER)

  const [second, first] = await store.listVersions(APP.id)
  expect([first?.state, second?.state]).toEqual(['active', 'superseded'])
  expect(first?.activations.map((entry) => [entry.previous, entry.by])).toEqual([[null, AGENT], [2, OWNER]])
  expect(second?.activations.map((entry) => [entry.previous, entry.by])).toEqual([[1, AGENT]])
})

test('a version keeps only its newest activations', async () => {
  for (let index = 0; index < store.MAX_ACTIVATIONS_PER_VERSION + 5; index += 1) await activate(index % 2 === 0 ? 2 : 1, AGENT)
  for (const version of await store.listVersions(APP.id)) expect(version.activations.length).toBeLessThanOrEqual(store.MAX_ACTIVATIONS_PER_VERSION)
})

test('the change size of a save is read from git\'s short stat, and a save that changed nothing has none', () => {
  expect(revisionStats(' 3 files changed, 10 insertions(+), 2 deletions(-)')).toEqual({ files: 3, additions: 10, deletions: 2 })
  expect(revisionStats(' 1 file changed, 1 insertion(+)')).toEqual({ files: 1, additions: 1, deletions: 0 })
  expect(revisionStats(' 1 file changed, 4 deletions(-)')).toEqual({ files: 1, additions: 0, deletions: 4 })
  expect(revisionStats('')).toEqual({ files: 0, additions: 0, deletions: 0 })
})
