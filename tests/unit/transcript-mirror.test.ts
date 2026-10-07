import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { SessionLoadMessage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/organization-scope.md §4, §6, §7: the transcript producer reads a
// session's history once its events settle, and appends only the rows whose
// content changed since the last pass — plus a truncate when the transcript
// got shorter — to the organization the session's record names. Only a
// `published` record of a real organization ships its transcript: a Local or
// merely organization-attributed session reads nothing and marks nothing.

let TranscriptMirrorModule: typeof import('@solus/server/sync/mirror/transcript-mirror')
let mirrorLog: typeof import('@solus/server/sync/mirror/mirror-log')
let records: typeof import('@solus/server/data/sessions/session-records')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-transcript-mirror-'))
  process.env.SOLUS_DATA_DIR = dataDir
  TranscriptMirrorModule = await import('@solus/server/sync/mirror/transcript-mirror')
  mirrorLog = await import('@solus/server/sync/mirror/mirror-log')
  records = await import('@solus/server/data/sessions/session-records')
  dbModule = await import('@solus/server/db')
})

afterAll(async () => {
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const transcripts = new Map<string, SessionLoadMessage[]>()
const loads: string[] = []

function message(content: string): SessionLoadMessage {
  return { role: 'assistant', content, timestamp: 1 }
}

/** A person's prompt with a screenshot, and the tool call and result the agent made on it. */
function turnWithTool(): SessionLoadMessage[] {
  return [
    { role: 'user', content: 'look at this', imageAttachments: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }], timestamp: 1 },
    { role: 'tool', content: 'the whole file', toolName: 'Read', toolId: 't1', toolInput: '{"path":"secret.env"}', toolStatus: 'completed', timestamp: 2 },
    { role: 'tool_result', content: 'API_KEY=hunter2', toolResultForId: 't1', toolResultIsError: true, timestamp: 3 },
  ]
}

function rememberedPositions(sessionId: string): number[] {
  const rows = dbModule.getDb().prepare('SELECT position FROM transcript_mirror_rows WHERE session_id = ? ORDER BY position').all(sessionId)
  return rows.map((row) => (row as { position: number }).position)
}

/** The rows queued for an organization. These sessions have no owner, so the person who linked the host carries them. */
function drainLog(organizationId = 'org1') {
  const destination = { organizationId, actorUserId: '' }
  const items = mirrorLog.listMirror(destination, 100)
  if (items.length) mirrorLog.ackMirrorThrough(destination, items[items.length - 1].seq)
  return items.map((item) => ({ domain: item.domain, key: item.key, payload: item.payload }))
}

