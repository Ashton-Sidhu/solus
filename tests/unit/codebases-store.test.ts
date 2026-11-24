import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { CODEBASE_ROOTS_MAX, type Codebase, type CodebaseRoot } from '@solus/contracts/codebases'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/codebases.md decision 6: each host keeps the full record of a
// codebase. A copy moves between hosts as a whole, the newest `updatedAt`
// wins, and a delete is a tombstone so that it also moves. Decision 14: a
// codebase has two or more folders, because one folder is a project.

type CodebasesModule = typeof import('@solus/server/data/codebases/codebases')
type PrincipalModule = typeof import('@solus/server/admission/principal')
type DbModule = typeof import('@solus/server/db')

let dataDir: string
let codebases: CodebasesModule
let principal: PrincipalModule
let db: DbModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-codebases-'))
  process.env.SOLUS_DATA_DIR = dataDir
  codebases = await import('@solus/server/data/codebases/codebases')
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

const LAPTOP = 'installation-laptop'
const SERVER = 'installation-server'
const root = (path: string, installationId = LAPTOP): CodebaseRoot => ({ installationId, path, name: '' })
/** The second folder of each fixture: a codebase has two or more. */
const UI = root('/Users/me/ui')
const shop = (overrides: Partial<Codebase> = {}): Codebase => ({
  id: 'codebase-shop', name: 'shop', roots: [root('/Users/me/shop'), UI], updatedAt: 1_000, deletedAt: null, ...overrides,
})

describe('the newest copy wins', () => {
  test('a newer copy replaces the stored one', async () => {
    await codebases.saveCodebase('local', 'alice', shop())
    const kept = await codebases.saveCodebase('local', 'alice', shop({ name: 'shop v2', roots: [root('/Users/me/shop'), root('/srv/infra', SERVER)], updatedAt: 2_000 }))

    expect(kept).toMatchObject({ name: 'shop v2', updatedAt: 2_000 })
    expect(await codebases.listCodebases('local')).toEqual([kept])
  })

  test('an older copy changes nothing, and the answer is the copy the host keeps', async () => {
    // WHY: a client sends its copy to each host. A host that already has a
    // newer one answers that one, so the client learns that its copy is old.
    const newer = shop({ name: 'renamed on a different host', updatedAt: 2_000 })
    await codebases.saveCodebase('local', 'alice', newer)

    expect(await codebases.saveCodebase('local', 'alice', shop({ updatedAt: 1_000 }))).toEqual(newer)
    expect(await codebases.listCodebases('local')).toEqual([newer])
  })

  test('a copy with the same time is the same record: it changes nothing and tells no client', async () => {
    await codebases.saveCodebase('local', 'alice', shop())
    let changes = 0
    const stop = codebases.onCodebasesChanged(() => { changes += 1 })
    await codebases.saveCodebase('local', 'alice', shop({ name: 'same time, other name' }))
    stop()

    expect(changes).toBe(0)
    expect((await codebases.listCodebases('local'))[0].name).toBe('shop')
  })

  test('a save that changed the row tells the listeners', async () => {
    let changes = 0
    const stop = codebases.onCodebasesChanged(() => { changes += 1 })
    await codebases.saveCodebase('local', 'alice', shop())
    await codebases.saveCodebase('local', 'alice', shop({ updatedAt: 2_000 }))
    stop()
    expect(changes).toBe(2)
  })
})

