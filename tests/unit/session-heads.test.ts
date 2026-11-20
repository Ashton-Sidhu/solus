import { describe, expect, test } from 'bun:test'
import {
  afterTurnSettled,
  listedSessionHost,
  newestSessionHost,
  sessionHostTurnOf,
  sessionSyncSource,
  withSessionHostTurn,
  type SessionHostTurn,
} from '@solus/client-core/session-heads'

// Which host has the newest turn of a portable session
// (docs/plans/portable-sessions.md §7.1, §9). Desktop, web, and mobile all
// decide with these rules, so a prompt and a row agree on every client.

const turn = (serverId: string, syncedTurn: number, head: string | null = `head-${serverId}-${syncedTurn}`): SessionHostTurn => ({ serverId, head, syncedTurn })

describe('the facts one host answers', () => {
  test('a host with no session repository count gives no fact', () => {
    // WHY: an older host or a Solus API reports no count. Reading that as zero
    // turns would make every other host look newer and start needless syncs.
    expect(sessionHostTurnOf('a', { head: null })).toBeNull()
    expect(sessionHostTurnOf('a', null)).toBeNull()
    expect(sessionHostTurnOf('a', { head: 'h1', syncedTurn: 3 })).toEqual({ serverId: 'a', head: 'h1', syncedTurn: 3 })
  })

  test('an equal answer keeps the same array, a new one replaces only its host', () => {
    // WHY: the facts live in reactive state; a read that changes nothing must
    // not wake every row and composer that reads them.
    const turns = [turn('a', 2), turn('b', 1)]
    expect(withSessionHostTurn(turns, turn('a', 2))).toBe(turns)
    expect(withSessionHostTurn(turns, turn('a', 3))).toEqual([turn('a', 3), turn('b', 1)])
    expect(withSessionHostTurn(turns, turn('c', 1))).toHaveLength(3)
  })
})

describe('the host that has the newest turn', () => {
  test('the most turns wins; a tie goes to the run host', () => {
    // WHY: a tie means both copies are equal, so the run host needs no sync.
    expect(newestSessionHost([turn('a', 3), turn('b', 2)])?.serverId).toBe('a')
    expect(newestSessionHost([turn('a', 3), turn('b', 3)], 'b')?.serverId).toBe('b')
    expect(newestSessionHost([turn('a', 3), turn('b', 3)])?.serverId).toBe('a')
    expect(newestSessionHost([turn('a', 0)])).toBeNull()
  })

  test('a turn this client saw end makes that host the newest before its count is read', () => {
    // WHY: the host writes its turn commit after the turn, so its count is old
    // for a while. Without this, a pick of another host right after a turn
    // would sync from a host that no longer has the newest turn.
    const turns = afterTurnSettled([turn('a', 3), turn('b', 3)], 'b')
    expect(newestSessionHost(turns, 'a')?.serverId).toBe('b')
    expect(turns.find((entry) => entry.serverId === 'b')?.syncedTurn).toBe(4)
  })
})

describe('what a prompt to the run host carries', () => {
  test('nothing when the run host has the newest turn', () => {
    // WHY: a head that is only stale makes the host sync for nothing (§7.1:
    // a turn start on a current host makes no network request).
    expect(sessionSyncSource([turn('a', 3), turn('b', 2)], 'a')).toBeNull()
    expect(sessionSyncSource([], 'a')).toBeNull()
  })

  test('the newest head and its host when another host is ahead', () => {
    expect(sessionSyncSource([turn('a', 3), turn('b', 2)], 'b')).toEqual({ knownHead: 'head-a-3', sourceServerId: 'a' })
    // A run host that never ran the session syncs from the host that did.
    expect(sessionSyncSource([turn('a', 3)], 'b')).toEqual({ knownHead: 'head-a-3', sourceServerId: 'a' })
  })

  test('nothing when the run host already has that head', () => {
    // WHY: a count read before the last sync can lag; equal heads are current.
    expect(sessionSyncSource([turn('a', 3, 'h3'), turn('b', 2, 'h3')], 'b')).toBeNull()
  })
})

describe('which list shows a session that two hosts list', () => {
  test('the host with the higher syncedTurn', () => {
    // WHY: plan §9. After a run host change the same session id is on two
    // hosts; the list shows it once, from the copy with the newest turn.
    expect(listedSessionHost(['a', 'b'], [turn('a', 2), turn('b', 5)], 'a')).toBe('b')
  })

  test('with no difference the row stays where it is', () => {
    // WHY: a list read must not move a row between hosts for no reason.
    expect(listedSessionHost(['a', 'b'], [], 'b')).toBe('b')
    expect(listedSessionHost(['a', 'b'], [turn('a', 2), turn('b', 2)], 'b')).toBe('b')
    expect(listedSessionHost(['a', 'b'], [], null)).toBe('a')
  })
})
