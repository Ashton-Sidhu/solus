import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §6: a runner's mirrored items land on the
// workspace service keyed by what they are about — a transcript row by its
// position, a span by its id — so a redelivery writes the same row again, and
// the `mirror` cursor skips what was already applied. The service then answers
// a member's history reads from that copy.

let intake: typeof import('@solus/server/sync/runner-intake')
let principalModule: typeof import('@solus/server/admission/principal')
let reads: typeof import('@solus/server/data/sessions/transcript-reads')
let transcriptSchema: typeof import('@solus/server/data/sessions/transcript-schema')
let insightSchema: typeof import('@solus/server/data/insights/insight-schema')
let database: typeof import('@solus/server/db/database')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-mirror-sinks-'))
  process.env.SOLUS_DATA_DIR = dataDir
  intake = await import('@solus/server/sync/runner-intake')
  principalModule = await import('@solus/server/admission/principal')
  reads = await import('@solus/server/data/sessions/transcript-reads')
  transcriptSchema = await import('@solus/server/data/sessions/transcript-schema')
  insightSchema = await import('@solus/server/data/insights/insight-schema')
  database = await import('@solus/server/db/database')
  dbModule = await import('@solus/server/db')
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const runner = (hostId = 'runner-1') => principalModule.runnerPrincipalFor({ hostId, organizationId: 'org1', ownerUserId: 'alice', expiresAt: Date.now() + 600_000 })

function message(content: string, role = 'assistant') {
  return { role, content, timestamp: 1 }
}

function row(seq: number, sessionId: string, position: number, content: string, role?: string) {
  return { seq, domain: 'transcripts' as const, key: `${sessionId}:${position}`, payload: { sessionId, position, message: message(content, role) } }
}

async function transcriptRows(sessionId: string): Promise<Array<{ position: number; content: string; runner: string }>> {
  const rows = await database.getDatabase().all<{ position: number; message: string; runner_host_id: string }>(sql`
    SELECT position, message, runner_host_id FROM ${transcriptSchema.sessionTranscripts}
    WHERE organization_id = 'org1' AND session_id = ${sessionId} ORDER BY position
  `)
  return rows.map((entry) => ({ position: entry.position, content: (JSON.parse(entry.message) as { content: string }).content, runner: entry.runner_host_id }))
}