describe('a delete is a tombstone', () => {
  // WHY: a client deletes with a save of the tombstone. Each host then keeps
  // the same copy with the same `updatedAt`, and no host makes a time of its own.
  const tombstone = (updatedAt: number) => shop({ updatedAt, deletedAt: updatedAt })

  test('the row stays with deletedAt set, and the list leaves it out unless asked', async () => {
    await codebases.saveCodebase('local', 'alice', shop())
    const kept = await codebases.saveCodebase('local', 'alice', tombstone(5_000))

    expect(kept).toEqual(tombstone(5_000))
    expect(await codebases.listCodebases('local')).toEqual([])
    // WHY: a client needs the tombstone to send the delete to a host that has an older live copy.
    expect(await codebases.listCodebases('local', { includeDeleted: true })).toEqual([kept])
  })

  test('a tombstone that is older than the live copy does not delete it', async () => {
    // WHY: the newest copy wins for a delete as for each other change.
    const live = await codebases.saveCodebase('local', 'alice', shop({ updatedAt: 9_000 }))
    expect(await codebases.saveCodebase('local', 'alice', tombstone(5_000))).toEqual(live)
    expect(await codebases.listCodebases('local')).toEqual([live])
  })

  test('a save of a tombstone tells the listeners', async () => {
    await codebases.saveCodebase('local', 'alice', shop())
    let changes = 0
    const stop = codebases.onCodebasesChanged(() => { changes += 1 })
    await codebases.saveCodebase('local', 'alice', tombstone(5_000))
    stop()
    expect(changes).toBe(1)
  })

  test('an older live copy does not bring a deleted codebase back', async () => {
    await codebases.saveCodebase('local', 'alice', shop())
    const kept = await codebases.saveCodebase('local', 'alice', tombstone(5_000))

    expect(await codebases.saveCodebase('local', 'alice', shop({ updatedAt: 4_000 }))).toEqual(kept)
    expect(await codebases.listCodebases('local')).toEqual([])
  })

  test('a newer live copy wins over a tombstone', async () => {
    await codebases.saveCodebase('local', 'alice', shop())
    await codebases.saveCodebase('local', 'alice', tombstone(5_000))
    const kept = await codebases.saveCodebase('local', 'alice', shop({ updatedAt: 6_000 }))

    expect(kept.deletedAt).toBeNull()
    expect(await codebases.listCodebases('local')).toEqual([kept])
  })

  test('a tombstone is checked as each other copy is', async () => {
    await codebases.saveCodebase('local', 'alice', shop())
    await expect(codebases.saveCodebase('local', 'alice', { ...tombstone(5_000), name: '  ' })).rejects.toThrow(/name/)
    await expect(codebases.saveCodebase('local', 'alice', { ...tombstone(5_000), roots: [root('relative/path')] })).rejects.toThrow(/absolute/)
    expect(await codebases.listCodebases('local')).toHaveLength(1)
  })
})

describe('validation', () => {
  test('refuses an empty name', async () => {
    await expect(codebases.saveCodebase('local', 'alice', shop({ name: '   ' }))).rejects.toThrow(/name/)
  })

  test('refuses a path that is not absolute', async () => {
    // WHY: a root is read on its host with no working directory to resolve against, and `~` is a different folder for each person.
    for (const path of ['shop', './shop', '~/shop', '~']) {
      await expect(codebases.saveCodebase('local', 'alice', shop({ roots: [root(path), UI] }))).rejects.toThrow(/absolute/)
    }
  })

  test('accepts an absolute path of a Windows host', async () => {
    const kept = await codebases.saveCodebase('local', 'alice', shop({ roots: [root('C:\\code\\shop'), root('C:\\code\\ui')] }))
    expect(kept.roots[0].path).toBe('C:\\code\\shop')
  })

  test('refuses the same folder of one host two times, in any spelling', async () => {
    await expect(codebases.saveCodebase('local', 'alice', shop({ roots: [root('/Users/me/shop'), root('/Users/me/shop/')] }))).rejects.toThrow(/two times/)
  })

  test('the same path on two hosts is two folders', async () => {
    const kept = await codebases.saveCodebase('local', 'alice', shop({ roots: [root('/srv/shop', LAPTOP), root('/srv/shop', SERVER)] }))
    expect(kept.roots).toHaveLength(2)
  })

  test(`refuses more than ${CODEBASE_ROOTS_MAX} roots`, async () => {
    const many = Array.from({ length: CODEBASE_ROOTS_MAX + 1 }, (_unused, index) => root(`/Users/me/repo-${index}`))
    await expect(codebases.saveCodebase('local', 'alice', shop({ roots: many }))).rejects.toThrow(/at most/)
    const limit = await codebases.saveCodebase('local', 'alice', shop({ roots: many.slice(0, CODEBASE_ROOTS_MAX) }))
    expect(limit.roots).toHaveLength(CODEBASE_ROOTS_MAX)
  })

  test('refuses a codebase with fewer than two folders', async () => {
    // WHY: one folder is a project. A project and a codebase with the same
    // folder are two rows of the project picker that read as one thing, and a
    // session of a project gets the repositories inside it with no codebase.
    await expect(codebases.saveCodebase('local', 'alice', shop({ roots: [root('/Users/me/shop')] }))).rejects.toThrow(/at least 2 folders/)
    await expect(codebases.saveCodebase('local', 'alice', shop({ roots: [] }))).rejects.toThrow(/at least 2 folders/)
    expect(await codebases.listCodebases('local')).toEqual([])
  })

  test('a tombstone can have fewer than two folders', async () => {
    // WHY: a delete keeps the roots that its codebase had, and it must move to each host.
    const deleted = shop({ roots: [root('/Users/me/shop')], updatedAt: 5_000, deletedAt: 5_000 })
    expect(await codebases.saveCodebase('local', 'alice', deleted)).toEqual(deleted)
  })

  test('refuses a folder that is inside a different folder of the same host', async () => {
    // WHY: a root covers the folders inside it, as a project covers its repositories.
    await expect(codebases.saveCodebase('local', 'alice', shop({ roots: [root('/Users/me/shop'), root('/Users/me/shop/api')] }))).rejects.toThrow(/is inside/)
    // The same place on a different host is a different folder.
    const kept = await codebases.saveCodebase('local', 'alice', shop({ roots: [root('/Users/me/shop'), root('/Users/me/shop/api', SERVER)] }))
    expect(kept.roots).toHaveLength(2)
  })

  test('a stored record with one folder that is not deleted is not a codebase', async () => {
    // WHY: development data of the rule before this one. No read answers it,
    // so no session takes it and no client lists it.
    const { getDatabase } = await import('@solus/server/db/database')
    await getDatabase().run(sql`
      INSERT INTO codebases (id, organization_id, created_by, name, roots, updated_at, deleted_at)
      VALUES ('codebase-old', 'local', 'alice', 'old', ${JSON.stringify([root('/Users/me/old')])}, 1000, NULL)
    `)
    expect(await codebases.listCodebases('local', { includeDeleted: true })).toEqual([])
    expect(await codebases.getCodebase('local', 'codebase-old')).toBeNull()
    expect(await codebases.codebasesOfFolder('local', LAPTOP, '/Users/me/old')).toEqual([])
  })

  test('a refused copy stores nothing', async () => {
    await codebases.saveCodebase('local', 'alice', shop()).catch(() => {})
    await codebases.saveCodebase('local', 'alice', shop({ name: '', updatedAt: 2_000 })).catch(() => {})
    expect((await codebases.listCodebases('local'))[0]).toMatchObject({ name: 'shop', updatedAt: 1_000 })
  })
})

