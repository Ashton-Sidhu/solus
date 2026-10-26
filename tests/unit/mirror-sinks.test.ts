import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'
import { HISTORY_PAGE_ROWS } from '@solus/contracts/session-history'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/cloud-service-model.md §6: a host's mirrored items land on the
// Solus API keyed by what they are about — a transcript row by its position, a
// span by its id — so a redelivery writes the same row again, and the host's
// delivery cursor skips what was already applied. The API then answers a
// member's history reads from that copy.

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

type DeliverItem = import('@solus/server/sync/runner-protocol').RunnerDeliverItem
const deliver = async (from: ReturnType<typeof runner>, request: { hostId: string; items: DeliverItem[] }) => (await intake.applyRunnerDelivery(from, request)).lastSeq
const runner = (hostId = 'runner-1') => principalModule.runnerPrincipalFor({ hostId, organizationId: 'org1', ownerUserId: 'alice', expiresAt: Date.now() + 600_000 })

function message(content: string, role = 'assistant') {
  return { role, content, timestamp: 1 }
}

function row(seq: number, sessionId: string, position: number, content: string, role?: string) {
  return { seq, kind: 'transcript' as const, payload: { sessionId, position, message: message(content, role) } }
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
    expect(await deliver(runner(), batch)).toBe(3)
    expect(await transcriptRows('s1')).toEqual([{ position: 0, content: 'hello', runner: 'runner-1' }, { position: 1, content: 'final', runner: 'runner-1' }])

    // The same batch again: every seq is at or below the cursor, so nothing is applied.
    expect(await deliver(runner(), { hostId: 'runner-1', items: [row(2, 's1', 1, 'draft')] })).toBe(3)
    expect(await transcriptRows('s1')).toEqual([{ position: 0, content: 'hello', runner: 'runner-1' }, { position: 1, content: 'final', runner: 'runner-1' }])
  })

  test('truncateFrom drops the rows past the transcript\'s new end', async () => {
    await deliver(runner(), { hostId: 'runner-1', items: [row(4, 's1', 2, 'tail'), row(5, 's1', 3, 'more')] })
    expect((await transcriptRows('s1')).map((entry) => entry.position)).toEqual([0, 1, 2, 3])
    const truncate = { seq: 6, kind: 'transcript' as const, payload: { sessionId: 's1', truncateFrom: 2 } }
    expect(await deliver(runner(), { hostId: 'runner-1', items: [truncate] })).toBe(6)
    expect((await transcriptRows('s1')).map((entry) => entry.position)).toEqual([0, 1])
  })

  test('a malformed payload is skipped and the cursor moves past it', async () => {
    const bad = { seq: 7, kind: 'transcript' as const, payload: { sessionId: 's1', position: 'zero' } }
    expect(await deliver(runner(), { hostId: 'runner-1', items: [bad, row(8, 's1', 2, 'after')] })).toBe(8)
    expect((await transcriptRows('s1')).map((entry) => entry.position)).toEqual([0, 1, 2])
  })

  test('a turn\'s spans and their log events land in one item and upsert by id; a second delivery updates rather than duplicates', async () => {
    const span = {
      spanId: 'trace-1', traceId: 'trace-1', kind: 'turn', name: 'turn', service: 'sessions', sessionId: 's1',
      startedAt: 100, endedAt: 200, status: 'ok', attrs: { tokens: 12 },
    }
    const events = [
      { eventId: 41, traceId: 'trace-1', spanId: 'trace-1', occurredAt: 120, level: 'info', name: 'tool_started', tag: 'SessionRuntime', file: 'session-runtime.ts', attrs: { tool: 'Bash' } },
      { eventId: 42, traceId: 'trace-1', spanId: 'trace-1', occurredAt: 150, level: 'warn', name: 'tool_slow', tag: 'SessionRuntime', file: 'session-runtime.ts' },
    ]
    const child = { ...span, spanId: 'span-2', parentSpanId: 'trace-1', name: 'tool', endedAt: 150 }
    const item = (seq: number, status: string) => ({ seq, kind: 'insights' as const, payload: { spans: [{ span: child, events: [] }, { span: { ...span, status }, events }] } })
    expect(await deliver(runner(), { hostId: 'runner-1', items: [item(9, 'ok'), item(10, 'error')] })).toBe(10)

    const spans = await database.getDatabase().all<{ span_id: string; status: string; duration_ms: number; attrs: string }>(sql`
      SELECT span_id, status, duration_ms, attrs FROM ${insightSchema.insightSpans} WHERE organization_id = 'org1' AND host_id = 'runner-1' ORDER BY span_id
    `)
    expect(spans).toEqual([{ span_id: 'span-2', status: 'ok', duration_ms: 50, attrs: '{"tokens":12}' }, { span_id: 'trace-1', status: 'error', duration_ms: 100, attrs: '{"tokens":12}' }])
    const logEvents = await database.getDatabase().all<{ event_id: number; level: string }>(sql`
      SELECT event_id, level FROM ${insightSchema.insightLogEvents} WHERE organization_id = 'org1' AND host_id = 'runner-1' ORDER BY event_id
    `)
    expect(logEvents).toEqual([{ event_id: 41, level: 'info' }, { event_id: 42, level: 'warn' }])
  })

  test('another runner\'s stream has its own cursor and its rows name that runner', async () => {
    expect(await deliver(runner('runner-2'), { hostId: 'runner-2', items: [row(1, 's2', 0, 'from two')] })).toBe(1)
    expect(await transcriptRows('s2')).toEqual([{ position: 0, content: 'from two', runner: 'runner-2' }])
  })
})

