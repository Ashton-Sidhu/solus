import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'
import type { Principal } from '@solus/server/admission/principal'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const root = mkdtempSync(join(tmpdir(), 'solus-cloud-reader-'))
process.env.SOLUS_DATA_DIR = root
let db: import('@solus/server/db/database').Db
let reader: import('@solus/server/sync/sessions/session-cloud-reader').SessionCloudReader
let repositories: import('@solus/server/sync/sessions/session-repository').SessionRepositories
let shares: import('@solus/server/sharing/share-manager').ShareManager
let makeRow: typeof import('@solus/server/data/sessions/session-repositories').createSessionRepository
let readRow: typeof import('@solus/server/data/sessions/session-repositories').readSessionRepository
let scope: typeof import('@solus/contracts/session-repositories').formatSessionCloudScope
let sessionTable: typeof import('@solus/server/data/sessions/schema').session
let owner: Principal
let other: Principal
let member: Principal
const head = 'a'.repeat(40)

beforeAll(async () => {
  const [database, cloud, repository, records, contract, sharing, schema, doors] = await Promise.all([
    import('@solus/server/db/database'), import('@solus/server/sync/sessions/session-cloud-reader'),
    import('@solus/server/sync/sessions/session-repository'), import('@solus/server/data/sessions/session-repositories'),
    import('@solus/contracts/session-repositories'), import('@solus/server/sharing/share-manager'),
    import('@solus/server/data/sessions/schema'), import('@solus/server/admission/doors'),
  ])
  db = database.getDatabase()
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  shares = new sharing.ShareManager({ db })
  makeRow = records.createSessionRepository
  readRow = records.readSessionRepository
  scope = contract.formatSessionCloudScope
  sessionTable = schema.session
  const claims = { iss: 'https://issuer.test', aud: 'urn:solus:api', jti: 'token', iat: 1, exp: 9999999999, grant_id: 'grant' } as const
  const admittedOwner = doors.principalForClaims({ ...claims, sub: 'alice', access: 'org-member', organizations: [{ id: 'org-a', role: 'member', teamIds: [] }] }, 'org-a', 'api')
  const admittedOther = doors.principalForClaims({ ...claims, sub: 'bob', access: 'org-member', organizations: [{ id: 'org-a', role: 'member', teamIds: [] }] }, 'org-a', 'api')
  const admittedMember = admittedOther
  if (!admittedOwner.ok || !admittedOther.ok || !admittedMember.ok) throw new Error('Test principals failed admission')
  owner = admittedOwner.principal; other = admittedOther.principal; member = admittedMember.principal
  const storage = await (await import('@solus/server/sync/sessions/session-remote-provider')).sessionRemoteProvider(db, { SOLUS_SESSION_STORAGE: 'local-git' })
  if (!storage) throw new Error('Local storage is required')
  reader = new cloud.SessionCloudReader(db, storage, shares)
  repositories = new repository.SessionRepositories(join(root, 'sessions', 'cloud-repositories'))
})
afterEach(async () => { await resetTestDatabase() })
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function archive(sessionId: string, cloudScope: `person:${string}` | `organization:${string}`, rows: string, patch?: string) {
  const storageScope = `file://${join(root, 'sessions', 'cloud-repositories')}`
  const row = await makeRow(db, cloudScope, sessionId, 'alice', storageScope)
  const manifest = { schemaVersion: 1, session: { id: sessionId, organizationId: cloudScope }, threads: [], project: null,
    turns: [{ operationId: 'one', endedAt: 1, provider: 'codex', threadId: 'thread', partial: false, head: null, snapshots: [], bundle: null, hasDiff: !!patch, hasRows: true, rowCount: 2 }] }
  const first = await repositories.commit(row.repository, { expectedHead: null, message: 'first', entries: [
    { path: 'manifest.json', content: JSON.stringify(manifest) }, { path: 'rows/0.jsonl', content: rows }, ...(patch ? [{ path: 'diff/0.patch', content: patch }] : []),
  ] })
  await db.run(sql`UPDATE session_repositories SET head = ${first}, synced_turn = 1 WHERE cloud_scope = ${cloudScope} AND session_id = ${sessionId}`)
  return { row, first }
}

