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

    expect(store.list('org-a', null).map((each) => each.id)).toEqual([a.id])
    expect(store.get(b.id, 'org-a')).toBeNull()
    expect(store.getBySlug('deepwiki', 'org-b', null)?.id).toBe(b.id)
    expect(store.list(principal.ANY_ORGANIZATION, null).map((each) => each.id).sort()).toEqual([a.id, b.id].sort())
    expect(a).toMatchObject({ organizationId: 'org-a', ownerUserId: null, kind: 'mcp', slug: 'deepwiki', createdBy: 'alice', auth: anonymous })
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

  test('the tools turned off are kept on the record, and a rename keeps them', () => {
    // WHY: the list is what keeps a tool from agents; an unrelated edit must not turn it back on.
    const store = new storeModule.IntegrationStore()
    const created = store.create(input('DeepWiki'), 'org-a', null)
    expect(created.disabledTools).toEqual([])
    store.update(created.id, { disabledTools: ['write_page', 'delete_page', 'write_page'] }, 'org-a')
    store.update(created.id, { name: 'Wiki' }, 'org-a')
    expect(store.get(created.id, 'org-a')).toMatchObject({ name: 'Wiki', disabledTools: ['delete_page', 'write_page'] })
    store.update(created.id, { disabledTools: [] }, 'org-a')
    expect(store.get(created.id, 'org-a')?.disabledTools).toEqual([])
  })

  test('remove deletes only inside the scope', () => {
    const store = new storeModule.IntegrationStore()
    const created = store.create(input('DeepWiki'), 'org-a', null)

    expect(store.remove(created.id, 'org-b')).toBe(false)
    expect(store.get(created.id, 'org-a')).not.toBeNull()
    expect(store.remove(created.id, 'org-a')).toBe(true)
    expect(store.list(principal.ANY_ORGANIZATION, null)).toEqual([])
    // The slug is free again.
    expect(store.create(input('DeepWiki'), 'org-a', null).slug).toBe('deepwiki')
  })

  test('a personal integration is seen by its owner alone, and its slug may equal a shared one\'s', () => {
    // WHY (plans/020-agent-profile.md §2.1): a person's own MCP server follows
    // them to a host, where another member must neither see it nor call its
    // tools, and where the shared record of the same name keeps its tool prefix.
    const store = new storeModule.IntegrationStore()
    const shared = store.create(input('DeepWiki'), 'org-a', null)
    const alices = store.create(input('My DeepWiki'), 'org-a', 'alice', 'alice')
    expect(alices).toMatchObject({ ownerUserId: 'alice', slug: 'deepwiki' })
    expect(store.list('org-a', 'alice').map((each) => each.id).sort()).toEqual([shared.id, alices.id].sort())
    expect(store.list('org-a', 'bob').map((each) => each.id)).toEqual([shared.id])
    expect(store.list('org-a', null).map((each) => each.id)).toEqual([shared.id])
    expect(store.getVisible(alices.id, 'org-a', 'bob')).toBeNull()
    expect(store.getVisible(alices.id, 'org-a', 'alice')?.id).toBe(alices.id)
    expect(store.listOwned('org-a', 'alice').map((each) => each.id)).toEqual([alices.id])
    // Her own record before the shared one of the same URL; Bob finds the shared one.
    expect(store.findByUrl('https://mcp.deepwiki.com/mcp', 'org-a', 'alice')?.id).toBe(alices.id)
    expect(store.findByUrl('https://mcp.deepwiki.com/mcp', 'org-a', 'bob')?.id).toBe(shared.id)
    // A second personal record of hers with the same name gets the suffix among hers.
    expect(store.create(input('Again'), 'org-a', 'alice', 'alice').slug).toBe('deepwiki-2')
    expect(store.all('org-a')).toHaveLength(3)
  })
})
