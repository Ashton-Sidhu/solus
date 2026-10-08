import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from '../helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/mcp-integrations.md §3.3: an integration is a root record of one
// organization, and its slug is the tool prefix, unique per organization.

type StoreModule = typeof import('@solus/server/integrations/integration-store')
type PrincipalModule = typeof import('@solus/server/admission/principal')
type DbModule = typeof import('@solus/server/db')

let dataDir: string
let storeModule: StoreModule
let principal: PrincipalModule
let db: DbModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-integration-store-'))
  process.env.SOLUS_DATA_DIR = dataDir
  storeModule = await import('@solus/server/integrations/integration-store')
  principal = await import('@solus/server/admission/principal')
  db = await import('@solus/server/db')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const anonymous = { kind: 'none' as const }

function input(name: string, slug = 'deepwiki') {
  return { name, url: 'https://mcp.deepwiki.com/mcp', slug, auth: anonymous }
}

describe('integration store', () => {
  test('a member reads only their organization; the host owner reads every one', () => {
    // WHY: a member of A must never see, or call the tools of, an integration of B.
    const store = new storeModule.IntegrationStore()
    const a = store.create(input('DeepWiki'), 'org-a', 'alice')
    const b = store.create(input('DeepWiki'), 'org-b', null)

    expect(store.list('org-a').map((each) => each.id)).toEqual([a.id])
    expect(store.get(b.id, 'org-a')).toBeNull()
    expect(store.getBySlug('deepwiki', 'org-b')?.id).toBe(b.id)
    expect(store.list(principal.ANY_ORGANIZATION).map((each) => each.id).sort()).toEqual([a.id, b.id].sort())
    expect(a).toMatchObject({ organizationId: 'org-a', kind: 'mcp', slug: 'deepwiki', createdBy: 'alice', auth: anonymous })
  })

  test('a second integration with a taken slug gets a numeric suffix in that organization only', () => {
    // WHY: the slug names the agent tools; two integrations with one prefix would collide.
    const store = new storeModule.IntegrationStore()
    const first = store.create(input('DeepWiki'), 'org-a', null)
    const second = store.create(input('DeepWiki again'), 'org-a', null)
    const third = store.create(input('DeepWiki third'), 'org-a', null)
    const other = store.create(input('DeepWiki'), 'org-b', null)

    expect([first.slug, second.slug, third.slug]).toEqual(['deepwiki', 'deepwiki-2', 'deepwiki-3'])
    expect(other.slug).toBe('deepwiki')
  })

  test('the suffix keeps the slug within 40 characters', () => {
    const store = new storeModule.IntegrationStore()
    const long = 'a'.repeat(40)
    store.create(input('Long', long), 'org-a', null)
    const second = store.create(input('Long', long), 'org-a', null)
    expect(second.slug).toBe(`${'a'.repeat(38)}-2`)
  })

  test('update changes the record in scope and keeps its slug; outside the scope it is not found', () => {
    const store = new storeModule.IntegrationStore()
    const created = store.create(input('DeepWiki'), 'org-a', null)
    const oauth = { kind: 'oauth' as const, discover: 'https://example.com/.well-known/oauth-protected-resource', registration: 'dynamic' as const }

    expect(store.update(created.id, { name: 'Wiki' }, 'org-b')).toBeNull()
    const updated = store.update(created.id, { name: 'Wiki', url: 'https://example.com/mcp', auth: oauth }, 'org-a')

    expect(updated).toMatchObject({ name: 'Wiki', url: 'https://example.com/mcp', slug: 'deepwiki', auth: oauth })
    expect(store.get(created.id, 'org-a')?.name).toBe('Wiki')
  })

  test('remove deletes only inside the scope', () => {
    const store = new storeModule.IntegrationStore()
    const created = store.create(input('DeepWiki'), 'org-a', null)

    expect(store.remove(created.id, 'org-b')).toBe(false)
    expect(store.get(created.id, 'org-a')).not.toBeNull()
    expect(store.remove(created.id, 'org-a')).toBe(true)
    expect(store.list(principal.ANY_ORGANIZATION)).toEqual([])
    // The slug is free again.
    expect(store.create(input('DeepWiki'), 'org-a', null).slug).toBe('deepwiki')
  })
})
