import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { TurnLedger } from '@solus/server/sessions/turn-ledger'

// Step 2 plan §3.4: every turn records who asked, whose seat ran it, and when it
// settled, so a seat's usage can be attributed and billing can read it later.

describe('TurnLedger', () => {
  test('a turn is running from dispatch and settles exactly once', () => {
    const ledger = new TurnLedger(new Database(':memory:') as unknown as DatabaseSync)
    ledger.start({ turnId: 't1', promptId: 'p1', sessionId: 's1', actor: { userId: 'guest:g1', seatUserId: 'bob' }, provider: 'claude-code', startedAt: 10 })
    expect(ledger.forSession('s1')).toMatchObject([{ turn_id: 't1', user_id: 'guest:g1', seat_user_id: 'bob', provider: 'claude-code', state: 'running', started_at: 10, settled_at: null }])
    ledger.settle('t1', 'completed', 20)
    ledger.settle('t1', 'failed', 30)
    expect(ledger.forSession('s1')[0]).toMatchObject({ state: 'completed', settled_at: 20 })
  })

  test('newest first, and a repeated start of the same turn id changes nothing', () => {
    const ledger = new TurnLedger(new Database(':memory:') as unknown as DatabaseSync)
    const actor = { userId: 'bob', seatUserId: 'bob' }
    ledger.start({ turnId: 't1', promptId: 'p1', sessionId: 's1', actor, provider: 'codex', startedAt: 1 })
    ledger.start({ turnId: 't2', promptId: 'p2', sessionId: 's1', actor, provider: 'codex', startedAt: 2 })
    ledger.start({ turnId: 't1', promptId: 'p9', sessionId: 's1', actor, provider: 'codex', startedAt: 3 })
    expect(ledger.forSession('s1').map((turn) => [turn.turn_id, turn.prompt_id])).toEqual([['t2', 'p2'], ['t1', 'p1']])
  })
})