describe('organization scope', () => {
  test('a read answers only the codebases of its organization', async () => {
    await codebases.saveCodebase('org-a', 'alice', shop({ id: 'codebase-a', name: 'a' }))
    await codebases.saveCodebase('org-b', 'bob', shop({ id: 'codebase-b', name: 'b' }))

    expect((await codebases.listCodebases('org-a')).map((codebase) => codebase.id)).toEqual(['codebase-a'])
    expect(await codebases.getCodebase('org-a', 'codebase-b')).toBeNull()
    // The owner of a personal host reads the whole disk.
    expect((await codebases.listCodebases(principal.ANY_ORGANIZATION)).map((codebase) => codebase.id)).toEqual(['codebase-a', 'codebase-b'])
  })

  test('a save cannot change a codebase of a different organization', async () => {
    // WHY: the id of a codebase names one row. A newer copy from a different
    // organization must not replace it, and must not move it.
    const original = await codebases.saveCodebase('org-a', 'alice', shop())
    await expect(codebases.saveCodebase('org-b', 'bob', shop({ name: 'taken', updatedAt: 9_000 }))).rejects.toThrow(/different organization/)
    expect(await codebases.listCodebases('org-a')).toEqual([original])
    expect(await codebases.listCodebases('org-b')).toEqual([])
  })

  test('a tombstone does not reach a codebase of a different organization', async () => {
    await codebases.saveCodebase('org-a', 'alice', shop())
    await expect(codebases.saveCodebase('org-b', 'bob', shop({ updatedAt: 5_000, deletedAt: 5_000 }))).rejects.toThrow(/different organization/)
    expect(await codebases.listCodebases('org-a')).toHaveLength(1)
  })
})

describe('the codebases of a folder', () => {
  test('a folder is in each codebase that has it as a root or holds it in a root, on that host only', async () => {
    await codebases.saveCodebase('local', 'alice', shop({ id: 'codebase-shop', name: 'shop', roots: [root('/Users/me/shop'), UI] }))
    await codebases.saveCodebase('local', 'alice', shop({ id: 'codebase-api', name: 'api only', roots: [root('/Users/me/shop/api'), UI] }))
    await codebases.saveCodebase('local', 'alice', shop({ id: 'codebase-remote', name: 'remote', roots: [root('/Users/me/shop', SERVER), UI] }))
    await codebases.saveCodebase('local', 'alice', shop({ id: 'codebase-gone', name: 'gone', roots: [root('/Users/me/shop'), UI], updatedAt: 5_000, deletedAt: 5_000 }))

    const idsOf = async (path: string) => (await codebases.codebasesOfFolder('local', LAPTOP, path)).map((codebase) => codebase.id).sort()
    // Decision 5: one folder can be in several codebases.
    expect(await idsOf('/Users/me/shop/api')).toEqual(['codebase-api', 'codebase-shop'])
    expect(await idsOf('/Users/me/shop')).toEqual(['codebase-shop'])
    // A folder whose name starts with the name of a root is not inside the root.
    expect(await idsOf('/Users/me/shop-old')).toEqual([])
  })
})