// WHY: a client must read the accepted head, even if a host has pushed a newer commit without reporting it.
test('personal rows and diff use only the recorded head', async () => {
  const rows = '{"role":"user","content":"first","timestamp":1}\n{"role":"assistant","content":"done","timestamp":2}\n'
  const { row, first } = await archive('private', scope('person', 'alice'), rows, 'first patch')
  const newer = await repositories.commit(row.repository, { expectedHead: first, message: 'unreported', entries: [{ path: 'diff/0.patch', content: 'new patch' }, { path: 'rows/0.jsonl', content: '{"role":"user","content":"new","timestamp":3}\n' }] })
  expect(newer).not.toBe(first)
  expect((await reader.page(owner, 'private')).messages.map(message => message.content)).toEqual(['first', 'done'])
  // A client joins the turn diff to the turn the page holds.
  expect(await reader.page(owner, 'private')).toMatchObject({ turnIndex: 0, before: null, availability: 'available' })
  expect(await reader.diff(owner, 'private', 0)).toEqual({ status: 'available', patch: 'first patch' })
  expect((await reader.page(other, 'private')).availability).toBe('not-available')
  expect(await readRow(db, scope('person', 'alice'), 'private')).toMatchObject({ head: first })
})

// WHY: a projected tool result must not reveal its body even if a repository row is malformed.
test('a reader removes a tool result body', async () => {
  await archive('tool-body', scope('person', 'alice'), '{"role":"user","content":"run","timestamp":1}\n{"role":"tool_result","content":"private body","timestamp":2}\n')
  const answer = await reader.page(owner, 'tool-body')
  expect(JSON.stringify(answer)).not.toContain('private body')
})

// WHY: a missing repository and an old manifest must give a typed answer, not a Git error.
test('absent rows return typed not available', async () => {
  expect((await reader.page(owner, 'absent')).availability).toBe('not-available')
  const { row, first } = await archive('old', scope('person', 'alice'), '{"role":"user","content":"x","timestamp":1}\n')
  const manifest = { schemaVersion: 1, session: { id: 'old', organizationId: 'local' }, threads: [], project: null,
    turns: [{ operationId: 'old', endedAt: 1, provider: 'codex', threadId: 'thread', partial: false, head: null, snapshots: [], bundle: null, hasDiff: false }] }
  const old = await repositories.commit(row.repository, { expectedHead: first, message: 'old format', entries: [{ path: 'manifest.json', content: JSON.stringify(manifest) }] })
  await db.run(sql`UPDATE session_repositories SET head = ${old} WHERE session_id = 'old'`)
  expect(await reader.page(owner, 'old')).toMatchObject({ availability: 'not-available', unavailableTurns: [0], turnIndex: 0 })
  expect(await reader.diff(owner, 'old', 0)).toEqual({ status: 'not-available' })
  const omittedManifest = { ...manifest, turns: [{ ...manifest.turns[0], hasRows: false, rowCount: 0 }] }
  const omitted = await repositories.commit(row.repository, { expectedHead: old, message: 'omitted rows', entries: [{ path: 'manifest.json', content: JSON.stringify(omittedManifest) }] })
  await db.run(sql`UPDATE session_repositories SET head = ${omitted} WHERE session_id = 'old'`)
  expect(await reader.page(owner, 'old')).toMatchObject({ availability: 'not-available', unavailableTurns: [0] })
})

