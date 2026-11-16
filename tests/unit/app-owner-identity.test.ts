import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appDescriptorSchema } from '@solus/contracts/apps'
import type { AppRecord } from '@solus/server/data/apps/app-store'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// The name, description, and tile colour the owner gives an app (docs/apps.md).
// The manifest names the app again on each deploy, so the owner's own words are
// kept apart from it: a deploy writes the manifest's, and the list shows the owner's.

const dataDir = mkdtempSync(join(tmpdir(), 'solus-app-owner-identity-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
let store: typeof import('@solus/server/data/apps/app-store')
let summaries: typeof import('@solus/server/apps/app-summaries')

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/apps/app-store')
  summaries = await import('@solus/server/apps/app-summaries')
})

afterAll(async () => {
  await resetTestDatabase()
  process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const APP: AppRecord = {
  id: 'app-owner-identity', organizationId: 'local', ownerKey: 'owner', slug: 'notes', name: 'Notes', description: 'Keeps notes.',
  customName: null, customDescription: null, colorHue: null, activeVersion: null, stopped: false, agentAccess: true, repository: '/nowhere',
  latestRevision: null, project: null, createdBy: { kind: 'system' }, webhookIds: {}, createdAt: 0, updatedAt: 0,
}

test('a deploy writes the manifest name, and the app keeps the name, description, and colour its owner gave it', async () => {
  await store.insertApp(APP)
  const app = (await store.loadApp('local', APP.id))!
  await store.saveApp({ ...app, customName: 'Team notes', customDescription: 'Notes for the team.', colorHue: 210 })

  // A deploy activates a version with the manifest's name, as `Apps.makeActive` does.
  await store.insertVersion({
    appId: APP.id, number: 1, sourceCommit: 'a'.repeat(40), buildCommit: 'b'.repeat(40), descriptor: appDescriptorSchema.parse({ solusApp: 3, name: 'Notes two' }),
    hasBackend: false, hasUi: true, state: 'building', error: null, buildLog: null, buildMs: null, message: 'v1', createdBy: { kind: 'system' }, createdAt: 1, activations: [],
  })
  const current = (await store.loadApp('local', APP.id))!
  await store.activateVersion({ ...current, name: 'Notes two', description: 'Keeps more notes.' }, 1, { kind: 'system' })

  const summary = await summaries.appSummaryOf((await store.loadApp('local', APP.id))!)
  expect(summary).toMatchObject({ name: 'Team notes', description: 'Notes for the team.', manifestName: 'Notes two', manifestDescription: 'Keeps more notes.', colorHue: 210 })

  // With no name of its own, the app shows its manifest's again.
  await store.saveApp({ ...(await store.loadApp('local', APP.id))!, customName: null, customDescription: null, colorHue: null })
  expect(await summaries.appSummaryOf((await store.loadApp('local', APP.id))!)).toMatchObject({ name: 'Notes two', description: 'Keeps more notes.', colorHue: null })
})