/** A session this host recorded, assigned to an organization and published there when asked. */
async function session(sessionId: string, state: 'local' | 'assigned' | 'published', organizationId = 'org1'): Promise<void> {
  await records.upsertOwnSessionRecord({ sessionId, provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
  if (state === 'local') return
  await records.assignSessionOrganization(sessionId, organizationId)
  if (state === 'published') await records.markSessionPublished(sessionId)
}

function mirror() {
  return new TranscriptMirrorModule.TranscriptMirror({
    loadSession: async (_provider, sessionId) => {
      loads.push(sessionId)
      return transcripts.get(sessionId) ?? []
    },
    debounceMs: 5,
  })
}

describe('transcript mirror', () => {
  test('a Local session, and one assigned to an organization but not published, read nothing and remember nothing', async () => {
    // WHY: sending Insights or picking an organization in the window publishes no
    // transcript (§3). Only a publication does, and it says so on the record.
    await session('quiet', 'local')
    await session('attributed', 'assigned')
    transcripts.set('quiet', [message('a')])
    transcripts.set('attributed', [message('a')])
    expect(await TranscriptMirrorModule.transcriptDestination('quiet')).toBeNull()
    expect(await TranscriptMirrorModule.transcriptDestination('attributed')).toBeNull()
    expect(await TranscriptMirrorModule.transcriptDestination('never-recorded')).toBeNull()
    const producer = mirror()
    producer.touch('quiet', { provider: 'claude-code' })
    producer.touch('attributed', { provider: 'claude-code' })
    expect(await producer.flushNow('quiet')).toBe(0)
    expect(await producer.flushNow('attributed')).toBe(0)
    expect(loads).toEqual([])
    expect(mirrorLog.mirrorDestinations()).toEqual([])
    expect(rememberedPositions('quiet')).toEqual([])
    expect(rememberedPositions('attributed')).toEqual([])
    producer.dispose()
  })

  test('the first pass appends every row to the record\'s organization; the next appends only what changed; a shorter transcript appends a truncate', async () => {
    await session('s1', 'published')
    expect(await TranscriptMirrorModule.transcriptDestination('s1')).toEqual({ organizationId: 'org1', actorUserId: '' })
    const producer = mirror()
    transcripts.set('s1', [message('a'), message('b'), message('c')])
    producer.touch('s1', { provider: 'claude-code', projectPath: '-repo' })
    const lastSeq = await producer.flushNow('s1')
    const first = drainLog()
    expect(first).toEqual([
      { domain: 'transcripts', key: 's1:0', payload: { sessionId: 's1', position: 0, message: message('a') } },
      { domain: 'transcripts', key: 's1:1', payload: { sessionId: 's1', position: 1, message: message('b') } },
      { domain: 'transcripts', key: 's1:2', payload: { sessionId: 's1', position: 2, message: message('c') } },
    ])
    // The flush answers the highest sequence it appended.
    expect(lastSeq).toBeGreaterThan(0)
    expect(rememberedPositions('s1')).toEqual([0, 1, 2])

    // Nothing changed: nothing is appended.
    producer.touch('s1', { provider: 'claude-code' })
    expect(await producer.flushNow('s1')).toBe(0)
    expect(drainLog()).toEqual([])

    // One row finished (a tool call got its result) and one row was added.
    transcripts.set('s1', [message('a'), message('b done'), message('c'), message('d')])
    producer.touch('s1', { provider: 'claude-code' })
    await producer.flushNow('s1')
    expect(drainLog()).toEqual([
      { domain: 'transcripts', key: 's1:1', payload: { sessionId: 's1', position: 1, message: message('b done') } },
      { domain: 'transcripts', key: 's1:3', payload: { sessionId: 's1', position: 3, message: message('d') } },
    ])
    expect(rememberedPositions('s1')).toEqual([0, 1, 2, 3])

    // The transcript shrank (a lineage change): the rows past its end go, and the hashes with them.
    transcripts.set('s1', [message('a'), message('b done')])
    producer.touch('s1', { provider: 'claude-code' })
    await producer.flushNow('s1')
    expect(drainLog()).toEqual([
      { domain: 'transcripts', key: 's1:truncate', payload: { sessionId: 's1', truncateFrom: 2 } },
    ])
    expect(rememberedPositions('s1')).toEqual([0, 1])
    producer.dispose()
  })

  test('every row of one session goes to its own organization; another organization\'s queue never sees it', async () => {
    await session('s-org2', 'published', 'org2')
    const producer = mirror()
    transcripts.set('s-org2', [message('two')])
    producer.touch('s-org2', { provider: 'codex' })
    await producer.flushNow('s-org2')
    expect(drainLog('org1')).toEqual([])
    expect(drainLog('org2')).toEqual([
      { domain: 'transcripts', key: 's-org2:0', payload: { sessionId: 's-org2', position: 0, message: message('two') } },
    ])
    producer.dispose()
  })

  test('what is mirrored is the row a client may see: tool bodies are gone, their size and error head stay, images stay', async () => {
    await session('shown', 'published')
    const producer = mirror()
    transcripts.set('shown', turnWithTool())
    producer.touch('shown', { provider: 'claude-code', projectPath: '-repo' })
    await producer.flushNow('shown')
    const rows = drainLog().map((item) => item.payload)
    const stored = JSON.stringify(rows)
    // The tool call's body (what the tool printed) never leaves the host.
    expect(stored).not.toContain('the whole file')
    expect(stored).toContain('data:image/png;base64,AAAA')
    // The tool input stays: the service serves it on demand, as a host does.
    expect(stored).toContain('secret.env')
    const messageAt = (position: number) => rows.find((payload): payload is { sessionId: string; position: number; message: WireSessionLoadMessage } => 'position' in payload && payload.position === position)?.message
    expect(messageAt(1)).toMatchObject({ role: 'tool', content: '', status: 'ok', contentBytes: 14 })
    // A failed result keeps the head a client shows on the card, and nothing more of its body.
    expect(messageAt(2)).toMatchObject({ role: 'tool_result', content: '', status: 'error', errorHead: 'API_KEY=hunter2', contentBytes: 15 })
    producer.dispose()
  })

  test('a published session\'s activity is queued once, under its session id; a Local or unpublished session\'s is not', async () => {
    // WHY: plans/012 §5, stage 8. The Solus API merges a session's activity into the
    // history it serves, so the rows must travel with the transcript, once each, and
    // under the session id. Only a publication sends anything.
    const { appendActivity, newActivity } = await import('@solus/server/data/activity/activity')
    const alice = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'alice' }, displayName: 'Alice' } }
    await session('act-pub', 'published')
    await session('act-local', 'local')
    await session('act-attributed', 'assigned')
    for (const id of ['act-pub', 'act-local', 'act-attributed']) transcripts.set(id, [message('a')])
    // Recorded before the session was published (as Local).
    const stopped = newActivity({ kind: 'session', id: 'act-pub' }, alice, { kind: 'stopped' }, 1_500)
    const renamed = newActivity({ kind: 'session', id: 'act-pub' }, alice, { kind: 'renamed', title: 'Spec' }, 2_500)
    await appendActivity('local', stopped)
    await appendActivity('org1', renamed)
    await appendActivity('local', newActivity({ kind: 'session', id: 'act-local' }, alice, { kind: 'stopped' }, 1_500))
    await appendActivity('org1', newActivity({ kind: 'session', id: 'act-attributed' }, alice, { kind: 'stopped' }, 1_500))
    const producer = new TranscriptMirrorModule.TranscriptMirror({
      loadSession: async (_provider, sessionId) => transcripts.get(sessionId) ?? [],
      debounceMs: 5,
    })
    const flush = async (sessionId: string) => {
      producer.touch(sessionId, { provider: 'claude-code' })
      return producer.flushNow(sessionId)
    }
    for (const id of ['act-local', 'act-attributed']) expect(await flush(id)).toBe(0)
    expect(mirrorLog.mirrorDestinations()).toEqual([])

    const lastSeq = await flush('act-pub')
    const activityItems = drainLog().filter((item) => item.domain === 'activity')
    expect(activityItems).toEqual([
      { domain: 'activity', key: stopped.id, payload: { activity: { ...stopped, subject: { kind: 'session', id: 'act-pub' } } } },
      { domain: 'activity', key: renamed.id, payload: { activity: { ...renamed, subject: { kind: 'session', id: 'act-pub' } } } },
    ])

    // Nothing new: nothing is sent again. A new activity, while the transcript stays, is sent alone.
    expect(await flush('act-pub')).toBe(0)
    expect(drainLog()).toEqual([])
    const answered = newActivity({ kind: 'session', id: 'act-pub' }, alice, { kind: 'question_answered', questionId: 'q1' }, 3_500)
    await appendActivity('org1', answered)
    await flush('act-pub')
    expect(drainLog()).toEqual([
      { domain: 'activity', key: answered.id, payload: { activity: { ...answered, subject: { kind: 'session', id: 'act-pub' } } } },
    ])
    producer.dispose()
  })

  test('a flush with nothing pending reads nothing; a disposed mirror ignores a touch', async () => {
    await session('s2', 'published')
    const producer = mirror()
    transcripts.set('s2', [message('x')])
    const loadsBefore = loads.length
    expect(await producer.flushNow('s2')).toBe(0)
    producer.dispose()
    producer.touch('s2', { provider: 'codex' })
    expect(await producer.flushNow('s2')).toBe(0)
    expect(loads.length).toBe(loadsBefore)
    expect(drainLog()).toEqual([])
  })
})