// WHY: an organization transcript is visible only with published session standing.
test('organization access requires publication and transcript standing', async () => {
  await db.run(sql`INSERT INTO ${sessionTable} (session_id, organization_id, created_by, publication, created_at, last_activity_at) VALUES ('shared', 'org-a', 'alice', 'published', 1, 1), ('local-only', 'org-a', 'alice', 'local', 1, 1)`)
  await archive('shared', scope('organization', 'org-a'), '{"role":"user","content":"shared","timestamp":1}\n')
  await archive('local-only', scope('organization', 'org-a'), '{"role":"user","content":"hidden","timestamp":1}\n')
  expect((await reader.page(owner, 'shared')).messages[0]?.content).toBe('shared')
  expect((await reader.page(member, 'shared')).availability).toBe('not-available')
  const doors = await import('@solus/server/admission/doors')
  const admitted = doors.principalForClaims({ iss: 'https://issuer.test', aud: 'urn:solus:api', sub: 'alice', jti: 'a', iat: 1, exp: 9999999999, grant_id: 'grant', access: 'org-member', organizations: [{ id: 'org-a', role: 'member', teamIds: [] }] }, 'org-a', 'api')
  if (!admitted.ok) throw new Error('Owner admission failed')
  await shares.setEntries({ resource: { kind: 'session', id: 'shared' }, entries: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, admitted.principal)
  expect((await reader.page(member, 'shared')).messages[0]?.content).toBe('shared')
  expect((await reader.page(member, 'local-only')).availability).toBe('not-available')
})

// WHY: one response must fit a client budget even when a turn patch is very large.
test('an oversized patch gives counts without patch text', async () => {
  const { row, first } = await archive('large-diff', scope('person', 'alice'), '{"role":"user","content":"change","timestamp":1}\n', 'large patch')
  const manifest = { schemaVersion: 1, session: { id: 'large-diff', organizationId: 'local' }, threads: [], project: null,
    turns: [{ operationId: 'one', endedAt: 1, provider: 'codex', threadId: 'thread', partial: false, head: null,
      snapshots: [{ index: 0, fromTreeSha: head, toTreeSha: head, sha: head, timestamp: 1, partial: false, userMessagePreview: 'change', filesChanged: 2, additions: 3, deletions: 4 }],
      bundle: null, hasDiff: true, hasRows: true, rowCount: 1 }] }
  const large = await repositories.commit(row.repository, { expectedHead: first, message: 'large patch', entries: [
    { path: 'manifest.json', content: JSON.stringify(manifest) }, { path: 'diff/0.patch', content: 'x'.repeat(2 * 1024 * 1024 + 1) },
  ] })
  await db.run(sql`UPDATE session_repositories SET head = ${large} WHERE session_id = 'large-diff'`)
  expect(await reader.diff(owner, 'large-diff', 0)).toEqual({ status: 'too-large', filesChanged: 2, additions: 3, deletions: 4 })
})

// WHY: the cursor must select an older turn, not an arbitrary row inside a turn.
test('history pages follow turn indexes', async () => {
  const { row, first } = await archive('paged', scope('person', 'alice'), '{"role":"user","content":"first","timestamp":1}\n')
  const manifest = { schemaVersion: 1, session: { id: 'paged', organizationId: 'local' }, threads: [], project: null,
    turns: [
      { operationId: 'one', endedAt: 1, provider: 'codex', threadId: 'thread', partial: false, head: null, snapshots: [], bundle: null, hasDiff: false, hasRows: true, rowCount: 1 },
      { operationId: 'two', endedAt: 2, provider: 'codex', threadId: 'thread', partial: false, head: null, snapshots: [], bundle: null, hasDiff: false, hasRows: true, rowCount: 2 },
    ] }
  const second = await repositories.commit(row.repository, { expectedHead: first, message: 'second', entries: [
    { path: 'manifest.json', content: JSON.stringify(manifest) }, { path: 'rows/1.jsonl', content: '{"role":"user","content":"second","timestamp":2}\n' },
  ] })
  await db.run(sql`UPDATE session_repositories SET head = ${second} WHERE session_id = 'paged'`)
  const newest = await reader.page(owner, 'paged')
  expect(newest.messages[0]?.content).toBe('second')
  expect(newest.before).toBe('0')
  expect((await reader.page(owner, 'paged', newest.before!)).messages[0]?.content).toBe('first')
  expect(await reader.preview(owner, 'paged')).toMatchObject({ totalMessages: 2, head: [{ content: 'first' }], tail: [{ content: 'second' }] })
})

// WHY: a mirror includes a running turn, so it must win over a repository that only has settled turns.
test('mirrored rows win when the repository also has rows', async () => {
  await archive('both', scope('person', 'alice'), '{"role":"user","content":"old repository","timestamp":1}\n')
  await db.run(sql`INSERT INTO ${sessionTable} (session_id, organization_id, created_by, publication, created_at, last_activity_at) VALUES ('both', 'org-a', 'alice', 'published', 1, 1)`)
  await db.run(sql`INSERT INTO session_transcripts (organization_id, session_id, position, runner_host_id, message, updated_at) VALUES ('org-a', 'both', 1, 'host', ${JSON.stringify({ role: 'user', content: 'live mirror', timestamp: 2 })}, 2)`)
  const handlers = new Map<string, (args: unknown[], ctx: { principal: Principal; clientId: string }) => Promise<unknown>>()
  const server = { register: (name: string, handler: (args: unknown[], ctx: { principal: Principal; clientId: string }) => Promise<unknown>) => { handlers.set(name, handler) } }
  const [{ registerSolusApiHandlers }, { HostEventPublisher }, { ClientEventRegistry }, { WorkLiveManager }] = await Promise.all([
    import('@solus/server/transport/solus-api/service-handlers'), import('@solus/server/transport/events/host-event-publisher'),
    import('@solus/server/transport/events/client-event-registry'), import('@solus/server/work-live/work-live-manager'),
  ])
  registerSolusApiHandlers(server as unknown as import('@solus/server/transport/server').SolusServer, {
    shares, sessionReader: reader, events: new HostEventPublisher(new ClientEventRegistry(() => true)),
    workLive: new WorkLiveManager({ publish: () => {} }), serviceId: 'api', host: '127.0.0.1', port: () => 0,
    presence: { watch: () => {}, unwatch: () => {} },
  })
  const page = await handlers.get('loadSessionPage')!([{ sessionId: 'both', turnLimit: 1 }], { principal: owner, clientId: 'alice' }) as { messages: Array<{ content: string }> }
  expect(page.messages.map(message => message.content)).toEqual(['live mirror'])
  const bobScope = scope('person', 'bob')
  const bobRow = await makeRow(db, bobScope, 'both', 'bob', `file://${join(root, 'sessions', 'cloud-repositories')}`)
  const bobManifest = { schemaVersion: 1, session: { id: 'both', organizationId: bobScope }, threads: [], project: null,
    turns: [{ operationId: 'bob', endedAt: 1, provider: 'codex', threadId: 'thread', partial: false, head: null, snapshots: [], bundle: null, hasDiff: false, hasRows: true, rowCount: 1 }] }
  const bobHead = await repositories.commit(bobRow.repository, { expectedHead: null, message: 'bob', entries: [
    { path: 'manifest.json', content: JSON.stringify(bobManifest) }, { path: 'rows/0.jsonl', content: '{"role":"user","content":"bob personal","timestamp":1}\n' },
  ] })
  await db.run(sql`UPDATE session_repositories SET head = ${bobHead} WHERE cloud_scope = ${bobScope} AND session_id = 'both'`)
  const bobPage = await handlers.get('loadSessionPage')!([{ sessionId: 'both', turnLimit: 1 }], { principal: other, clientId: 'bob' }) as { messages: Array<{ content: string }> }
  expect(bobPage.messages.map(message => message.content)).toEqual(['bob personal'])
})
