import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'solus-work-version-'))
process.env.SOLUS_DATA_DIR = dataDir
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let works: typeof import('@solus/server/folio/works')
beforeAll(async () => { works = await import('@solus/server/folio/works') })
afterAll(async () => {
  await (await import('@solus/server/db/database')).closeDatabase()
  ;(await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

test('cloud saves refuse a stale copy and preserve the newer text', async () => {
  const work = await works.createWork('org-a', 'Draft', 'doc', 'Original', '', undefined, 'claude-code')
  const updated = await works.saveWork('org-a', work.id, { content: 'Member B' }, work.updatedAt)
  expect(updated.updatedAt > work.updatedAt).toBe(true)
  await expect(works.saveWork('org-a', work.id, { content: 'Stale A' }, work.updatedAt)).rejects.toThrow('changed in the cloud')
  expect((await works.loadWork('org-a', work.id))?.content).toBe('Member B')
  expect(await works.loadWorkUpdatedAt('org-a', work.id)).toBe(updated.updatedAt)
  expect(await works.loadWorkUpdatedAt('org-b', work.id)).toBeNull()
})

test('agent edits and Restore advance the version read by open clients', async () => {
  const work = await works.createWork('org-a', 'Diagram', 'diagram', '{"nodes":[],"edges":[]}', '', undefined, 'claude-code')
  const updated = await works.agentSaveWork('org-a', work.id, { title: 'Agent title' })
  expect(updated.updatedAt > work.updatedAt).toBe(true)
  await works.agentSaveWork('org-a', work.id, { content: '{"nodes":[{"id":"a"}],"edges":[]}' })
  const version = await works.loadWorkUpdatedAt('org-a', work.id)
  const restored = await works.revertWork('org-a', work.id)
  expect(restored!.updatedAt > version!).toBe(true)
  expect(restored?.content).toBe(work.content)
})
