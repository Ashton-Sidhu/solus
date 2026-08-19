import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type IndexerModule = typeof import('@solus/server/db/session-indexer')
type ReadTailRecordBatches = IndexerModule['readTailRecordBatches']
let readTailRecordBatches: ReadTailRecordBatches
let maxIndexedLineBytes: number

const tempDirs: string[] = []

beforeAll(async () => {
  const indexer = await import('@solus/server/db/session-indexer')
  readTailRecordBatches = indexer.readTailRecordBatches
  maxIndexedLineBytes = indexer.MAX_INDEXED_SESSION_LINE_BYTES
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function messageLine(index: number): string {
  return JSON.stringify({
    type: index % 2 === 0 ? 'user' : 'assistant',
    uuid: `message-${index}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    message: {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `bounded message ${index}`,
    },
  })
}

describe('session index streaming reader', () => {
  test('bounds parsed records to database-sized batches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-session-reader-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'session.jsonl')
    const contents = Array.from({ length: 601 }, (_, index) => messageLine(index)).join('\n') + '\n'
    writeFileSync(filePath, contents)

    const sizes: number[] = []
    let records = 0
    for await (const batch of readTailRecordBatches(filePath, 0, Buffer.byteLength(contents))) {
      sizes.push(batch.length)
      records += batch.length
    }

    expect(sizes).toEqual([300, 300, 1])
    expect(records).toBe(601)
  })

  test('leaves an incomplete final record for the next sweep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-session-reader-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'session.jsonl')
    const complete = `${messageLine(0)}\n`
    const incomplete = messageLine(1).slice(0, -4)
    const contents = complete + incomplete
    writeFileSync(filePath, contents)

    const batches = []
    for await (const batch of readTailRecordBatches(filePath, 0, Buffer.byteLength(contents))) {
      batches.push(...batch)
    }

    expect(batches).toHaveLength(1)
    expect(batches[0].endOffset).toBe(Buffer.byteLength(complete))
    expect(batches[0].message?.text).toBe('bounded message 0')
  })

  test('skips a giant line without losing the following searchable record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-session-reader-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'session.jsonl')
    const oversized = `${'x'.repeat(maxIndexedLineBytes + 1)}\n`
    const next = `${messageLine(2)}\n`
    const contents = oversized + next
    writeFileSync(filePath, contents)

    const records = []
    for await (const batch of readTailRecordBatches(filePath, 0, Buffer.byteLength(contents))) {
      records.push(...batch)
    }

    expect(records).toHaveLength(2)
    expect(records[0].message).toBeNull()
    expect(records[1].message?.text).toBe('bounded message 2')
  })
})