describe('cloud history reads', () => {
  test('the whole transcript and its tail', async () => {
    const items = [0, 1, 2, 3, 4].map((position) => row(20 + position, 'paged', position, `m${position}`))
    await deliver(runner(), { hostId: 'runner-1', items })

    expect((await reads.readTranscript('org1', 'paged')).map((entry) => entry.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    expect((await reads.readTranscript('org1', 'paged', 2)).map((entry) => entry.content)).toEqual(['m3', 'm4'])
  })

  test('pages hold whole user turns, however many rows each turn has', async () => {
    // WHY: a page counted in rows splits turns and makes the first paint's
    // size depend on how many tools a turn ran.
    const roles = ['user', 'assistant', 'user', 'assistant', 'assistant', 'user', 'assistant']
    const items = roles.map((role, position) => row(40 + position, 'turns', position, `t${position}`, role))
    await deliver(runner(), { hostId: 'runner-1', items })

    const newest = await reads.readTranscriptPage('org1', 'turns', 1)
    expect(newest.messages.map((entry) => entry.content)).toEqual(['t5', 't6'])
    expect(newest.before).toBe('5')
    const older = await reads.readTranscriptPage('org1', 'turns', 2, newest.before!)
    expect(older.messages.map((entry) => entry.content)).toEqual(['t0', 't1', 't2', 't3', 't4'])
    expect(older.before).toBeNull()
  })

  test('a turn longer than the row budget pages inside the turn, and the pages give back every row', async () => {
    // WHY: a page counted only in user turns loads one long agent turn whole
    // and can freeze the client when the session opens.
    const items = Array.from({ length: 902 }, (_, position) => row(100 + position, 'long', position, `r${position}`, position === 0 || position === 2 ? 'user' : 'assistant'))
    await deliver(runner(), { hostId: 'runner-1', items })
    const pages = [await reads.readTranscriptPage('org1', 'long', 10)]
    while (pages.at(-1)!.before) pages.push(await reads.readTranscriptPage('org1', 'long', 20, pages.at(-1)!.before!))
    expect(pages[0].messages).toHaveLength(HISTORY_PAGE_ROWS)
    expect(pages[0].messages[0].role).toBe('assistant')
    expect(pages.reverse().flatMap((page) => page.messages.map((entry) => entry.content))).toEqual(items.map((_, position) => `r${position}`))
  })

  test('another organization sees nothing of it', async () => {
    expect(await reads.readTranscript('org2', 'paged')).toEqual([])
    expect(await reads.readTranscriptPage('org2', 'paged', 10)).toEqual({ messages: [], before: null })
  })
})
