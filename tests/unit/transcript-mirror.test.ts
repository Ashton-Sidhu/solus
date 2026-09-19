import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §6: the transcript producer reads a
// session's history once its events settle, and appends only the rows whose
// content changed since the last pass — plus a truncate when the transcript
// got shorter. A host that mirrors nowhere appends nothing and marks nothing.

let TranscriptMirrorModule: typeof import('@solus/server/mirror/transcript-mirror')
let mirrorLog: typeof import('@solus/server/mirror/mirror-log')
let ownership: typeof import('@solus/server/outbox/cloud-ownership')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-transcript-mirror-'))
  process.env.SOLUS_DATA_DIR = dataDir
  TranscriptMirrorModule = await import('@solus/server/mirror/transcript-mirror')
  mirrorLog = await import('@solus/server/mirror/mirror-log')
  ownership = await import('@solus/server/outbox/cloud-ownership')
  dbModule = await import('@solus/server/db')
})

afterAll(async () => {
  ownership.setCloudOwnedOrganization(null)
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

function rememberedPositions(sessionId: string): number[] {
  const rows = dbModule.getDb().prepare('SELECT position FROM transcript_mirror_rows WHERE session_id = ? ORDER BY position').all(sessionId)
  return rows.map((row) => (row as { position: number }).position)
}

function drainLog() {
  const items = mirrorLog.listMirror(100)
  if (items.length) mirrorLog.ackMirrorThrough(items[items.length - 1].seq)
  return items.map((item) => ({ domain: item.domain, key: item.key, payload: item.payload }))
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
  test('a host that mirrors nowhere reads nothing and remembers nothing', async () => {
    ownership.setCloudOwnedOrganization(null)
    transcripts.set('quiet', [message('a')])
    const producer = mirror()
    producer.touch('quiet', { provider: 'claude-code' })
    await producer.flushNow('quiet')
    expect(loads).toEqual([])
    expect(drainLog()).toEqual([])
    expect(rememberedPositions('quiet')).toEqual([])
    producer.dispose()
  })

  test('the first pass appends every row; the next appends only what changed; a shorter transcript appends a truncate', async () => {
    ownership.setCloudOwnedOrganization('org1')
    const producer = mirror()
    transcripts.set('s1', [message('a'), message('b'), message('c')])
    producer.touch('s1', { provider: 'claude-code', projectPath: '-repo' })
    await producer.flushNow('s1')
    expect(drainLog()).toEqual([
      { domain: 'transcripts', key: 's1:0', payload: { sessionId: 's1', position: 0, message: message('a') } },
      { domain: 'transcripts', key: 's1:1', payload: { sessionId: 's1', position: 1, message: message('b') } },
      { domain: 'transcripts', key: 's1:2', payload: { sessionId: 's1', position: 2, message: message('c') } },
    ])
    expect(rememberedPositions('s1')).toEqual([0, 1, 2])

    // Nothing changed: nothing is appended.
    producer.touch('s1', { provider: 'claude-code' })
    await producer.flushNow('s1')
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

  test('a flush with nothing pending reads nothing; a disposed mirror ignores a touch', async () => {
    ownership.setCloudOwnedOrganization('org1')
    const producer = mirror()
    transcripts.set('s2', [message('x')])
    const loadsBefore = loads.length
    await producer.flushNow('s2')
    producer.dispose()
    producer.touch('s2', { provider: 'codex' })
    await producer.flushNow('s2')
    expect(loads.length).toBe(loadsBefore)
    expect(drainLog()).toEqual([])
  })
})
