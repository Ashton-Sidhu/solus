import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { encodePathAsFolder } from '@solus/contracts/types'
import { installTestIdentities } from './helpers/acting-identities'

mock.module('node:sqlite', () => ({ DatabaseSync }))
installTestIdentities()

// The repository of a folder is read from git (resolveRepositoryKey, tested on
// its own); here it answers for the one repository the test makes.
const repositoryKeys = new Map<string, string>()
const gitHelpers = await import('@solus/server/git/git-helpers')
mock.module('@solus/server/git/git-helpers', () => ({ ...gitHelpers, resolveRepositoryKey: async (cwd: string) => repositoryKeys.get(cwd) ?? null }))

// docs/plans/project-model.md §1: a project is its repository. A machine names
// the repository of each session it records, so the workspace service can list
// the session under that repository once the machine itself is gone.

let dataDir: string
let repo: string
let indexer: typeof import('@solus/server/db/session-indexer')
let closeDb: () => void

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-record-repository-'))
  process.env.SOLUS_DATA_DIR = dataDir
  repo = join(dataDir, 'web')
  mkdirSync(repo)
  repositoryKeys.set(repo, 'github.com/acme/web')
  indexer = await import('@solus/server/db/session-indexer')
  ;({ closeDb } = await import('@solus/server/db'))
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

const LOCAL = { principal: { kind: 'owner' as const, via: 'local' as const, expiresAt: null, deviceId: null, deviceLabel: 'Mac' }, home: { kind: 'local' as const, hostId: 'this-mac' }, scopes: ['sessions:read' as const] }

test('a session\'s record names the repository of its project', async () => {
  const { getSessionRecord } = await import('@solus/server/data/sessions/session-records')
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
  indexer.persistIndexedSessionStart('s-web', 'codex', repo, encodePathAsFolder(repo), 'gpt-5.5', 'high')
  // The start writes its record behind the index row; wait for it to land.
  let record = await getSessionRecord(ANY_ORGANIZATION, 's-web')
  for (let attempt = 0; attempt < 100 && !record?.projectRemote; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    record = await getSessionRecord(ANY_ORGANIZATION, 's-web')
  }
  expect(record?.projectRemote).toBe('github.com/acme/web')

  const { SessionApiOperations } = await import('@solus/server/data/sessions/api-operations')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  const operations = new SessionApiOperations(new ShareManager({ db: getDatabase() }))
  const listed = await operations.list(LOCAL, { limit: 50, repositoryKey: 'github.com/acme/web' })
  expect(listed.items.map((item) => item.id)).toEqual(['s-web'])
})

test('a record carries the Coordinator mode mark once the session is marked a lead', async () => {
  // WHY: the mark lives in session_leads, not on the record row; a list that
  // did not ask it could not show the glyph on the session's row.
  const { getSessionRecord } = await import('@solus/server/data/sessions/session-records')
  const { markSessionLead } = await import('@solus/server/data/sessions/lead-sessions')
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
  expect((await getSessionRecord(ANY_ORGANIZATION, 's-web'))?.isLead).toBeUndefined()
  await markSessionLead('s-web')
  expect((await getSessionRecord(ANY_ORGANIZATION, 's-web'))?.isLead).toBe(true)
})

test('a machine refuses to search by repository rather than ignore the filter', async () => {
  // WHY: its index knows checkouts, not repositories; an ignored filter would
  // answer with every project's sessions as if they were this one's.
  const { SessionApiOperations } = await import('@solus/server/data/sessions/api-operations')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  const operations = new SessionApiOperations(new ShareManager({ db: getDatabase() }))
  await expect(operations.search(LOCAL, { q: 'anything', repositoryKey: 'github.com/acme/web' })).rejects.toThrow('projectRoot')
})
