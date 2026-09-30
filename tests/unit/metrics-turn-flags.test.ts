import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type TurnFlagsModule = typeof import('@solus/server/data/insights/turn-flags')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let db: DbModule
let turnFlags: TurnFlagsModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-turn-flags-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  turnFlags = await import('@solus/server/data/insights/turn-flags')
  db.closeDb()
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

// A person's mark on a turn is judgement, not telemetry: it lives in solus.db,
// one per turn, and a second mark replaces the first without losing when the
// turn was first marked.
describe.serial('turn flags', () => {
  test('marking a turn lists it', () => {
    const list = turnFlags.setTurnFlag({ traceId: 'tr_1', kind: 'too_slow', note: 'four minutes on a lookup' })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ traceId: 'tr_1', kind: 'too_slow', note: 'four minutes on a lookup' })
  })

  test('a second mark replaces the first and keeps its creation time', () => {
    const before = turnFlags.listTurnFlags()[0]
    const list = turnFlags.setTurnFlag({ traceId: 'tr_1', kind: 'good', note: '' })
    expect(list).toHaveLength(1)
    expect(list[0].kind).toBe('good')
    expect(list[0].createdAt).toBe(before.createdAt)
  })

  test('a kind the contract does not name is refused rather than stored', () => {
    // SAFETY: the test passes a value outside the union on purpose.
    const kind = 'meh' as 'good'
    expect(() => turnFlags.setTurnFlag({ traceId: 'tr_2', kind, note: '' })).toThrow()
  })

  test('unmarking is idempotent', () => {
    expect(turnFlags.clearTurnFlag('tr_1')).toHaveLength(0)
    expect(turnFlags.clearTurnFlag('tr_1')).toHaveLength(0)
  })
})