describe('mirror sinks', () => {
  test('transcript rows land by position, the latest payload wins, and a redelivery changes nothing', async () => {
    const batch = { hostId: 'runner-1', items: [row(1, 's1', 0, 'hello'), row(2, 's1', 1, 'draft'), row(3, 's1', 1, 'final')] }
    expect(await intake.applyRunnerMirror(runner(), batch)).toEqual({ lastSeq: 3 })
    expect(await transcriptRows('s1')).toEqual([{ position: 0, content: 'hello', runner: 'runner-1' }, { position: 1, content: 'final', runner: 'runner-1' }])

    // The same batch again: every seq is at or below the cursor, so nothing is applied.
    expect(await intake.applyRunnerMirror(runner(), { hostId: 'runner-1', items: [row(2, 's1', 1, 'draft')] })).toEqual({ lastSeq: 3 })
    expect(await transcriptRows('s1')).toEqual([{ position: 0, content: 'hello', runner: 'runner-1' }, { position: 1, content: 'final', runner: 'runner-1' }])
  })

  test('truncateFrom drops the rows past the transcript\'s new end', async () => {
    await intake.applyRunnerMirror(runner(), { hostId: 'runner-1', items: [row(4, 's1', 2, 'tail'), row(5, 's1', 3, 'more')] })
    expect((await transcriptRows('s1')).map((entry) => entry.position)).toEqual([0, 1, 2, 3])
    const truncate = { seq: 6, domain: 'transcripts' as const, key: 's1:truncate', payload: { sessionId: 's1', truncateFrom: 2 } }
    expect(await intake.applyRunnerMirror(runner(), { hostId: 'runner-1', items: [truncate] })).toEqual({ lastSeq: 6 })
    expect((await transcriptRows('s1')).map((entry) => entry.position)).toEqual([0, 1])
  })

  test('a malformed payload is skipped and the cursor moves past it', async () => {
    const bad = { seq: 7, domain: 'transcripts' as const, key: 'junk', payload: { sessionId: 's1', position: 'zero' } }
    expect(await intake.applyRunnerMirror(runner(), { hostId: 'runner-1', items: [bad, row(8, 's1', 2, 'after')] })).toEqual({ lastSeq: 8 })
    expect((await transcriptRows('s1')).map((entry) => entry.position)).toEqual([0, 1, 2])
  })

  test('a span and its log events upsert by id; a second delivery updates rather than duplicates', async () => {
    const span = {
      spanId: 'trace-1', traceId: 'trace-1', kind: 'turn', name: 'turn', service: 'sessions', sessionId: 's1',
      startedAt: 100, endedAt: 200, status: 'ok', attrs: { tokens: 12 },
    }
    const events = [
      { eventId: 41, traceId: 'trace-1', spanId: 'trace-1', occurredAt: 120, level: 'info', name: 'tool_started', tag: 'SessionRuntime', file: 'session-runtime.ts', attrs: { tool: 'Bash' } },
      { eventId: 42, traceId: 'trace-1', spanId: 'trace-1', occurredAt: 150, level: 'warn', name: 'tool_slow', tag: 'SessionRuntime', file: 'session-runtime.ts' },
    ]
    const item = (seq: number, status: string) => ({ seq, domain: 'insights' as const, key: 'trace-1', payload: { span: { ...span, status }, events } })
    expect(await intake.applyRunnerMirror(runner(), { hostId: 'runner-1', items: [item(9, 'ok'), item(10, 'error')] })).toEqual({ lastSeq: 10 })

    const spans = await database.getDatabase().all<{ span_id: string; status: string; duration_ms: number; attrs: string }>(sql`
      SELECT span_id, status, duration_ms, attrs FROM ${insightSchema.insightSpans} WHERE organization_id = 'org1' AND host_id = 'runner-1'
    `)
    expect(spans).toEqual([{ span_id: 'trace-1', status: 'error', duration_ms: 100, attrs: '{"tokens":12}' }])
    const logEvents = await database.getDatabase().all<{ event_id: number; level: string }>(sql`
      SELECT event_id, level FROM ${insightSchema.insightLogEvents} WHERE organization_id = 'org1' AND host_id = 'runner-1' ORDER BY event_id
    `)
    expect(logEvents).toEqual([{ event_id: 41, level: 'info' }, { event_id: 42, level: 'warn' }])
  })

  test('another runner\'s stream has its own cursor and its rows name that runner', async () => {
    expect(await intake.applyRunnerMirror(runner('runner-2'), { hostId: 'runner-2', items: [row(1, 's2', 0, 'from two')] })).toEqual({ lastSeq: 1 })
    expect(await transcriptRows('s2')).toEqual([{ position: 0, content: 'from two', runner: 'runner-2' }])
  })
})

describe('cloud history reads', () => {
  test('the whole transcript and its tail', async () => {
    const items = [0, 1, 2, 3, 4].map((position) => row(20 + position, 'paged', position, `m${position}`))
    await intake.applyRunnerMirror(runner(), { hostId: 'runner-1', items })

    expect((await reads.readTranscript('org1', 'paged')).map((entry) => entry.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    expect((await reads.readTranscript('org1', 'paged', 2)).map((entry) => entry.content)).toEqual(['m3', 'm4'])
  })

  test('pages hold whole user turns, however many rows each turn has', async () => {
    // WHY: a page counted in rows splits turns and makes the first paint's
    // size depend on how many tools a turn ran.
    const roles = ['user', 'assistant', 'user', 'assistant', 'assistant', 'user', 'assistant']
    const items = roles.map((role, position) => row(40 + position, 'turns', position, `t${position}`, role))
    await intake.applyRunnerMirror(runner(), { hostId: 'runner-1', items })

    const newest = await reads.readTranscriptPage('org1', 'turns', 1)
    expect(newest.messages.map((entry) => entry.content)).toEqual(['t5', 't6'])
    expect(newest.before).toBe('5')
    const older = await reads.readTranscriptPage('org1', 'turns', 2, newest.before!)
    expect(older.messages.map((entry) => entry.content)).toEqual(['t0', 't1', 't2', 't3', 't4'])
    expect(older.before).toBeNull()
  })

  test('another organization sees nothing of it', async () => {
    expect(await reads.readTranscript('org2', 'paged')).toEqual([])
    expect(await reads.readTranscriptPage('org2', 'paged', 10)).toEqual({ messages: [], before: null })
  })
})
