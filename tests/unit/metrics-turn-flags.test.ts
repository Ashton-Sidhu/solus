import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

type DbModule = typeof import('@solus/server/db')
type TurnFlagsModule = typeof import('@solus/server/data/insights/turn-flags')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let db: DbModule
let turnFlags: TurnFlagsModule

/** Two people on one host, by the user key `ownerKeyOf` gives them. */
const alice = 'account:alice'
const bob = 'account:bob'

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
// one per turn per person, and a second mark replaces the first without losing
// when the turn was first marked. It is the marker's alone (plans/029 P8): a
// shared host never shows one member's judgement to another.
describe.serial('turn flags', () => {
  test('marking a turn lists it', () => {
    const list = turnFlags.setTurnFlag(alice, { traceId: 'tr_1', kind: 'too_slow', note: 'four minutes on a lookup' })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ traceId: 'tr_1', kind: 'too_slow', note: 'four minutes on a lookup' })
  })

  test('a second mark replaces the first and keeps its creation time', () => {
    const before = turnFlags.listTurnFlags(alice)[0]
    const list = turnFlags.setTurnFlag(alice, { traceId: 'tr_1', kind: 'good', note: '' })
    expect(list).toHaveLength(1)
    expect(list[0].kind).toBe('good')
    expect(list[0].createdAt).toBe(before.createdAt)
  })

  test('a kind the contract does not name is refused rather than stored', () => {
    // SAFETY: the test passes a value outside the union on purpose.
    const kind = 'meh' as 'good'
    expect(() => turnFlags.setTurnFlag(alice, { traceId: 'tr_2', kind, note: '' })).toThrow()
  })

  test('a flag belongs to the person who made it: another person neither sees it nor clears it', () => {
    // WHY: a shared host holds every member's flags in one table. Bob marking
    // the same turn is his own judgement beside Alice's, not a replacement of
    // hers, and clearing his leaves hers.
    turnFlags.setTurnFlag(bob, { traceId: 'tr_1', kind: 'bad_answer', note: 'wrong file' })
    expect(turnFlags.listTurnFlags(alice).map((flag) => [flag.traceId, flag.kind])).toEqual([['tr_1', 'good']])
    expect(turnFlags.listTurnFlags(bob).map((flag) => [flag.traceId, flag.kind])).toEqual([['tr_1', 'bad_answer']])
    expect(turnFlags.clearTurnFlag(bob, 'tr_1')).toHaveLength(0)
    expect(turnFlags.listTurnFlags(alice)).toHaveLength(1)
  })

  test('unmarking is idempotent', () => {
    expect(turnFlags.clearTurnFlag(alice, 'tr_1')).toHaveLength(0)
    expect(turnFlags.clearTurnFlag(alice, 'tr_1')).toHaveLength(0)
  })
})
