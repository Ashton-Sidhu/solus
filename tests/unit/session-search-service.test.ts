import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { DatabaseSync } from './helpers/bun-sqlite'
import { searchText, searchWords } from '@solus/contracts/session-search'
mock.module('node:sqlite', () => ({ DatabaseSync }))
let directory: string
let database: typeof import('@solus/server/db/database')
let hostDb: typeof import('@solus/server/db')
let search: typeof import('@solus/server/db/search-index')
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'solus-search-service-'))
  process.env.SOLUS_DATA_DIR = directory
  database = await import('@solus/server/db/database')
  hostDb = await import('@solus/server/db')
  search = await import('@solus/server/db/search-index')
})
afterAll(async () => { await database.closeDatabase(); hostDb.closeDb(); rmSync(directory, { recursive: true, force: true }) })

async function seed(sessionId: string, title: string, texts: string[], organizationId = 'org1') {
  const db = database.getDatabase()
  await db.run(sql`INSERT INTO session_records (session_id, organization_id, owner_key, provider, project_path, custom_title, created_at, last_activity_at)
    VALUES (${sessionId}, ${organizationId}, 'alice', 'codex', '/repo', ${title}, 1, 1)`)
  for (const [position, content] of texts.entries()) await db.run(sql`INSERT INTO session_transcripts (session_id, organization_id, position, runner_host_id, message, search_text, updated_at)
    VALUES (${sessionId}, ${organizationId}, ${position}, 'runner', ${JSON.stringify({ messageId: `${sessionId}-${position}`, role: 'user', content, timestamp: 100 })}, ${searchText(content)}, 1)`)
}
const find = (query: string, offset = 0, limit = 30) => {
  const db = database.getDatabase()
  return search.searchIndexFor(db.engine).searchSessions(db, { words: searchWords(query), namesOnly: false, records: sql`session_records.organization_id = 'org1'`, offset, limit })
}

test('service search has the host word rule, cross-message matches and portable targets', async () => {
  await seed('code', '', ['the serverConnections store', 'Café header'])
  await seed('hidden', '', ['serverConnections cafe'], 'org2')
  const result = await find('connections cafe')
  expect(result.total).toBe(1)
  expect(result.sessions[0]!.sessionId).toBe('code')
  expect(result.sessions[0]!.passages[0]!.target.messageId).toBe('code-1')
  expect((await find('socket')).total).toBe(0)
})

test('the server ranks exact names before paging and reports complete totals', async () => {
  await seed('exact', 'Tab', [])
  for (let i = 0; i < 35; i++) await seed(`tab-${i}`, `Tab details ${i}`, [])
  const first = await find('tab')
  const second = await find('tab', 30)
  expect(first.total).toBe(36)
  expect(first.sessions[0]!.sessionId).toBe('exact')
  expect(new Set([...first.sessions, ...second.sessions].map(row => row.sessionId)).size).toBe(36)
})

test('the message index follows replacements, deletion and derived-text backfill', async () => {
  const db = database.getDatabase()
  await seed('replace', '', ['pelican'])
  await db.run(sql`UPDATE session_transcripts SET search_text = 'heron', message = ${JSON.stringify({ role: 'user', content: 'heron', timestamp: 10 })} WHERE session_id = 'replace'`)
  expect((await find('pelican')).total).toBe(0)
  expect((await find('heron')).total).toBe(1)
  await db.run(sql`UPDATE session_transcripts SET search_text = '' WHERE session_id = 'replace'`)
  const { rebuildMirroredSearch } = await import('@solus/server/db/session-search-rebuild')
  await rebuildMirroredSearch(db)
  expect((await find('heron')).total).toBe(1)
  await db.run(sql`DELETE FROM session_transcripts WHERE session_id = 'replace'`)
  expect((await find('heron')).total).toBe(0)
})

test('a service preview resolves the same provider message after positions change', async () => {
  const db = database.getDatabase()
  await seed('preview', '', ['opening', '🦜 needle passage', 'last reply'])
  await db.run(sql`UPDATE session_transcripts SET message = ${JSON.stringify({ messageId: 'preview-1', sourceSessionId: 'provider-thread', sourceProvider: 'codex', role: 'user', content: '🦜 needle passage', timestamp: 100 })} WHERE session_id = 'preview' AND position = 1`)
  const target = (await find('needle')).sessions[0]!.passages[0]!.target
  expect(target.sourceSessionId).toBe('provider-thread')
  await db.run(sql`UPDATE session_transcripts SET position = position + 100 WHERE session_id = 'preview'`)
  const { readTranscriptMessageWindow, readTranscript } = await import('@solus/server/data/sessions/transcript-reads')
  const request = { sessionId: 'preview', messageId: 1, target }
  const window = await readTranscriptMessageWindow('org1', request)
  expect(window.hitMessageId).toBe(101)
  expect(window.messages.map(row => row.text)).toEqual(['opening', '🦜 needle passage', 'last reply'])
  expect((await readTranscript('org1', 'preview'))[1]!.sourceSessionId).toBe('provider-thread')
  expect((await readTranscriptMessageWindow('org2', request)).messages).toEqual([])
  expect((await readTranscriptMessageWindow('org1', { ...request, target: { ...target, sourceSessionId: 'wrong-thread' } })).messages).toEqual([])
  expect((await readTranscriptMessageWindow('org1', { ...request, target: { ...target, messageId: null } })).hitMessageId).toBe(101)
})
